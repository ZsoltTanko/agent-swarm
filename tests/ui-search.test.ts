import { describe, expect, it } from "vitest";
import { deriveRunState } from "../src/shared/derive.ts";
import type { RunEvent } from "../src/shared/events.ts";
import type { SearchHit } from "../src/ui/contract.ts";
import { buildSearchIndex, makeSnippet, pickHitPatch, SEARCH_KINDS, searchIndex } from "../src/ui/search.ts";
import { LogBuilder } from "./fixtures/derive/log-builder.ts";
import { runScripted } from "./helpers/scripted-run.ts";

function smallLog(): RunEvent[] {
  const log = new LogBuilder(["Heron", "Otter"], ["a", "b"]);
  log.startTick(1, ["Heron", "Otter"]);
  log.call("Heron");
  log.post("Heron", "Heron here. I will take the Budget memo.");
  log.call("Otter");
  log.openDoc("Otter", "a", true, 1);
  log.startTick(2, ["Otter", "Heron"]);
  log.call("Otter");
  log.write("Otter", "Draft: the budget is tight.", true);
  log.call("Heron");
  log.post("Heron", "Otter, see the BUDGET numbers.", 1);
  log.end("tick_cap");
  // Give Otter's document read a body and a status line, the way the engine logs it.
  for (const event of log.events) {
    if (event.type === "tool_call" && event.name === "read_document") {
      event.result = 'a · "a" · 100 words\n\nThe budget document body.\n\n[step 1/10 · 1 unread post · 1 document read left]';
    }
    if (event.type === "tool_call" && event.name === "write_deliverable") {
      event.result = "Saved as v1; replaced the empty deliverable.\n\n[step 2/10 · 0 unread posts · 1 document read left]";
    }
  }
  return log.events;
}

function hitsFor(events: RunEvent[], tick: number, query: string) {
  const state = deriveRunState(events, tick);
  return searchIndex(buildSearchIndex(events, state), query);
}

describe("buildSearchIndex / searchIndex", () => {
  it("finds posts, agent text, and deliverable versions case-insensitively, grouped by kind", () => {
    const { hits, total } = hitsFor(smallLog(), 2, "budget");
    expect(total).toBe(hits.length);
    expect(hits.map((hit) => hit.kind)).toEqual(["post", "post", "deliverable"]);
    expect(hits[0]!.label).toBe("Post #1 · Heron · step 1");
    expect(hits[0]!.selection).toEqual({ kind: "post", id: 1 });
    expect(hits[1]!.tick).toBe(2);
    expect(hits[2]!.label).toBe("v1 · Otter · step 2");
    expect(hits[2]!.selection).toEqual({ kind: "version", version: 1 });
    for (const hit of hits) {
      expect(hit.snippet.slice(hit.match.start, hit.match.end).toLowerCase()).toBe("budget");
    }
  });

  it("skips document bodies and status lines but keeps other tool results", () => {
    const events = smallLog();
    expect(hitsFor(events, 2, "document body").hits).toEqual([]);
    expect(hitsFor(events, 2, "unread").hits).toEqual([]);
    const saved = hitsFor(events, 2, "Saved as v1").hits;
    expect(saved).toHaveLength(1);
    expect(saved[0]!.kind).toBe("tool_result");
    expect(saved[0]!.label).toBe("Otter · step 2 · write_deliverable result");
    expect(saved[0]!.selection).toEqual({ kind: "step", agent: "Otter", tick: 2 });
  });

  it("doesn't index read_board and read_deliverable results, which repeat posts and versions", () => {
    const log = new LogBuilder(["Heron", "Otter"], ["a"]);
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.post("Heron", "The budget memo matters.");
    log.startTick(2, ["Otter"]);
    log.call("Otter");
    log.readBoard("Otter", [1]);
    log.readDeliverable("Otter", 0);
    for (const event of log.events) {
      if (event.type === "tool_call" && event.name === "read_board") event.result = "1 new post:\n#1 Heron (step 1): The budget memo matters.";
      if (event.type === "tool_call" && event.name === "read_deliverable") event.result = "The deliverable is empty; budget it.";
    }
    log.end("tick_cap");
    expect(hitsFor(log.events, 2, "budget").hits.map((hit) => hit.kind)).toEqual(["post"]);
  });

  it("doesn't index wait's acknowledgment, but keeps a failed wait", () => {
    const log = new LogBuilder(["Heron", "Otter"], ["a"]);
    log.startTick(1, ["Heron", "Otter"]);
    log.call("Heron");
    log.tool("Heron", "wait");
    log.sleep("Heron", "wait");
    log.call("Otter");
    log.tool("Otter", "wait", { until: "later" }, "wait takes no arguments.");
    for (const event of log.events) {
      if (event.type === "tool_call" && event.name === "wait" && event.error === null) {
        event.result = "You'll wait until another agent posts.\n\n[step 1/10 · 0 unread posts · 1 document read left]";
      }
    }
    log.end("tick_cap");
    expect(hitsFor(log.events, 1, "until another agent").hits).toEqual([]);
    const failed = hitsFor(log.events, 1, "no arguments").hits;
    expect(failed.map((hit) => hit.label)).toEqual(["Otter · step 1 · wait result"]);
  });

  it("indexes assistant content as agent text and selects the step", () => {
    const { hits } = hitsFor(smallLog(), 2, "otter thinking at 2");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("agent_text");
    expect(hits[0]!.selection).toEqual({ kind: "step", agent: "Otter", tick: 2 });
    expect(hits[0]!.agent).toBe("Otter");
  });

  it("sees nothing after the selected tick", () => {
    const { hits } = hitsFor(smallLog(), 1, "budget");
    expect(hits.map((hit) => hit.label)).toEqual(["Post #1 · Heron · step 1"]);
    expect(hitsFor(smallLog(), 1, "thinking at 2").hits).toEqual([]);
  });

  it("indexes reasoning from a scripted run", async () => {
    const { events } = await runScripted(["Heron", "Otter"]);
    const { hits } = hitsFor(events, Infinity, "who else is on the board");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.kind === "reasoning")).toBe(true);
  });

  it("caps the hits and reports the total", () => {
    const log = new LogBuilder(["Heron"], ["a"]);
    log.startTick(1, ["Heron"]);
    log.call("Heron");
    for (let i = 0; i < 70; i++) log.post("Heron", `note ${i}`);
    const { hits, total } = hitsFor(log.events, 1, "note");
    expect(hits).toHaveLength(60);
    expect(total).toBeGreaterThanOrEqual(70);
  });

  it("returns nothing for a blank query and treats regex characters literally", () => {
    expect(hitsFor(smallLog(), 2, "   ").hits).toEqual([]);
    expect(hitsFor(smallLog(), 2, "memo.").hits).toHaveLength(1);
    expect(hitsFor(smallLog(), 2, "(budget").hits).toEqual([]);
  });

  it("orders kinds as SEARCH_KINDS", () => {
    expect(SEARCH_KINDS).toEqual(["post", "deliverable", "agent_text", "reasoning", "tool_result"]);
  });
});

