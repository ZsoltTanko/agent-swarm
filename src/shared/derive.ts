import type { RunEndedEvent, RunEvent } from "./events.ts";
import type {
  AgentView,
  CoverageCell,
  PostView,
  RunMetrics,
  RunState,
  StepRecord,
  TickActivity,
} from "./runstate.ts";
import { addUsage, ZERO_USAGE } from "./types.ts";
import type { DeliverableVersion, Usage } from "./types.ts";

/** The key of a step in RunState.step_by_key: `${agent}@${tick}`. */
export function stepKey(agent: string, tick: number): string {
  return `${agent}@${tick}`;
}

/** Per-agent bookkeeping while the log is applied. */
interface AgentTally {
  view: AgentView;
  /** Ids of posts by others that have been delivered to this agent. */
  delivered: Set<number>;
  /** Undelivered posts by others created in a tick before the one being applied. */
  unreadEarlier: number;
  /** Undelivered posts by others created in the tick being applied. */
  unreadCurrent: number;
  /**
   * unreadEarlier when the agent's current step began (its model_call). Every tool call of a step was
   * written before any result came back, so a post is blind by this count, not by reads in the same step.
   */
  unreadAtStepStart: number;
  postChars: number;
}

/**
 * The world of a run as of `tick` (see RunState). One pass over the log, so it is cheap
 * enough to call on every scrub. The log must start with run_started; it may end anywhere,
 * including mid-tick while a run is live.
 */
