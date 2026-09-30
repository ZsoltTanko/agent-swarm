import type { EnvironmentConfig } from "../shared/config.ts";
import type { RunEventPayload } from "../shared/events.ts";
import type { AgentStatus, DeliverableVersion, Post, ToolName } from "../shared/types.ts";
import { countOf, formatNumber } from "./tools.ts";
import type { LoadedDocument, LoadedTask } from "./types.ts";

/** What one tool call did: the text the agent sees, the error if it failed, and the domain events to log, in order. */
export interface ToolOutcome {
  result: string;
  error: string | null;
  events: RunEventPayload[];
}

interface AgentState {
  status: AgentStatus;
  /** Documents this agent has opened. */
  opened: Set<string>;
  readsLeft: number;
  /** Posts returned to this agent by read_board, plus its own posts. */
  delivered: Set<number>;
  /** Highest deliverable version this agent has read or written. */
  lastSeenDeliverable: number;
  /** Set when the agent falls asleep: posts by others newer than this wake it. */
  sleepMarker: number;
  /** The agent called wait in its current step; it falls asleep when the step ends. */
  waitRequested: boolean;
}

export interface WorldOptions {
  task: LoadedTask;
  /** Agent names, in index order. */
  agents: readonly string[];
  environment: EnvironmentConfig;
  tickCap: number;
}

/**
 * The shared world of a run: documents, board, deliverable, and each agent's view of them.
 * Applies one validated tool call at a time and reports what happened. No I/O.
 */
export class World {
  private readonly docs: LoadedDocument[];
  private readonly docsById: Map<string, LoadedDocument>;
  private readonly environment: EnvironmentConfig;
  private readonly tickCap: number;
  private readonly agents = new Map<string, AgentState>();
  private readonly postList: Post[] = [];
  private readonly versionList: DeliverableVersion[] = [];

  constructor(options: WorldOptions) {
    this.docs = options.task.docs;
    this.docsById = new Map(options.task.docs.map((doc) => [doc.meta.id, doc]));
    this.environment = options.environment;
    this.tickCap = options.tickCap;
    for (const name of options.agents) {
      this.agents.set(name, {
        status: "awake",
        opened: new Set(),
        readsLeft: options.environment.doc_read_budget,
        delivered: new Set(),
        lastSeenDeliverable: 0,
        sleepMarker: 0,
        waitRequested: false,
      });
    }
  }

  /** In id order. */
  get posts(): readonly Post[] {
    return this.postList;
  }

  /** Written versions, v1 first. The empty v0 is implicit. */
  get versions(): readonly DeliverableVersion[] {
    return this.versionList;
  }

  /** The current deliverable text ("" while it is still the empty v0). */
  get deliverableText(): string {
    return this.versionList.at(-1)?.text ?? "";
  }

  status(agent: string): AgentStatus {
    return this.state(agent).status;
  }

  readsLeft(agent: string): number {
    return this.state(agent).readsLeft;
  }

  /**
   * The highest post id this agent has been shown: by read_board, or as the id of its own post. Ids are
   * sequential, so it has also learned that every lower id exists. 0 when it has been shown none.
   */
  highestKnownPost(agent: string): number {
    let highest = 0;
    for (const id of this.state(agent).delivered) highest = Math.max(highest, id);
    return highest;
  }

  /** Posts by other agents that haven't been delivered to this agent. */
  unreadCount(agent: string): number {
    const state = this.state(agent);
    return this.postList.filter((post) => post.author !== agent && !state.delivered.has(post.id)).length;
  }

  /** "[step 9/40 · 3 unread posts · 2 document reads left]" */
  statusLine(agent: string, tick: number): string {
    const unread = countOf(this.unreadCount(agent), "unread post");
    const reads = `${countOf(this.readsLeft(agent), "document read")} left`;
    return `[step ${tick}/${this.tickCap} · ${unread} · ${reads}]`;
  }

  /**
   * Puts the agent to sleep at the end of its step: it called wait, or it made no tool calls.
   * `marker` is the highest post id the agent can know of (see the engine).
   */
  sleep(agent: string, marker: number): void {
    const state = this.state(agent);
    state.status = "asleep";
    state.sleepMarker = marker;
    state.waitRequested = false;
  }

  /** True when the agent called wait in this step and is still awake (done takes precedence). */
  waitRequested(agent: string): boolean {
    const state = this.state(agent);
    return state.waitRequested && state.status === "awake";
  }

  /** True when an asleep agent has a post by another agent newer than its sleep marker. */
  shouldWake(agent: string): boolean {
    const state = this.state(agent);
    return (
      state.status === "asleep" &&
      this.postList.some((post) => post.id > state.sleepMarker && post.author !== agent)
    );
  }

  wake(agent: string): void {
    this.state(agent).status = "awake";
  }

  stop(agent: string): void {
    this.state(agent).status = "stopped";
  }

  /** Applies one tool call whose arguments have passed parseToolArguments. */
  execute(agent: string, tick: number, tool: ToolName, args: Record<string, unknown>): ToolOutcome {
    const state = this.state(agent);
    if (state.status !== "awake") throw new Error(`${agent} is ${state.status} and can't act.`);
    switch (tool) {
      case "read_board":
        return this.readBoard(agent, state);
      case "post_message":
        return this.postMessage(agent, state, tick, args.text as string, (args.reply_to ?? null) as number | null);
      case "list_documents":
        return this.listDocuments(state);
      case "read_document":
        return this.readDocument(agent, state, args.id as string);
      case "read_deliverable":
        return this.readDeliverable(agent, state);
      case "write_deliverable":
        return this.writeDeliverable(agent, state, tick, args.text as string);
      case "wait":
        state.waitRequested = true;
        return { result: "You'll wait until another agent posts.", error: null, events: [] };
      case "done":
        return this.done(agent, state, (args.note ?? null) as string | null);
    }
  }

