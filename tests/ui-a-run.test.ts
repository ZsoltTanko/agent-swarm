import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS } from "../src/shared/api.ts";
import { deriveRunState, stepKey } from "../src/shared/derive.ts";
import type { RunEvent } from "../src/shared/events.ts";
import type { StepRecord } from "../src/shared/runstate.ts";
import {
  appendEvents,
  endedEventOf,
  indexLog,
  isStale,
  latestTickOf,
  neighborStepTick,
  pinnedEndpoint,
  relatedToSelection,
  resolveTick,
  selectionTick,
  stepActions,
} from "../src/ui/useRun.ts";
import { LogBuilder } from "./fixtures/derive/log-builder.ts";

/**
 * Three agents over four ticks:
 *  1. Otter reads the board, posts #1, opens a, re-opens a. Heron reads the board (#1), posts #2 and #3.
 *     Wren's post fails, then it opens b.
 *  2. Otter reads the board (#2, #3), reads v0, writes v1. Heron sleeps and is woken. Wren is truncated
 *     and sleeps.
 *  3. Heron replies #4 to #1 and is done. Otter reads v1. Wren is asleep.
 *  4. Otter is stopped; the run ends.
 */
function log(end = true): RunEvent[] {
  const b = new LogBuilder(["Heron", "Otter", "Wren"], ["a", "b", "c"]);
  b.startTick(1, ["Otter", "Heron", "Wren"]);
  b.call("Otter");
  b.readBoard("Otter", []);
  b.post("Otter", "Otter here.");
  b.openDoc("Otter", "a", true, 1);
  b.openDoc("Otter", "a", false, 1);
  b.call("Heron");
  b.readBoard("Heron", [1]);
  b.post("Heron", "Heron here.");
  b.post("Heron", "Taking b.");
  b.call("Wren");
  b.tool("Wren", "post_message", { text: "x".repeat(900) }, "Post is 900 characters; the limit is 800.");
  b.openDoc("Wren", "b", true, 1);

  b.startTick(2, ["Heron", "Otter", "Wren"]);
  b.call("Heron");
  b.sleep("Heron");
  b.call("Otter");
  b.readBoard("Otter", [2, 3]);
  b.readDeliverable("Otter", 0);
  b.write("Otter", "Draft v1", true);
  b.call("Wren", { truncated: true });
  b.sleep("Wren");
  b.wake("Heron");

  b.startTick(3, ["Heron", "Otter"], { asleep: ["Wren"] });
  b.call("Heron");
  b.post("Heron", "Re Otter.", 1);
  b.done("Heron", "Signing off.");
  b.call("Otter");
  b.readDeliverable("Otter", 1);

  b.startTick(4, ["Otter"], { asleep: ["Wren"], finished: ["Heron"] });
  b.stop("Otter");
  if (end) b.end("all_stopped");
  return b.events;
}

function step(events: RunEvent[], agent: string, tick: number): StepRecord {
  const record = deriveRunState(events, tick).step_by_key[stepKey(agent, tick)];
  if (!record) throw new Error(`no step ${agent}@${tick}`);
  return record;
}

describe("appendEvents", () => {
  it("appends only events past the last seq, and returns the same array when nothing is new", () => {
    const events = log();
    const head = events.slice(0, 10);
    expect(appendEvents(head, events.slice(5, 15)).map((e) => e.seq)).toEqual(events.slice(0, 15).map((e) => e.seq));
    expect(appendEvents(head, events.slice(0, 10))).toBe(head);
    expect(appendEvents([], events.slice(0, 3))).toEqual(events.slice(0, 3));
  });
});

describe("log helpers", () => {
  it("finds the latest tick and run_ended", () => {
    const events = log();
    expect(latestTickOf(events)).toBe(4);
    expect(endedEventOf(events)?.reason).toBe("all_stopped");
    expect(endedEventOf(log(false))).toBeNull();
    expect(latestTickOf([])).toBe(0);
  });

  it("marks a quiet running log stale, never an ended one", () => {
    const running = log(false);
    const lastAt = Date.parse(running.at(-1)!.at);
    expect(isStale(running, lastAt + 1000)).toBe(false);
    expect(isStale(running, lastAt + STALE_AFTER_MS * 100)).toBe(true);
    expect(isStale(log(), Date.parse(log().at(-1)!.at) + STALE_AFTER_MS * 100)).toBe(false);
    expect(isStale([], Date.now())).toBe(false);
  });

  it("reads the pinned endpoint from provider.order", () => {
    const started = log()[0]!;
    if (started.type !== "run_started") throw new Error("expected run_started");
    const withParams = (params: Record<string, unknown>) => ({
      ...started.config,
      agents: { ...started.config.agents, model: { ...started.config.agents.model, params } },
    });
    expect(pinnedEndpoint(withParams({ provider: { order: ["streamlake/fp8", "other"] } }))).toBe("streamlake/fp8");
    expect(pinnedEndpoint(withParams({}))).toBeNull();
    expect(pinnedEndpoint(withParams({ provider: { order: [] } }))).toBeNull();
    expect(pinnedEndpoint(withParams({ provider: "x" }))).toBeNull();
  });
});

describe("resolveTick", () => {
  it("follows live when the URL says live or leaves the tick out, while running", () => {
    expect(resolveTick("live", 9, true)).toEqual({ tick: 9, following: true });
    expect(resolveTick(null, 9, true)).toEqual({ tick: 9, following: true });
  });

  it("shows the last tick without following once the run has ended", () => {
    expect(resolveTick(null, 9, false)).toEqual({ tick: 9, following: false });
    expect(resolveTick("live", 9, false)).toEqual({ tick: 9, following: false });
  });

  it("clamps a fixed tick to the log", () => {
    expect(resolveTick(4, 9, true)).toEqual({ tick: 4, following: false });
    expect(resolveTick(40, 9, true)).toEqual({ tick: 9, following: false });
    expect(resolveTick(-2, 9, false)).toEqual({ tick: 0, following: false });
  });
});