export function deriveRunState(events: readonly RunEvent[], tick: number): RunState {
  const started = events[0];
  if (started?.type !== "run_started") {
    throw new Error("The event log must start with a run_started event.");
  }

  let latestTick = 0;
  let ended: RunEndedEvent | null = null;
  for (const event of events) {
    if (event.tick > latestTick) latestTick = event.tick;
    if (event.type === "run_ended") ended = event;
  }
  const selected = Number.isNaN(tick) ? latestTick : Math.min(Math.max(Math.floor(tick), 0), latestTick);

  const readBudget = started.config.environment.doc_read_budget;
  const tallies = new Map<string, AgentTally>();
  for (const info of [...started.agents].sort((a, b) => a.index - b.index)) {
    tallies.set(info.name, {
      view: {
        info,
        status: "awake",
        reads_left: readBudget,
        docs_opened: [],
        posts: 0,
        steps: 0,
        ticks_asleep: 0,
        first_post_tick: null,
        done_tick: null,
        done_note: null,
        stopped_reason: null,
        last_seen_deliverable: 0,
        unread_posts: 0,
        usage: { ...ZERO_USAGE },
      },
      delivered: new Set(),
      unreadEarlier: 0,
      unreadCurrent: 0,
      unreadAtStepStart: 0,
      postChars: 0,
    });
  }

  const activity: TickActivity[] = Array.from({ length: latestTick }, (_, i) => ({
    tick: i + 1,
    active: 0,
    calls: 0,
    posts: 0,
    doc_opens: 0,
    writes: 0,
    sleeps: 0,
    cost_usd: 0,
  }));

  const steps: StepRecord[] = [];
  const stepByKey: Record<string, StepRecord> = {};
  const posts: PostView[] = [];
  const postById = new Map<number, PostView>();
  const deliverable: DeliverableVersion[] = [];
  const coverage: CoverageCell[] = [];
  const openersByDoc = new Map<string, number>();
  let usage: Usage = { ...ZERO_USAGE };
  let blindPosts = 0;
  let appliedTick = 0;
  let order: readonly string[] = [];

  const openStep = (agent: string, stepTick: number, orderIndex: number, seq: number): StepRecord => {
    const step: StepRecord = {
      key: stepKey(agent, stepTick),
      agent,
      tick: stepTick,
      order_index: orderIndex,
      seq,
      call: null,
      tool_calls: [],
      posts_created: [],
      posts_received: [],
      docs_opened: [],
      deliverable_reads: [],
      deliverable_writes: [],
      slept: false,
      sleep_reason: null,
      done: false,
      stopped: null,
      truncated: false,
      errors: 0,
    };
    steps.push(step);
    stepByKey[step.key] = step;
    const tally = tallies.get(agent);
    if (tally) tally.view.steps++;
    return step;
  };
  const stepAt = (agent: string, stepTick: number): StepRecord | undefined =>
    stepByKey[stepKey(agent, stepTick)];
  const seeDeliverable = (agent: string, version: number): void => {
    const tally = tallies.get(agent);
    if (tally) tally.view.last_seen_deliverable = Math.max(tally.view.last_seen_deliverable, version);
  };

  for (const event of events) {
    const bucket = activity[event.tick - 1];
    if (bucket) countActivity(bucket, event);
    if (event.tick > selected) continue;

    if (event.tick !== appliedTick) {
      for (const tally of tallies.values()) {
        tally.unreadEarlier += tally.unreadCurrent;
        tally.unreadCurrent = 0;
      }
      appliedTick = event.tick;
      order = [];
    }

    switch (event.type) {
      case "tick_started":
        order = event.order;
        for (const name of event.asleep) {
          const tally = tallies.get(name);
          if (tally) tally.view.ticks_asleep++;
        }
        break;

      case "model_call": {
        const step =
          stepAt(event.agent, event.tick) ?? openStep(event.agent, event.tick, event.order_index, event.seq);
        step.call = event;
        step.truncated = event.truncated;
        usage = addUsage(usage, event.usage);
        const tally = tallies.get(event.agent);
        if (tally) {
          tally.view.usage = addUsage(tally.view.usage, event.usage);
          tally.unreadAtStepStart = tally.unreadEarlier;
        }
        break;
      }

      case "agent_stopped": {
        const position = order.indexOf(event.agent);
        const step =
          stepAt(event.agent, event.tick) ??
          openStep(event.agent, event.tick, position >= 0 ? position : order.length, event.seq);
        step.stopped = event.reason;
        const tally = tallies.get(event.agent);
        if (tally) {
          tally.view.status = "stopped";
          tally.view.stopped_reason = event.reason;
        }
        break;
      }

      case "tool_call": {
        const step = stepAt(event.agent, event.tick);
        if (step) {
          step.tool_calls.push(event);
          if (event.error !== null) step.errors++;
        }
        break;
      }

      case "post_created": {
        const post: PostView = { ...event.post, received_by: [], replies: [] };
        posts.push(post);
        postById.set(post.id, post);
        if (post.reply_to !== null) postById.get(post.reply_to)?.replies.push(post.id);
        stepAt(post.author, event.tick)?.posts_created.push(post.id);

        const author = tallies.get(post.author);
        if (author) {
          if (author.unreadAtStepStart > 0) blindPosts++;
          author.view.posts++;
          author.view.first_post_tick ??= post.tick;
          author.postChars += post.text.length;
        }
        for (const [name, tally] of tallies) {
          if (name !== post.author) tally.unreadCurrent++;
        }
        break;
      }

      case "board_delivered": {
        stepAt(event.agent, event.tick)?.posts_received.push(...event.post_ids);
        const reader = tallies.get(event.agent);
        if (!reader) break;
        for (const id of event.post_ids) {
          const post = postById.get(id);
          if (!post || post.author === event.agent || reader.delivered.has(id)) continue;
          reader.delivered.add(id);
          post.received_by.push({ agent: event.agent, tick: event.tick });
          if (post.tick < appliedTick) reader.unreadEarlier--;
          else reader.unreadCurrent--;
        }
        break;
      }

      case "document_opened": {
        const opened = { doc_id: event.doc_id, first_open: event.first_open };
        stepAt(event.agent, event.tick)?.docs_opened.push(opened);
        const tally = tallies.get(event.agent);
        if (tally) tally.view.reads_left = event.reads_left;
        if (event.first_open) {
          tally?.view.docs_opened.push({ doc_id: event.doc_id, tick: event.tick });
          coverage.push({ agent: event.agent, doc_id: event.doc_id, tick: event.tick });
          openersByDoc.set(event.doc_id, (openersByDoc.get(event.doc_id) ?? 0) + 1);
        }
        break;
      }

      case "deliverable_read":
        stepAt(event.agent, event.tick)?.deliverable_reads.push(event.version);
        seeDeliverable(event.agent, event.version);
        break;

      case "deliverable_written": {
        const version = event.version;
        deliverable.push(version);
        stepAt(version.author, event.tick)?.deliverable_writes.push(version.version);
        seeDeliverable(version.author, version.version);
        break;
      }

      case "agent_slept": {
        const step = stepAt(event.agent, event.tick);
        if (step) {
          step.slept = true;
          step.sleep_reason = event.reason;
        }
        const tally = tallies.get(event.agent);
        if (tally) tally.view.status = "asleep";
        break;
      }

      case "agent_woke": {
        const tally = tallies.get(event.agent);
        if (tally) tally.view.status = "awake";
        break;
      }

      case "agent_done": {
        const step = stepAt(event.agent, event.tick);
        if (step) step.done = true;
        const tally = tallies.get(event.agent);
        if (tally) {
          tally.view.status = "done";
          tally.view.done_tick = event.tick;
          tally.view.done_note = event.note;
        }
        break;
      }

      case "run_ended":
        // Calls of an aborted tick that returned but were never applied: paid for all the same.
        for (const call of event.unapplied) {
          usage = addUsage(usage, call.usage);
          const tally = tallies.get(call.agent);
          if (tally) tally.view.usage = addUsage(tally.view.usage, call.usage);
        }
        break;

      case "run_started":
        break;
    }
  }

  steps.sort((a, b) => a.tick - b.tick || a.order_index - b.order_index);

  const agents: AgentView[] = [];
  for (const tally of tallies.values()) {
    tally.view.unread_posts = tally.unreadEarlier + tally.unreadCurrent;
    agents.push(tally.view);
  }

  return {
    run_id: started.run_id,
    started,
    ended,
    status: ended ? "ended" : "running",
    tick: selected,
    latest_tick: latestTick,
    tick_cap: started.config.run.tick_cap,
    agents,
    posts,
    steps,
    step_by_key: stepByKey,
    deliverable,
    coverage,
    activity,
    usage,
    metrics: computeMetrics({
      tallies,
      posts,
      blindPosts,
      deliverable,
      openersByDoc,
      docIds: started.task.docs.map((doc) => doc.id),
      usage,
    }),
  };
}