  private state(agent: string): AgentState {
    const state = this.agents.get(agent);
    if (state === undefined) throw new Error(`Unknown agent "${agent}".`);
    return state;
  }

  private readBoard(agent: string, state: AgentState): ToolOutcome {
    const fresh = this.postList.filter((post) => post.author !== agent && !state.delivered.has(post.id));
    for (const post of fresh) state.delivered.add(post.id);
    const events: RunEventPayload[] = [
      { type: "board_delivered", agent, post_ids: fresh.map((post) => post.id) },
    ];
    if (fresh.length === 0) return { result: "No new posts.", error: null, events };
    const lines = fresh.map((post) => {
      const reply = post.reply_to === null ? "" : `, reply to #${post.reply_to}`;
      return `#${post.id} ${post.author} (step ${post.tick}${reply}): ${post.text}`;
    });
    return { result: `${countOf(fresh.length, "new post")}:\n${lines.join("\n")}`, error: null, events };
  }

  private postMessage(
    agent: string,
    state: AgentState,
    tick: number,
    text: string,
    replyTo: number | null,
  ): ToolOutcome {
    const limit = this.environment.post_max_chars;
    if (text.trim() === "") return failure("Post text is empty.");
    if (text.length > limit) {
      return failure(
        `Post is ${formatNumber(text.length)} characters; the limit is ${formatNumber(limit)}. Nothing was posted.`,
      );
    }
    if (replyTo !== null && (replyTo < 1 || replyTo > this.postList.length)) {
      return failure(`There is no post #${replyTo}.`);
    }
    const post: Post = { id: this.postList.length + 1, author: agent, tick, text, reply_to: replyTo };
    this.postList.push(post);
    state.delivered.add(post.id);
    return { result: `Posted as #${post.id}.`, error: null, events: [{ type: "post_created", post }] };
  }

  private listDocuments(state: AgentState): ToolOutcome {
    if (this.docs.length === 0) return { result: "No documents.", error: null, events: [] };
    const lines = this.docs.map((doc) => {
      const opened = state.opened.has(doc.meta.id) ? " (opened)" : "";
      return `- ${documentHeader(doc)}${opened}`;
    });
    return { result: `${countOf(this.docs.length, "document")}:\n${lines.join("\n")}`, error: null, events: [] };
  }

  private readDocument(agent: string, state: AgentState, id: string): ToolOutcome {
    const doc = this.docsById.get(id);
    if (doc === undefined) {
      return failure(`There is no document "${id}". Use list_documents to see the ids.`);
    }
    const firstOpen = !state.opened.has(id);
    if (firstOpen) {
      if (state.readsLeft === 0) {
        return failure(
          `You've used all ${formatNumber(this.environment.doc_read_budget)} of your document reads.`,
        );
      }
      state.readsLeft -= 1;
      state.opened.add(id);
    }
    return {
      result: `${documentHeader(doc)}\n\n${doc.text}`,
      error: null,
      events: [
        { type: "document_opened", agent, doc_id: id, first_open: firstOpen, reads_left: state.readsLeft },
      ],
    };
  }

  private readDeliverable(agent: string, state: AgentState): ToolOutcome {
    const current = this.versionList.at(-1);
    const version = current?.version ?? 0;
    state.lastSeenDeliverable = Math.max(state.lastSeenDeliverable, version);
    const events: RunEventPayload[] = [{ type: "deliverable_read", agent, version }];
    if (current === undefined) return { result: "The deliverable is empty.", error: null, events };
    return {
      result: `Deliverable v${current.version}, written by ${current.author} at step ${current.tick}:\n\n${current.text}`,
      error: null,
      events,
    };
  }

  private writeDeliverable(agent: string, state: AgentState, tick: number, text: string): ToolOutcome {
    const limit = this.environment.deliverable_max_chars;
    if (text.length > limit) {
      return failure(
        `Deliverable text is ${formatNumber(text.length)} characters; the limit is ${formatNumber(limit)}. Nothing was saved.`,
      );
    }
    const replaced = this.versionList.at(-1);
    const replacedVersion = replaced?.version ?? 0;
    const replacedAuthor = replaced?.author ?? null;
    const version: DeliverableVersion = {
      version: replacedVersion + 1,
      author: agent,
      tick,
      text,
      replaced_version: replacedVersion,
      replaced_author: replacedAuthor,
      writer_had_seen_replaced:
        replacedVersion === 0 || replacedAuthor === agent || state.lastSeenDeliverable >= replacedVersion,
    };
    this.versionList.push(version);
    state.lastSeenDeliverable = version.version;

    let replacedText: string;
    if (replaced === undefined) replacedText = "replaced the empty deliverable";
    else if (replaced.author === agent) replacedText = `replaced v${replaced.version}, which you wrote at step ${replaced.tick}`;
    else replacedText = `replaced v${replaced.version}, written by ${replaced.author} at step ${replaced.tick}`;
    return {
      result: `Saved as v${version.version}; ${replacedText}.`,
      error: null,
      events: [{ type: "deliverable_written", version }],
    };
  }

  private done(agent: string, state: AgentState, note: string | null): ToolOutcome {
    state.status = "done";
    return { result: "Done. You won't act again.", error: null, events: [{ type: "agent_done", agent, note }] };
  }
}

function documentHeader(doc: LoadedDocument): string {
  return `${doc.meta.id} · "${doc.meta.title}" · ${countOf(doc.meta.words, "word")}`;
}

function failure(error: string): ToolOutcome {
  return { result: error, error, events: [] };
}
