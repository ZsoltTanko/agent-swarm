import { describe, expect, it } from "vitest";
import { deriveRunState } from "../src/shared/derive.ts";
import type { RunEvent } from "../src/shared/events.ts";
import type { AssistantMessage } from "../src/shared/types.ts";
import {
  buildTranscript,
  compactArguments,
  formatDelta,
  formatInt,
  groupTranscript,
  lastSeqAtTick,
  lineCount,
  reasoningOf,
  resultLink,
  shortDocId,
  splitStatusLine,
  startsCollapsed,
  tickStartedAt,
  unreadSummary,
  type TranscriptItem,
} from "../src/ui/transcript.ts";
import { LogBuilder } from "./fixtures/derive/log-builder.ts";
import { runScripted } from "./helpers/scripted-run.ts";

type StepItem = Extract<TranscriptItem, { kind: "step" }>;

function stepItems(items: TranscriptItem[]): StepItem[] {
  return items.filter((item): item is StepItem => item.kind === "step");
}

/** Heron sleeps at tick 1, is woken at its end, acts at tick 2, and is stopped at tick 3. */
function sleepWakeStopLog(): RunEvent[] {
  const log = new LogBuilder(["Heron", "Otter"], ["a", "b"]);
  log.startTick(1, ["Heron", "Otter"]);
  log.call("Heron");
  log.sleep("Heron");
  log.call("Otter");
  log.post("Otter", "Hello from Otter.");
  log.wake("Heron");
  log.startTick(2, ["Otter", "Heron"]);
  log.call("Otter");
  log.readBoard("Otter", []);
  log.call("Heron");
  log.readBoard("Heron", [1]);
  log.openDoc("Heron", "a", true, 1);
  log.startTick(3, ["Heron", "Otter"]);
  log.stop("Heron");
  log.call("Otter");
  log.done("Otter", "Finished.");
  log.end("all_stopped");
  return log.events;
}

describe("groupTranscript / buildTranscript", () => {
  it("groups a scripted run into steps that match the step records, for every agent and cut", async () => {
    const { events } = await runScripted(["Heron", "Otter", "Wren"]);
    const final = deriveRunState(events, Infinity);
    for (const tick of [0, 1, 3, Math.ceil(final.latest_tick / 2), final.latest_tick]) {
      const state = deriveRunState(events, tick);
      const cut = lastSeqAtTick(events, tick);
      for (const agent of state.agents.map((view) => view.info.name)) {
        const items = buildTranscript(events, agent, cut, state.steps);
        expect(items[0]?.kind).toBe("system");
        expect(items[1]?.kind).toBe("kickoff");

        const agentSteps = state.steps.filter((step) => step.agent === agent && step.call !== null);
        const steps = stepItems(items);
        expect(steps.map((item) => item.step?.key)).toEqual(agentSteps.map((step) => step.key));
        for (const item of steps) {
          expect(item.step!.tick).toBeLessThanOrEqual(tick);
          expect(item.tools).toHaveLength(item.step!.tool_calls.length);
          for (const tool of item.tools) {
            expect(tool.call?.id).toBe(tool.event?.call_id);
            expect(tool.result?.content).toBe(tool.event?.result);
          }
          if (item.step!.sleep_reason === "no_tool_calls") expect(item.tools).toHaveLength(0);
        }

        const wakes = events.filter((e) => e.type === "agent_woke" && e.agent === agent && e.seq <= cut);
        expect(items.filter((item) => item.kind === "wake")).toHaveLength(wakes.length);
      }
    }
  });

  it("marks wakes with the tick they happened and the step the agent fell asleep in, and puts stops last", () => {
    const events = sleepWakeStopLog();
    const state = deriveRunState(events, 3);
    const items = buildTranscript(events, "Heron", lastSeqAtTick(events, 3), state.steps);
    expect(items.map((item) => item.kind)).toEqual(["system", "kickoff", "step", "wake", "step", "stopped"]);
    const wake = items[3] as Extract<TranscriptItem, { kind: "wake" }>;
    expect(wake.tick).toBe(1);
    expect(wake.asleepSince).toBe(1);
    const stopped = items[5] as Extract<TranscriptItem, { kind: "stopped" }>;
    expect(stopped.step.tick).toBe(3);
    expect(stopped.detail).toBe("context would exceed 1000 tokens");
  });

  it("cuts at the selected tick", () => {
    const events = sleepWakeStopLog();
    const state = deriveRunState(events, 1);
    const items = buildTranscript(events, "Heron", lastSeqAtTick(events, 1), state.steps);
    expect(items.map((item) => item.kind)).toEqual(["system", "kickoff", "step", "wake"]);
    const otter = buildTranscript(events, "Otter", lastSeqAtTick(events, 1), state.steps);
    expect(stepItems(otter).map((item) => item.step?.tick)).toEqual([1]);
  });

  it("keeps tool results that have no matching call, and tolerates missing step records", () => {
    const message: AssistantMessage = { role: "assistant", content: "hi" };
    const items = groupTranscript(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "kick" },
        message,
        { role: "tool", tool_call_id: "x", content: "ok" },
      ],
      [],
      [],
    );
    const step = items[2] as StepItem;
    expect(step.step).toBeNull();
    expect(step.tools).toHaveLength(1);
    expect(step.tools[0]!.call).toBeNull();
    expect(step.tools[0]!.result?.content).toBe("ok");
  });

  it("returns nothing for an unknown agent", () => {
    const events = sleepWakeStopLog();
    const state = deriveRunState(events, 3);
    expect(buildTranscript(events, "Nobody", Infinity, state.steps)).toEqual([]);
  });
});

