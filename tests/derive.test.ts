import { describe, expect, it } from "vitest";
import {
  agentByName,
  deriveRunState,
  formatDuration,
  formatTokens,
  formatUsd,
  stepKey,
  stepsForAgent,
} from "../src/shared/derive.ts";
import type { RunEvent } from "../src/shared/events.ts";
import type { AgentView, RunState, StepRecord } from "../src/shared/runstate.ts";
import type { Usage } from "../src/shared/types.ts";
import { CALL_USAGE, LogBuilder } from "./fixtures/derive/log-builder.ts";

const HERON_POST = "Heron: a is about budgets.";
const OTTER_POSTS = ["Otter here. Taking doc a.", "Thanks Wren."];
const WREN_POSTS = ["Wren here.", "Agree with Otter.", "v3 is up."];
const FINAL_TEXT = "Final draft v3";

/**
 * Three agents, four documents, read budget 2, five ticks:
 *  1. order Otter, Heron, Wren. Posts #1 (Otter), #2 (Heron, after receiving #1), #3 (Wren, blind only
 *     to same-tick posts, so not blind); Wren's second tool call errors.
 *  2. order Wren, Otter, Heron. Wren posts #4 replying to #1 before reading the board (blind), then
 *     writes v1. Otter receives #2-#4, opens a (then re-opens it), posts #5 (blind: #2 and #3 were unread
 *     when its step began), and overwrites v1 unseen.
 *     Heron's truncated response has no tool calls: it sleeps and is woken at the end of the tick.
 *  3. order Heron, Otter, Wren. Heron sleeps again (nobody posts, so it stays asleep); Otter reads v2
 *     and is done; Wren reads v2, opens c, and writes v3.
 *  4. only Wren is active. It receives #5, posts #6 (blind to #5 the same way); Heron is woken.
 *  5. order Heron, Wren. Heron is stopped with context_full; Wren is done. The run ends.
 */
function mainLog(): RunEvent[] {
  const log = new LogBuilder(["Heron", "Otter", "Wren"], ["a", "b", "c", "d"], { readBudget: 2 });

  log.startTick(1, ["Otter", "Heron", "Wren"]);
  log.call("Otter");
  log.readBoard("Otter", []);
  log.post("Otter", OTTER_POSTS[0]!);
  log.call("Heron");
  log.readBoard("Heron", [1]);
  log.openDoc("Heron", "a", true, 1);
  log.post("Heron", HERON_POST);
  log.call("Wren");
  log.post("Wren", WREN_POSTS[0]!);
  log.tool("Wren", "read_document", { id: "zzz" }, "Unknown document: zzz");

  log.startTick(2, ["Wren", "Otter", "Heron"]);
  log.call("Wren");
  log.post("Wren", WREN_POSTS[1]!, 1);
  log.readBoard("Wren", [1, 2]);
  log.write("Wren", "Draft v1", true);
  log.call("Otter");
  log.readBoard("Otter", [2, 3, 4]);
  log.openDoc("Otter", "a", true, 1);
  log.openDoc("Otter", "a", false, 1);
  log.post("Otter", OTTER_POSTS[1]!, 4);
  log.write("Otter", "Draft v2 by Otter", false);
  log.call("Heron", { truncated: true });
  log.sleep("Heron");
  log.wake("Heron");

  log.startTick(3, ["Heron", "Otter", "Wren"]);
  log.call("Heron");
  log.sleep("Heron");
  log.call("Otter");
  log.readDeliverable("Otter", 2);
  log.done("Otter", "My part is in.");
  log.call("Wren");
  log.readDeliverable("Wren", 2);
  log.openDoc("Wren", "c", true, 1);
  log.write("Wren", FINAL_TEXT, true);

  log.startTick(4, ["Wren"], { asleep: ["Heron"], finished: ["Otter"] });
  log.call("Wren", { usage: { cost_usd: 0.5 } });
  log.readBoard("Wren", [5]);
  log.post("Wren", WREN_POSTS[2]!);
  log.wake("Heron");

  log.startTick(5, ["Heron", "Wren"], { finished: ["Otter"] });
  log.stop("Heron");
  log.call("Wren");
  log.readBoard("Wren", []);
  log.done("Wren", null);
  log.end("all_done");

  return log.events;
}