function countActivity(bucket: TickActivity, event: RunEvent): void {
  switch (event.type) {
    case "tick_started":
      bucket.active = event.active.length;
      break;
    case "model_call":
      bucket.calls++;
      bucket.cost_usd += event.usage.cost_usd;
      break;
    case "post_created":
      bucket.posts++;
      break;
    case "document_opened":
      if (event.first_open) bucket.doc_opens++;
      break;
    case "deliverable_written":
      bucket.writes++;
      break;
    case "agent_slept":
      bucket.sleeps++;
      break;
    case "run_ended":
      for (const call of event.unapplied) bucket.cost_usd += call.usage.cost_usd;
      break;
    default:
      break;
  }
}

function computeMetrics(input: {
  tallies: Map<string, AgentTally>;
  posts: PostView[];
  blindPosts: number;
  deliverable: DeliverableVersion[];
  openersByDoc: Map<string, number>;
  docIds: string[];
  usage: Usage;
}): RunMetrics {
  const { tallies, posts, deliverable, openersByDoc } = input;

  let duplicateOpens = 0;
  for (const openers of openersByDoc.values()) duplicateOpens += openers - 1;

  const perAgentBoard: RunMetrics["board"]["per_agent"] = {};
  const perAgentActivity: RunMetrics["activity"] = {};
  const perAgentUsage: Record<string, Usage> = {};
  for (const [name, { view, postChars }] of tallies) {
    perAgentBoard[name] = {
      posts: view.posts,
      first_post_tick: view.first_post_tick,
      mean_length: view.posts > 0 ? postChars / view.posts : 0,
    };
    perAgentActivity[name] = { steps: view.steps, ticks_asleep: view.ticks_asleep, done_tick: view.done_tick };
    perAgentUsage[name] = view.usage;
  }

  const authors: string[] = [];
  let unseenOverwrites = 0;
  for (const version of deliverable) {
    if (!authors.includes(version.author)) authors.push(version.author);
    if (!version.writer_had_seen_replaced) unseenOverwrites++;
  }

  return {
    coverage: {
      opened: openersByDoc.size,
      total: input.docIds.length,
      never_opened: input.docIds.filter((id) => !openersByDoc.has(id)),
      duplicate_opens: duplicateOpens,
    },
    board: {
      posts: posts.length,
      replies: posts.filter((post) => post.reply_to !== null).length,
      per_agent: perAgentBoard,
    },
    posting_blind: { posts: posts.length, with_unread: input.blindPosts },
    deliverable: {
      versions: deliverable.length,
      authors,
      unseen_overwrites: unseenOverwrites,
      final_length: deliverable.at(-1)?.text.length ?? 0,
    },
    activity: perAgentActivity,
    cost: { usage: input.usage, per_agent: perAgentUsage },
  };
}

export function agentByName(state: RunState, name: string): AgentView | undefined {
  return state.agents.find((agent) => agent.info.name === name);
}

/** The agent's steps up to the selected tick, in tick order. */
export function stepsForAgent(state: RunState, agent: string): StepRecord[] {
  return state.steps.filter((step) => step.agent === agent);
}

/** "$1.23" from a dollar up; two significant digits below it ("$0.031", "$0.00042"). */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd >= 0.995) return `$${usd.toFixed(2)}`;
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toPrecision(2)}`;
}

/** "950", "1.2k", "34k", "1.2M", "15M". */
export function formatTokens(tokens: number): string {
  if (tokens < 999.5) return String(Math.round(tokens));
  if (tokens < 9_950) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 999_500) return `${Math.round(tokens / 1_000)}k`;
  if (tokens < 9_950_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

/** "850ms", "12.3s", "2m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  if (ms < 999.5) return `${Math.round(ms)}ms`;
  if (ms < 59_950) return `${(ms / 1_000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
