import { describe, expect, it } from "vitest";
import { firstDifference, normalizeForComparison } from "../src/shared/compare.ts";
import type { RunEvent } from "../src/shared/events.ts";
import { LogBuilder } from "./fixtures/derive/log-builder.ts";

function originalLog(): RunEvent[] {
  const log = new LogBuilder(["Heron", "Otter"], ["d1", "d2"]);
  log.startTick(1, ["Otter", "Heron"]);
  log.call("Otter");
  log.post("Otter", "I'll take d1.");
  log.call("Heron");
  log.readBoard("Heron", [1]);
  log.end("tick_cap");
  return log.events;
}

/** The same log as an offline re-run would write it: new run id, folder paths, mode, timing, and cache hits. */
function rerunOf(events: RunEvent[]): RunEvent[] {
  return structuredClone(events).map((event) => {
    event.at = "2026-09-29T08:00:00.000Z";
    switch (event.type) {
      case "run_started":
        event.run_id = "example-20260929-080000-s1";
        event.config.task = "runs/example-20260929-080000-s1/task";
        event.config.environment.prompt_template = "runs/example-20260929-080000-s1/prompt.md";
        event.model_info = { id: "test/model", catalog: { id: "test/model" }, endpoint: { tag: "fake/fp8" } };
        event.mode = "offline";
        break;
      case "model_call":
        event.cache_hit = true;
        event.latency_ms = 3;
        break;
      case "run_ended":
        event.totals.cache_hits = event.totals.model_calls + 2;
        break;
    }
    return event;
  });
}

describe("normalizeForComparison", () => {
  it("strips timing, cache hits, the run id, the mode, the catalog lookup, and run-folder paths", () => {
    const events = originalLog();
    const [started, , call] = normalizeForComparison(events);
    expect(started).not.toHaveProperty("at");
    expect(started).not.toHaveProperty("run_id");
    expect(started).not.toHaveProperty("mode");
    expect(started).not.toHaveProperty("model_info");
    expect(started).toHaveProperty("seq", 0);
    const config = started!.config as Record<string, Record<string, unknown>>;
    expect(config).not.toHaveProperty("task");
    expect(config.environment).not.toHaveProperty("prompt_template");
    expect(config.environment).toHaveProperty("doc_read_budget", 2);
    expect(call).not.toHaveProperty("latency_ms");
    expect(call).not.toHaveProperty("cache_hit");
    expect(call).toHaveProperty("cache_key");
    const ended = normalizeForComparison(events).at(-1)!;
    expect(ended.totals).not.toHaveProperty("cache_hits");
    expect(ended.totals).toHaveProperty("model_calls");
  });

  it("leaves the events it was given untouched", () => {
    const events = originalLog();
    const before = structuredClone(events);
    normalizeForComparison(events);
    expect(events).toEqual(before);
  });
});

describe("firstDifference", () => {
  it("is null for a run and its exact re-run", () => {
    const events = originalLog();
    expect(firstDifference(events, rerunOf(events))).toBeNull();
    expect(normalizeForComparison(rerunOf(events))).toEqual(normalizeForComparison(events));
  });

  it("points at the first differing value, with its path", () => {
    const events = originalLog();
    const changed = rerunOf(events);
    const post = changed.find((event) => event.type === "post_created")!;
    if (post.type !== "post_created") throw new Error("unreachable");
    post.post.text = "I'll take d2.";
    const delivered = changed.find((event) => event.type === "board_delivered")!;
    if (delivered.type !== "board_delivered") throw new Error("unreachable");
    delivered.post_ids = [];
    expect(firstDifference(events, changed)).toEqual({ seq: post.seq, path: "post.text", a: "I'll take d1.", b: "I'll take d2." });
  });

  it("indexes into arrays and reports keys only one side has", () => {
    const events = originalLog();
    const changed = rerunOf(events);
    const delivered = changed.find((event) => event.type === "board_delivered")!;
    if (delivered.type !== "board_delivered") throw new Error("unreachable");
    delivered.post_ids = [1, 2];
    expect(firstDifference(events, changed)).toEqual({ seq: delivered.seq, path: "post_ids[1]", a: undefined, b: 2 });

    const extra = rerunOf(events);
    (extra[0] as unknown as Record<string, unknown>).note = "added";
    expect(firstDifference(events, extra)).toEqual({ seq: 0, path: "note", a: undefined, b: "added" });
  });

  it("reports a log that ends early at the first missing event", () => {
    const events = originalLog();
    const short = events.slice(0, -1);
    const difference = firstDifference(short, events);
    expect(difference).toMatchObject({ seq: events.length - 1, path: "", a: undefined });
    expect(difference!.b).toMatchObject({ type: "run_ended" });
    expect(firstDifference(events, short)).toMatchObject({ seq: events.length - 1, b: undefined });
  });
});