function usageOf(calls: number, extraCost = 0): Usage {
  return {
    prompt_tokens: CALL_USAGE.prompt_tokens * calls,
    completion_tokens: CALL_USAGE.completion_tokens * calls,
    reasoning_tokens: CALL_USAGE.reasoning_tokens * calls,
    cached_tokens: CALL_USAGE.cached_tokens * calls,
    cost_usd: CALL_USAGE.cost_usd * calls + extraCost,
  };
}

function agent(state: RunState, name: string): AgentView {
  const view = agentByName(state, name);
  if (!view) throw new Error(`no agent ${name}`);
  return view;
}

function step(state: RunState, name: string, tick: number): StepRecord {
  const record = state.step_by_key[stepKey(name, tick)];
  if (!record) throw new Error(`no step ${name}@${tick}`);
  return record;
}

function seqOf(events: RunEvent[], predicate: (event: RunEvent) => boolean): number {
  const event = events.find(predicate);
  if (!event) throw new Error("no matching event");
  return event.seq;
}

const mean = (texts: string[]): number => texts.reduce((sum, text) => sum + text.length, 0) / texts.length;

describe("deriveRunState: whole run", () => {
  const events = mainLog();
  const state = deriveRunState(events, 5);

  it("fills the header fields", () => {
    expect(state.run_id).toBe("test-run");
    expect(state.started).toBe(events[0]);
    expect(state.ended).toBe(events.at(-1));
    expect(state.status).toBe("ended");
    expect(state.tick).toBe(5);
    expect(state.latest_tick).toBe(5);
    expect(state.tick_cap).toBe(10);
    expect(state.usage).toEqual(usageOf(11, 0.25));
  });

  it("derives every agent view", () => {
    expect(state.agents.map((view) => view.info.name)).toEqual(["Heron", "Otter", "Wren"]);
    expect(agent(state, "Heron")).toEqual({
      info: { name: "Heron", index: 0, model: "test/model" },
      status: "stopped",
      reads_left: 1,
      docs_opened: [{ doc_id: "a", tick: 1 }],
      posts: 1,
      steps: 4,
      ticks_asleep: 1,
      first_post_tick: 1,
      done_tick: null,
      done_note: null,
      stopped_reason: "context_full",
      last_seen_deliverable: 0,
      unread_posts: 4,
      usage: usageOf(3),
    });
    expect(agent(state, "Otter")).toEqual({
      info: { name: "Otter", index: 1, model: "test/model" },
      status: "done",
      reads_left: 1,
      docs_opened: [{ doc_id: "a", tick: 2 }],
      posts: 2,
      steps: 3,
      ticks_asleep: 0,
      first_post_tick: 1,
      done_tick: 3,
      done_note: "My part is in.",
      stopped_reason: null,
      last_seen_deliverable: 2,
      unread_posts: 1,
      usage: usageOf(3),
    });
    expect(agent(state, "Wren")).toEqual({
      info: { name: "Wren", index: 2, model: "test/model" },
      status: "done",
      reads_left: 1,
      docs_opened: [{ doc_id: "c", tick: 3 }],
      posts: 3,
      steps: 5,
      ticks_asleep: 0,
      first_post_tick: 1,
      done_tick: 5,
      done_note: null,
      stopped_reason: null,
      last_seen_deliverable: 3,
      unread_posts: 0,
      usage: usageOf(5, 0.25),
    });
  });

  it("builds posts with first deliveries and replies", () => {
    expect(state.posts).toEqual([
      {
        id: 1, author: "Otter", tick: 1, text: OTTER_POSTS[0], reply_to: null,
        received_by: [{ agent: "Heron", tick: 1 }, { agent: "Wren", tick: 2 }],
        replies: [4],
      },
      {
        id: 2, author: "Heron", tick: 1, text: HERON_POST, reply_to: null,
        received_by: [{ agent: "Wren", tick: 2 }, { agent: "Otter", tick: 2 }],
        replies: [],
      },
      {
        id: 3, author: "Wren", tick: 1, text: WREN_POSTS[0], reply_to: null,
        received_by: [{ agent: "Otter", tick: 2 }],
        replies: [],
      },
      {
        id: 4, author: "Wren", tick: 2, text: WREN_POSTS[1], reply_to: 1,
        received_by: [{ agent: "Otter", tick: 2 }],
        replies: [5],
      },
      {
        id: 5, author: "Otter", tick: 2, text: OTTER_POSTS[1], reply_to: 4,
        received_by: [{ agent: "Wren", tick: 4 }],
        replies: [],
      },
      { id: 6, author: "Wren", tick: 4, text: WREN_POSTS[2], reply_to: null, received_by: [], replies: [] },
    ]);
  });

  it("builds one step per model call or stop, sorted by tick and order", () => {
    expect(state.steps.map((record) => record.key)).toEqual([
      "Otter@1", "Heron@1", "Wren@1",
      "Wren@2", "Otter@2", "Heron@2",
      "Heron@3", "Otter@3", "Wren@3",
      "Wren@4",
      "Heron@5", "Wren@5",
    ]);
    expect(Object.keys(state.step_by_key)).toHaveLength(12);
    for (const record of state.steps) expect(state.step_by_key[record.key]).toBe(record);
    expect(state.steps.map((record) => record.order_index)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 0, 1]);
  });

  it("attaches tool calls and domain events to their step", () => {
    const otter2 = step(state, "Otter", 2);
    const otterCall = events.find((e) => e.type === "model_call" && e.agent === "Otter" && e.tick === 2);
    expect(otter2).toMatchObject({
      agent: "Otter",
      tick: 2,
      order_index: 1,
      seq: otterCall?.seq,
      posts_created: [5],
      posts_received: [2, 3, 4],
      docs_opened: [{ doc_id: "a", first_open: true }, { doc_id: "a", first_open: false }],
      deliverable_reads: [],
      deliverable_writes: [2],
      slept: false,
      done: false,
      stopped: null,
      truncated: false,
      errors: 0,
    });
    expect(otter2.call).toBe(otterCall);
    expect(otter2.tool_calls.map((call) => call.name)).toEqual([
      "read_board", "read_document", "read_document", "post_message", "write_deliverable",
    ]);

    const wren1 = step(state, "Wren", 1);
    expect(wren1.tool_calls).toHaveLength(2);
    expect(wren1.errors).toBe(1);
    expect(wren1.posts_created).toEqual([3]);
    expect(wren1.posts_received).toEqual([]);

    const wren2 = step(state, "Wren", 2);
    expect(wren2.posts_created).toEqual([4]);
    expect(wren2.posts_received).toEqual([1, 2]);
    expect(wren2.deliverable_writes).toEqual([1]);

    expect(step(state, "Otter", 3)).toMatchObject({ deliverable_reads: [2], done: true });
    expect(step(state, "Wren", 3)).toMatchObject({ deliverable_reads: [2], deliverable_writes: [3], docs_opened: [{ doc_id: "c", first_open: true }] });
    expect(step(state, "Wren", 5)).toMatchObject({ done: true, posts_received: [] });
  });

  it("marks sleeping, truncated, and stopped steps", () => {
    const heron2 = step(state, "Heron", 2);
    expect(heron2).toMatchObject({ slept: true, truncated: true, tool_calls: [], errors: 0 });
    expect(heron2.call).not.toBeNull();

    const heron5 = step(state, "Heron", 5);
    expect(heron5).toMatchObject({
      call: null,
      stopped: "context_full",
      order_index: 0,
      tool_calls: [],
      slept: false,
      done: false,
      truncated: false,
    });
    expect(heron5.seq).toBe(seqOf(events, (e) => e.type === "agent_stopped"));
  });

  it("lists deliverable versions and coverage", () => {
    expect(state.deliverable.map((v) => [v.version, v.author, v.tick, v.replaced_version, v.replaced_author, v.writer_had_seen_replaced])).toEqual([
      [1, "Wren", 2, 0, null, true],
      [2, "Otter", 2, 1, "Wren", false],
      [3, "Wren", 3, 2, "Otter", true],
    ]);
    expect(state.coverage).toEqual([
      { agent: "Heron", doc_id: "a", tick: 1 },
      { agent: "Otter", doc_id: "a", tick: 2 },
      { agent: "Wren", doc_id: "c", tick: 3 },
    ]);
  });

  it("summarizes activity per tick", () => {
    expect(state.activity).toEqual([
      { tick: 1, active: 3, calls: 3, posts: 3, doc_opens: 1, writes: 0, sleeps: 0, cost_usd: 0.75 },
      { tick: 2, active: 3, calls: 3, posts: 2, doc_opens: 1, writes: 2, sleeps: 1, cost_usd: 0.75 },
      { tick: 3, active: 3, calls: 3, posts: 0, doc_opens: 1, writes: 1, sleeps: 1, cost_usd: 0.75 },
      { tick: 4, active: 1, calls: 1, posts: 1, doc_opens: 0, writes: 0, sleeps: 0, cost_usd: 0.5 },
      { tick: 5, active: 2, calls: 1, posts: 0, doc_opens: 0, writes: 0, sleeps: 0, cost_usd: 0.25 },
    ]);
  });

  it("computes every metric", () => {
    expect(state.metrics).toEqual({
      coverage: { opened: 2, total: 4, never_opened: ["b", "d"], duplicate_opens: 1 },
      board: {
        posts: 6,
        replies: 2,
        per_agent: {
          Heron: { posts: 1, first_post_tick: 1, mean_length: HERON_POST.length },
          Otter: { posts: 2, first_post_tick: 1, mean_length: mean(OTTER_POSTS) },
          Wren: { posts: 3, first_post_tick: 1, mean_length: mean(WREN_POSTS) },
        },
      },
      posting_blind: { posts: 6, with_unread: 3 },
      deliverable: { versions: 3, authors: ["Wren", "Otter"], unseen_overwrites: 1, final_length: FINAL_TEXT.length },
      activity: {
        Heron: { steps: 4, ticks_asleep: 1, done_tick: null },
        Otter: { steps: 3, ticks_asleep: 0, done_tick: 3 },
        Wren: { steps: 5, ticks_asleep: 0, done_tick: 5 },
      },
      cost: {
        usage: usageOf(11, 0.25),
        per_agent: { Heron: usageOf(3), Otter: usageOf(3), Wren: usageOf(5, 0.25) },
      },
    });
  });

  it("does not modify the events", () => {
    const before = JSON.stringify(events);
    deriveRunState(events, 5);
    deriveRunState(events, 2);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("deriveRunState: tick cut-off", () => {
  const events = mainLog();

  it("includes only events up to the selected tick, but keeps ended and the whole activity strip", () => {
    const state = deriveRunState(events, 2);
    expect(state.tick).toBe(2);
    expect(state.latest_tick).toBe(5);
    expect(state.ended?.type).toBe("run_ended");
    expect(state.status).toBe("ended");
    expect(state.activity).toHaveLength(5);
    expect(state.posts.map((post) => post.id)).toEqual([1, 2, 3, 4, 5]);
    expect(state.posts[4]?.received_by).toEqual([]);
    expect(state.steps.map((record) => record.key)).toEqual(["Otter@1", "Heron@1", "Wren@1", "Wren@2", "Otter@2", "Heron@2"]);
    expect(state.step_by_key["Heron@3"]).toBeUndefined();
    expect(state.deliverable.map((v) => v.version)).toEqual([1, 2]);
    expect(state.coverage).toEqual([
      { agent: "Heron", doc_id: "a", tick: 1 },
      { agent: "Otter", doc_id: "a", tick: 2 },
    ]);
    expect(state.usage).toEqual(usageOf(6));
    expect(state.agents.map((view) => [view.info.name, view.status, view.unread_posts, view.steps, view.last_seen_deliverable])).toEqual([
      ["Heron", "awake", 3, 2, 0],
      ["Otter", "awake", 0, 2, 2],
      ["Wren", "awake", 1, 2, 1],
    ]);
    expect(state.metrics.posting_blind).toEqual({ posts: 5, with_unread: 2 });
    expect(state.metrics.deliverable).toEqual({ versions: 2, authors: ["Wren", "Otter"], unseen_overwrites: 1, final_length: "Draft v2 by Otter".length });
    expect(state.metrics.coverage).toEqual({ opened: 1, total: 4, never_opened: ["b", "c", "d"], duplicate_opens: 1 });
  });

  it("counts same-tick posts as unread", () => {
    const state = deriveRunState(events, 1);
    expect(state.agents.map((view) => view.unread_posts)).toEqual([1, 2, 2]);
    expect(state.metrics.posting_blind).toEqual({ posts: 3, with_unread: 0 });
  });

  it("follows sleep and wake across ticks", () => {
    const statuses = [1, 2, 3, 4, 5].map((t) => agent(deriveRunState(events, t), "Heron").status);
    expect(statuses).toEqual(["awake", "awake", "asleep", "awake", "stopped"]);
    const asleep = [1, 2, 3, 4, 5].map((t) => agent(deriveRunState(events, t), "Heron").ticks_asleep);
    expect(asleep).toEqual([0, 0, 0, 1, 1]);
    expect(agent(deriveRunState(events, 3), "Otter")).toMatchObject({ status: "done", done_tick: 3 });
    expect(agent(deriveRunState(events, 2), "Otter")).toMatchObject({ status: "awake", done_tick: null, done_note: null });
  });

  it("clamps the tick into [0, latest_tick]", () => {
    expect(deriveRunState(events, 99).tick).toBe(5);
    expect(deriveRunState(events, Infinity).tick).toBe(5);
    expect(deriveRunState(events, Number.NaN).tick).toBe(5);
    expect(deriveRunState(events, 2.7).tick).toBe(2);
    expect(deriveRunState(events, -3).tick).toBe(0);
  });

  it("at tick 0 shows the initial world", () => {
    const state = deriveRunState(events, 0);
    expect(state.posts).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.deliverable).toEqual([]);
    expect(state.coverage).toEqual([]);
    expect(state.activity).toHaveLength(5);
    expect(state.usage).toEqual(usageOf(0));
    for (const view of state.agents) {
      expect(view).toMatchObject({ status: "awake", reads_left: 2, posts: 0, steps: 0, unread_posts: 0, last_seen_deliverable: 0 });
    }
    expect(state.metrics.coverage).toEqual({ opened: 0, total: 4, never_opened: ["a", "b", "c", "d"], duplicate_opens: 0 });
    expect(state.metrics.posting_blind).toEqual({ posts: 0, with_unread: 0 });
    expect(state.metrics.deliverable).toEqual({ versions: 0, authors: [], unseen_overwrites: 0, final_length: 0 });
  });
});

describe("deriveRunState: live and partial logs", () => {
  it("handles a log with only run_started", () => {
    const log = new LogBuilder(["Heron", "Otter"], ["a"]);
    const state = deriveRunState(log.events, 3);
    expect(state.tick).toBe(0);
    expect(state.latest_tick).toBe(0);
    expect(state.ended).toBeNull();
    expect(state.status).toBe("running");
    expect(state.activity).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(state.agents.map((view) => view.status)).toEqual(["awake", "awake"]);
    expect(state.metrics.board).toEqual({
      posts: 0,
      replies: 0,
      per_agent: {
        Heron: { posts: 0, first_post_tick: null, mean_length: 0 },
        Otter: { posts: 0, first_post_tick: null, mean_length: 0 },
      },
    });
  });

  it("handles a log that ends right after tick_started", () => {
    const log = new LogBuilder(["Heron", "Otter"], ["a"]);
    log.startTick(1, ["Otter", "Heron"]);
    const state = deriveRunState(log.events, 1);
    expect(state.latest_tick).toBe(1);
    expect(state.activity).toEqual([{ tick: 1, active: 2, calls: 0, posts: 0, doc_opens: 0, writes: 0, sleeps: 0, cost_usd: 0 }]);
    expect(state.steps).toEqual([]);
  });

  it("handles a log that ends mid-step", () => {
    const events = mainLog();
    const cut = seqOf(events, (e) => e.type === "document_opened" && e.agent === "Otter" && e.first_open);
    const state = deriveRunState(events.slice(0, cut + 1), 99);
    expect(state.tick).toBe(2);
    expect(state.latest_tick).toBe(2);
    expect(state.ended).toBeNull();
    expect(state.status).toBe("running");
    expect(state.steps.map((record) => record.key)).toEqual(["Otter@1", "Heron@1", "Wren@1", "Wren@2", "Otter@2"]);
    const otter2 = step(state, "Otter", 2);
    expect(otter2.tool_calls.map((call) => call.name)).toEqual(["read_board"]);
    expect(otter2.docs_opened).toEqual([{ doc_id: "a", first_open: true }]);
    expect(state.activity[1]).toEqual({ tick: 2, active: 3, calls: 2, posts: 1, doc_opens: 1, writes: 1, sleeps: 0, cost_usd: 0.5 });
    expect(agent(state, "Otter")).toMatchObject({ reads_left: 1, unread_posts: 0 });
  });

  it("gives ticks without events an empty activity entry", () => {
    const log = new LogBuilder(["Heron"], ["a"]);
    log.startTick(1, ["Heron"]);
    log.call("Heron");
    log.sleep("Heron");
    log.end("quiescent", 3);
    const state = deriveRunState(log.events, 3);
    expect(state.latest_tick).toBe(3);
    expect(state.activity.map((entry) => entry.tick)).toEqual([1, 2, 3]);
    expect(state.activity[1]).toEqual({ tick: 2, active: 0, calls: 0, posts: 0, doc_opens: 0, writes: 0, sleeps: 0, cost_usd: 0 });
  });

  it("counts the cost of an aborted tick's unapplied calls once run_ended is reached", () => {
    const log = new LogBuilder(["Heron", "Otter"], ["a"]);
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.call("Otter");
    log.startTick(2, ["Otter", "Heron"]);
    const unappliedUsage = { ...CALL_USAGE, cost_usd: 0.5 };
    log.end("api_error", 2, [{ agent: "Otter", cache_key: "key-Otter-2", cache_hit: false, usage: unappliedUsage }]);
    const state = deriveRunState(log.events, 2);
    expect(state.usage.cost_usd).toBeCloseTo(1, 10);
    expect(agent(state, "Otter").usage.cost_usd).toBeCloseTo(0.75, 10);
    expect(agent(state, "Heron").usage.cost_usd).toBeCloseTo(0.25, 10);
    expect(state.metrics.cost.usage.cost_usd).toBeCloseTo(1, 10);
    expect(state.activity[1]).toMatchObject({ tick: 2, calls: 0, cost_usd: 0.5 });
    expect(deriveRunState(log.events, 1).usage.cost_usd).toBeCloseTo(0.5, 10);
  });

  it("rejects a log without run_started", () => {
    expect(() => deriveRunState([], 0)).toThrow(/run_started/);
    const events = mainLog().slice(1);
    expect(() => deriveRunState(events, 1)).toThrow(/run_started/);
  });
});

describe("deriveRunState: agents", () => {
  it("lists agents in AgentInfo.index order", () => {
    const events = mainLog();
    const started = events[0];
    if (started?.type !== "run_started") throw new Error("expected run_started");
    const reordered: RunEvent[] = [{ ...started, agents: [...started.agents].reverse() }, ...events.slice(1)];
    expect(deriveRunState(reordered, 5).agents.map((view) => view.info.name)).toEqual(["Heron", "Otter", "Wren"]);
  });

  it("counts every tick an agent is listed asleep", () => {
    const log = new LogBuilder(["Heron", "Otter"], ["a"]);
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.sleep("Heron");
    log.call("Otter");
    log.openDoc("Otter", "a", true, 1);
    log.startTick(2, ["Otter"], { asleep: ["Heron"] });
    log.call("Otter");
    log.readDeliverable("Otter", 0);
    log.startTick(3, ["Otter"], { asleep: ["Heron"] });
    log.call("Otter");
    log.post("Otter", "Anyone there?");
    log.wake("Heron");
    log.startTick(4, ["Heron", "Otter"]);
    log.call("Heron");
    log.readBoard("Heron", [1]);

    const sleepy = (t: number) => agent(deriveRunState(log.events, t), "Heron");
    expect([1, 2, 3, 4].map((t) => [sleepy(t).status, sleepy(t).ticks_asleep])).toEqual([
      ["asleep", 0],
      ["asleep", 1],
      ["awake", 2],
      ["awake", 2],
    ]);
    const state = deriveRunState(log.events, 4);
    expect(state.activity.map((entry) => entry.sleeps)).toEqual([1, 0, 0, 0]);
    expect(state.metrics.activity.Heron).toEqual({ steps: 2, ticks_asleep: 2, done_tick: null });
    expect(agent(state, "Otter").last_seen_deliverable).toBe(0);
  });

  it("attaches a stop to the step of the same agent and tick", () => {
    const log = new LogBuilder(["Heron", "Otter"], ["a"]);
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.readBoard("Heron", []);
    log.stop("Heron");
    log.call("Otter");
    const state = deriveRunState(log.events, 1);
    expect(state.steps.map((record) => record.key)).toEqual(["Heron@1", "Otter@1"]);
    const heron1 = step(state, "Heron", 1);
    expect(heron1.call).not.toBeNull();
    expect(heron1.stopped).toBe("context_full");
    expect(heron1.seq).toBe(seqOf(log.events, (e) => e.type === "model_call" && e.agent === "Heron"));
    expect(agent(state, "Heron")).toMatchObject({ status: "stopped", stopped_reason: "context_full", steps: 1 });
  });

  it("orders a stop by the agent's place in the tick order, wherever it appears in the log", () => {
    const log = new LogBuilder(["Heron", "Otter"], ["a"]);
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Otter");
    log.stop("Heron");
    const state = deriveRunState(log.events, 1);
    expect(state.steps.map((record) => [record.key, record.order_index])).toEqual([
      ["Heron@1", 0],
      ["Otter@1", 1],
    ]);
  });
});

describe("deriveRunState: posting blind", () => {
  const twoAgents = () => new LogBuilder(["Heron", "Otter"], ["a"]);

  it("is blind when a post from an earlier tick was never delivered", () => {
    const log = twoAgents();
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.post("Heron", "hello");
    log.call("Otter");
    log.startTick(2, ["Otter", "Heron"]);
    log.call("Otter");
    log.post("Otter", "me too");
    expect(deriveRunState(log.events, 2).metrics.posting_blind).toEqual({ posts: 2, with_unread: 1 });
  });

  it("is not blind when the only unread posts were made in the same tick", () => {
    const log = twoAgents();
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.post("Heron", "hello");
    log.call("Otter");
    log.post("Otter", "hello too");
    const state = deriveRunState(log.events, 1);
    expect(state.metrics.posting_blind).toEqual({ posts: 2, with_unread: 0 });
    expect(agent(state, "Otter").unread_posts).toBe(1);
  });

  it("is blind when the earlier post is read in the same step, whichever call comes first", () => {
    // The model wrote the post before any result came back, so a read in the same response can't inform it.
    for (const readFirst of [true, false]) {
      const log = twoAgents();
      log.startTick(1, ["Heron", "Otter"]);
      log.call("Heron");
      log.post("Heron", "hello");
      log.call("Otter");
      log.startTick(2, ["Otter", "Heron"]);
      log.call("Otter");
      if (readFirst) log.readBoard("Otter", [1]);
      log.post("Otter", "I'll read d1");
      if (!readFirst) log.readBoard("Otter", [1]);
      const state = deriveRunState(log.events, 2);
      expect(state.metrics.posting_blind).toEqual({ posts: 2, with_unread: 1 });
      expect(agent(state, "Otter").unread_posts).toBe(0);
    }
  });

  it("is not blind when the earlier post was delivered in a previous step", () => {
    const log = twoAgents();
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.post("Heron", "hello");
    log.call("Otter");
    log.startTick(2, ["Otter", "Heron"]);
    log.call("Otter");
    log.readBoard("Otter", [1]);
    log.startTick(3, ["Otter", "Heron"]);
    log.call("Otter");
    log.post("Otter", "hi Heron", 1);
    expect(deriveRunState(log.events, 3).metrics.posting_blind).toEqual({ posts: 2, with_unread: 0 });
  });

  it("is blind when the board is read only after posting", () => {
    const log = twoAgents();
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.post("Heron", "hello");
    log.call("Otter");
    log.startTick(2, ["Otter", "Heron"]);
    log.call("Otter");
    log.post("Otter", "me too");
    log.readBoard("Otter", [1]);
    const state = deriveRunState(log.events, 2);
    expect(state.metrics.posting_blind).toEqual({ posts: 2, with_unread: 1 });
    expect(agent(state, "Otter").unread_posts).toBe(0);
  });

  it("ignores the author's own posts", () => {
    const log = twoAgents();
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.post("Heron", "first");
    log.call("Otter");
    log.readBoard("Otter", [1]);
    log.startTick(2, ["Heron", "Otter"]);
    log.call("Heron");
    log.readBoard("Heron", [1]);
    log.post("Heron", "second");
    const state = deriveRunState(log.events, 2);
    expect(state.metrics.posting_blind).toEqual({ posts: 2, with_unread: 0 });
    expect(state.posts[0]?.received_by).toEqual([{ agent: "Otter", tick: 1 }]);
    expect(agent(state, "Heron").unread_posts).toBe(0);
  });

  it("stays blind while an older post is unread even after newer ones arrive", () => {
    const log = new LogBuilder(["Heron", "Otter", "Wren"], ["a"]);
    log.startTick(1, ["Heron", "Otter", "Wren"]);
    log.call("Heron");
    log.post("Heron", "one");
    log.call("Otter");
    log.call("Wren");
    log.startTick(2, ["Wren", "Otter", "Heron"]);
    log.call("Wren");
    log.post("Wren", "two");
    log.call("Otter");
    log.readBoard("Otter", [2]);
    log.post("Otter", "three");
    const state = deriveRunState(log.events, 2);
    expect(state.metrics.posting_blind).toEqual({ posts: 3, with_unread: 2 });
    expect(agent(state, "Otter").unread_posts).toBe(1);
  });
});

describe("helpers", () => {
  const state = deriveRunState(mainLog(), 5);

  it("stepKey", () => {
    expect(stepKey("Otter", 12)).toBe("Otter@12");
  });

  it("agentByName", () => {
    expect(agentByName(state, "Wren")?.info.index).toBe(2);
    expect(agentByName(state, "Nobody")).toBeUndefined();
  });

  it("stepsForAgent", () => {
    expect(stepsForAgent(state, "Heron").map((record) => record.tick)).toEqual([1, 2, 3, 5]);
    expect(stepsForAgent(state, "Nobody")).toEqual([]);
  });

  it("formatUsd", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00004)).toBe("<$0.0001");
    expect(formatUsd(0.00042)).toBe("$0.00042");
    expect(formatUsd(0.0314)).toBe("$0.031");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.998)).toBe("$1.00");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("formatTokens", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(999.7)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9_960)).toBe("10k");
    expect(formatTokens(34_567)).toBe("35k");
    expect(formatTokens(999_600)).toBe("1.0M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(15_400_000)).toBe("15M");
  });

  it("formatDuration", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(999.7)).toBe("1.0s");
    expect(formatDuration(12_345)).toBe("12.3s");
    expect(formatDuration(59_960)).toBe("1m 00s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
  });
});

describe("performance", () => {
  it("derives a few thousand events quickly at every tick", () => {
    const names = ["Heron", "Otter", "Wren", "Lynx", "Moth"];
    const log = new LogBuilder(names, ["a", "b", "c", "d", "e", "f"], { tickCap: 200 });
    let postId = 0;
    for (let t = 1; t <= 200; t++) {
      log.startTick(t, names);
      for (const name of names) {
        log.call(name);
        log.readBoard(name, postId > 0 ? [postId] : []);
        postId = log.post(name, `${name} at ${t}`);
      }
    }
    expect(log.events.length).toBeGreaterThan(5000);

    const started = performance.now();
    for (let t = 0; t <= 200; t += 20) deriveRunState(log.events, t);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2000);

    const state = deriveRunState(log.events, 200);
    expect(state.posts).toHaveLength(1000);
    expect(state.steps).toHaveLength(1000);
  });
});