describe("makeSnippet", () => {
  it("cuts around the match with ellipses and collapses whitespace", () => {
    const text = `${"a".repeat(100)}\n\nNeedle\n  here ${"b".repeat(200)}`;
    const start = text.indexOf("Needle");
    const { snippet, start: s, end: e } = makeSnippet(text, start, start + 6, 10, 20);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.slice(s, e)).toBe("Needle");
    expect(snippet).not.toContain("\n");
  });

  it("cuts at word boundaries", () => {
    const text = "alpha beta gamma delta NEEDLE epsilon zeta eta theta";
    const start = text.indexOf("NEEDLE");
    const { snippet, start: s, end: e } = makeSnippet(text, start, start + 6, 9, 11);
    expect(snippet).toBe("…delta NEEDLE epsilon…");
    expect(snippet.slice(s, e)).toBe("NEEDLE");
  });

  it("keeps short texts whole", () => {
    const { snippet, start, end } = makeSnippet("find me", 0, 4);
    expect(snippet).toBe("find me");
    expect(snippet.slice(start, end)).toBe("find");
  });
});

describe("pickHitPatch", () => {
  const hit = (
    kind: SearchHit["kind"],
    tick: number,
    selection: SearchHit["selection"],
    agent = "Otter",
  ): SearchHit => ({ kind, label: "", agent, snippet: "", tick, selection });

  it("keeps the selected tick for a hit at or before it", () => {
    expect(pickHitPatch(hit("post", 3, { kind: "post", id: 2 }), 9, [])).toEqual({
      tick: 9,
      selection: { kind: "post", id: 2 },
    });
    expect(pickHitPatch(hit("post", 9, { kind: "post", id: 5 }), 9, [])).toMatchObject({ tick: 9 });
  });

  it("moves the scrubber forward to a hit after the selected tick", () => {
    expect(pickHitPatch(hit("post", 12, { kind: "post", id: 7 }), 9, [])).toMatchObject({ tick: 12 });
  });

  it("clears the board's author filter when it hides a picked post's author", () => {
    const post = hit("post", 3, { kind: "post", id: 2 }, "Newt");
    expect(pickHitPatch(post, 9, ["Heron", "Otter"])).toEqual({ tick: 9, selection: { kind: "post", id: 2 }, authors: [] });
    expect(pickHitPatch(post, 9, ["Newt", "Otter"])).not.toHaveProperty("authors");
    expect(pickHitPatch(post, 9, [])).not.toHaveProperty("authors");
    // Other hits don't show on the board, so the filter stays.
    const text = hit("agent_text", 3, { kind: "step", agent: "Newt", tick: 3 }, "Newt");
    expect(pickHitPatch(text, 9, ["Otter"])).not.toHaveProperty("authors");
  });

  it("opens the deliverable for a version hit", () => {
    expect(pickHitPatch(hit("deliverable", 4, { kind: "version", version: 2 }), 6, [])).toEqual({
      tick: 6,
      selection: { kind: "version", version: 2 },
      tab: "deliverable",
    });
  });

  it("opens the step's agent's transcript for a text, reasoning, or tool result hit", () => {
    for (const kind of ["agent_text", "reasoning", "tool_result"] as const) {
      expect(pickHitPatch(hit(kind, 2, { kind: "step", agent: "Otter", tick: 2 }), 5, [])).toEqual({
        tick: 5,
        selection: { kind: "step", agent: "Otter", tick: 2 },
        tab: "transcript",
        agent: "Otter",
      });
    }
  });
});