describe("indexLog", () => {
  const index = indexLog(log());

  it("indexes tick starts, wakes, steps, posts, and versions", () => {
    expect(index.tickStarts.get(3)?.asleep).toEqual(["Wren"]);
    expect(index.wakes.get("Heron")).toEqual(new Set([2]));
    expect(index.stepTicks.get("Otter")).toEqual([1, 2, 3, 4]);
    expect(index.stepTicks.get("Wren")).toEqual([1, 2]);
    expect(index.postTicks.get(4)).toBe(3);
    expect(index.versionTicks.get(1)).toBe(2);
  });

  it("finds an agent's neighboring steps across the whole log", () => {
    expect(neighborStepTick(index, "Wren", 1, 1)).toBe(2);
    expect(neighborStepTick(index, "Wren", 2, 1)).toBeNull();
    expect(neighborStepTick(index, "Otter", 4, -1)).toBe(3);
    expect(neighborStepTick(index, "Otter", 1, -1)).toBeNull();
    expect(neighborStepTick(index, "Heron", 3, -1)).toBe(2);
    expect(neighborStepTick(index, "Nobody", 1, 1)).toBeNull();
  });

  it("gives the tick a selection belongs to", () => {
    expect(selectionTick({ kind: "step", agent: "Otter", tick: 3 }, index)).toBe(3);
    expect(selectionTick({ kind: "post", id: 4 }, index)).toBe(3);
    expect(selectionTick({ kind: "version", version: 1 }, index)).toBe(2);
    expect(selectionTick({ kind: "post", id: 99 }, index)).toBeNull();
    expect(selectionTick({ kind: "doc", id: "a" }, index)).toBeNull();
  });
});

describe("stepActions", () => {
  const events = log();

  it("lists actions in order, merging consecutive repeats and marking re-opens", () => {
    expect(stepActions(step(events, "Otter", 1)).map((a) => [a.kind, a.count])).toEqual([
      ["board", 1],
      ["post", 1],
      ["doc", 1],
      ["doc-reopen", 1],
    ]);
    expect(stepActions(step(events, "Heron", 1)).map((a) => [a.kind, a.count])).toEqual([
      ["board", 1],
      ["post", 2],
    ]);
  });

  it("names the post ids, versions, and documents involved", () => {
    expect(stepActions(step(events, "Heron", 1))[1]?.details).toEqual(["post_message → #2", "post_message → #3"]);
    expect(stepActions(step(events, "Otter", 1))[0]?.details).toEqual(["read_board → no new posts"]);
    expect(stepActions(step(events, "Otter", 2)).flatMap((a) => a.details)).toEqual([
      "read_board → 2 new posts (#2, #3)",
      "read_deliverable → v0",
      "write_deliverable → v1",
    ]);
    expect(stepActions(step(events, "Otter", 1))[3]?.details).toEqual(["read_document a (re-open)"]);
  });

  it("shows failed calls as errors in place", () => {
    const actions = stepActions(step(events, "Wren", 1));
    expect(actions.map((a) => a.kind)).toEqual(["error", "doc"]);
    expect(actions[0]?.details[0]).toContain("post_message: Post is 900 characters");
  });

  it("adds sleep, done, stop, and truncation", () => {
    expect(stepActions(step(events, "Wren", 2)).map((a) => a.kind)).toEqual(["sleep", "truncated"]);
    expect(stepActions(step(events, "Heron", 3)).map((a) => a.kind)).toEqual(["post", "done"]);
    expect(stepActions(step(events, "Otter", 4)).map((a) => a.kind)).toEqual(["stop"]);
  });
});

describe("relatedToSelection", () => {
  const state = deriveRunState(log(), 4);

  it("relates a step to the posts it created and received", () => {
    const related = relatedToSelection({ kind: "step", agent: "Otter", tick: 2 }, state);
    expect([...related.steps]).toEqual([["Otter@2", "primary"]]);
    expect(related.posts).toEqual(
      new Map([
        [2, "received"],
        [3, "received"],
      ]),
    );
    expect(relatedToSelection({ kind: "step", agent: "Heron", tick: 1 }, state).posts).toEqual(
      new Map([
        [1, "received"],
        [2, "created"],
        [3, "created"],
      ]),
    );
  });

  it("relates a post to the step that wrote it and the steps that received it", () => {
    const related = relatedToSelection({ kind: "post", id: 1 }, state);
    expect(related.posts).toEqual(new Map([[1, "selected"]]));
    expect(related.steps).toEqual(
      new Map([
        ["Heron@1", "secondary"],
        ["Otter@1", "primary"],
      ]),
    );
  });

  it("relates a version to its writer and readers, and a document to its openers", () => {
    expect(relatedToSelection({ kind: "version", version: 1 }, state).steps).toEqual(
      new Map([
        ["Otter@3", "secondary"],
        ["Otter@2", "primary"],
      ]),
    );
    expect(relatedToSelection({ kind: "doc", id: "a" }, state).steps).toEqual(new Map([["Otter@1", "primary"]]));
  });

  it("relates nothing for no selection or an agent", () => {
    expect(relatedToSelection({ kind: "none" }, state).steps.size).toBe(0);
    expect(relatedToSelection({ kind: "agent", agent: "Otter" }, state).posts.size).toBe(0);
  });
});