describe("lastSeqAtTick / tickStartedAt", () => {
  it("finds the last seq at or before a tick", () => {
    const events = sleepWakeStopLog();
    const lastOfTick1 = events.filter((e) => e.tick <= 1).at(-1)!.seq;
    expect(lastSeqAtTick(events, 1)).toBe(lastOfTick1);
    expect(lastSeqAtTick(events, 0)).toBe(0);
    expect(lastSeqAtTick(events, 99)).toBe(events.at(-1)!.seq);
    expect(lastSeqAtTick(events, -1)).toBe(-1);
    expect(lastSeqAtTick([], 3)).toBe(-1);
  });

  it("finds a tick's tick_started", () => {
    const events = sleepWakeStopLog();
    expect(tickStartedAt(events, 2)?.order).toEqual(["Otter", "Heron"]);
    expect(tickStartedAt(events, 9)).toBeNull();
  });
});

describe("splitStatusLine", () => {
  it("splits the trailing status line into parts", () => {
    expect(splitStatusLine("Posted as #1.\n\n[step 2/40 · 0 unread posts · 3 document reads left]")).toEqual({
      body: "Posted as #1.",
      status: ["step 2/40", "0 unread posts", "3 document reads left"],
    });
  });

  it("handles a bare status line (a wake message) and the status-line-off form", () => {
    expect(splitStatusLine("[step 5/40 · 5 unread posts · 0 document reads left]")).toEqual({
      body: "",
      status: ["step 5/40", "5 unread posts", "0 document reads left"],
    });
    expect(splitStatusLine("[step 9/40]")).toEqual({ body: "", status: ["step 9/40"] });
  });

  it("leaves other text alone", () => {
    expect(splitStatusLine("No new posts.")).toEqual({ body: "No new posts.", status: null });
    expect(splitStatusLine("see [step 2/40] above\nmore")).toEqual({ body: "see [step 2/40] above\nmore", status: null });
  });
});

describe("reasoningOf", () => {
  it("prefers reasoning_details text and summary blocks", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: null,
      reasoning: "plain",
      reasoning_details: [
        { type: "reasoning.text", text: "first" },
        { type: "reasoning.summary", summary: "second" },
        { type: "reasoning.encrypted", data: "xyz" },
      ],
    };
    expect(reasoningOf(message)).toEqual({ text: "first\n\nsecond", encryptedBlocks: 1 });
  });

  it("falls back to the reasoning string, and reports nothing when there is none", () => {
    expect(reasoningOf({ role: "assistant", content: null, reasoning: "plain" })).toEqual({ text: "plain", encryptedBlocks: 0 });
    expect(reasoningOf({ role: "assistant", content: null, reasoning: null, reasoning_details: null as never })).toEqual({
      text: null,
      encryptedBlocks: 0,
    });
    expect(
      reasoningOf({ role: "assistant", content: null, reasoning_details: [{ type: "reasoning.encrypted", data: "x" }] }),
    ).toEqual({ text: null, encryptedBlocks: 1 });
  });
});

describe("resultLink", () => {
  it("recognizes the harness's success messages", () => {
    expect(resultLink("post_message", "Posted as #12.", null)).toEqual({ kind: "post", id: 12 });
    expect(resultLink("write_deliverable", "Saved as v3; replaced v2, written by Tern at step 25.", null)).toEqual({
      kind: "version",
      version: 3,
    });
    expect(resultLink("read_deliverable", "Deliverable v5, written by Heron at step 35:\n\ntext", null)).toEqual({
      kind: "version",
      version: 5,
    });
    expect(
      resultLink("read_document", '03-budget-memo · "Evening Hours: Options and Costs" · 1,541 words\n\n# Evening', null),
    ).toEqual({ kind: "doc", id: "03-budget-memo", title: "Evening Hours: Options and Costs", words: 1541 });
  });

  it("returns null for errors and other results", () => {
    expect(resultLink("post_message", "Post is 1,116 characters; the limit is 800.", "Post is 1,116 characters")).toBeNull();
    expect(resultLink("read_board", "No new posts.", null)).toBeNull();
    expect(resultLink("read_deliverable", "The deliverable is empty.", null)).toBeNull();
  });
});

describe("collapsing and formatting", () => {
  it("collapses document bodies and long results", () => {
    expect(startsCollapsed("read_document", "a\nb", null)).toBe(true);
    expect(startsCollapsed("read_document", "There is no document", "There is no document")).toBe(false);
    expect(startsCollapsed("read_board", Array.from({ length: 13 }, () => "x").join("\n"), null)).toBe(true);
    expect(startsCollapsed("read_board", Array.from({ length: 12 }, () => "x").join("\n"), null)).toBe(false);
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\nb\n")).toBe(3);
  });

  it("formats arguments compactly", () => {
    expect(compactArguments({ id: "03-budget-memo" })).toBe('id: "03-budget-memo"');
    expect(compactArguments({ text: "hello", reply_to: 4 }, ["text"])).toBe("reply_to: 4");
    expect(compactArguments({ text: "x".repeat(100) }, [], 10)).toBe('text: "xxxxxxxx…');
  });

  it("formats numbers, deltas, and short doc ids", () => {
    expect(formatInt(1234567)).toBe("1,234,567");
    expect(formatDelta(1200)).toBe("+1,200");
    expect(formatDelta(-45)).toBe("−45");
    expect(formatDelta(0)).toBe("±0");
    expect(shortDocId("06-radio-interview")).toBe("06");
    expect(shortDocId("budget")).toBe("budget");
    expect(unreadSummary(["06-radio-interview", "08-eastside"])).toBe("unread: 06, 08");
    expect(unreadSummary([])).toBe("every document opened");
  });
});
