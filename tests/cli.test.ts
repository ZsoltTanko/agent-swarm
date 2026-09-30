import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeForComparison } from "../src/shared/compare.ts";
import type { RunEvent } from "../src/shared/events.ts";
import { ZERO_USAGE } from "../src/shared/types.ts";
import { apiKeyFrom, formatCost, formatTick, main } from "../src/harness/cli.ts";
import { loadConfig } from "../src/harness/config.ts";
import { readEvents } from "../src/harness/eventlog.ts";
import { createRunDir, makeRunId, writeResolvedConfig } from "../src/harness/runs.ts";

const tmp = mkdtempSync(join(tmpdir(), "swarm-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const TEMPLATE = resolve("prompts/swarm.md");

let output: string[] = [];
beforeEach(() => {
  output = [];
  const capture = (...args: unknown[]) => void output.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

function writeTinyTask(): string {
  const dir = join(tmp, "tasks", "tiny");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "task.md"), "Write a short summary of the documents. Keep {braces} as they are.\n");
  writeFileSync(join(dir, "docs", "alpha.md"), "# Alpha\n\nThe alpha site opened in 2019.\n");
  writeFileSync(join(dir, "docs", "beta.md"), "# Beta\n\nThe beta site closed in 2021.\n");
  writeFileSync(join(dir, "docs", "gamma.txt"), "Gamma has no heading. It moved in 2020.\n");
  return dir;
}

function writeConfig(name: string, taskDir: string, extra = ""): string {
  const path = join(tmp, `${name}.yaml`);
  writeFileSync(
    path,
    `task: ${taskDir}
agents:
  count: 2
  model:
    id: scripted/model
    params:
      temperature: 0.7
      max_tokens: 2000
environment:
  doc_read_budget: 2
  prompt_template: ${TEMPLATE}
run:
  seed: 5
  tick_cap: 6
${extra}`,
  );
  return path;
}

describe("run ids and folders", () => {
  it("formats <task>-<UTC date>-<UTC time>-s<seed>", () => {
    const now = new Date(Date.UTC(2026, 8, 28, 9, 5, 7));
    expect(makeRunId("example", 3, now)).toBe("example-20260928-090507-s3");
    expect(makeRunId("my task/v2", 0, now)).toBe("my-task-v2-20260928-090507-s0");
  });

  it("appends -2, -3, ... when the folder exists", () => {
    const runsDir = join(tmp, "collisions");
    const first = createRunDir(runsDir, "t-20260928-090507-s1");
    const second = createRunDir(runsDir, "t-20260928-090507-s1");
    const third = createRunDir(runsDir, "t-20260928-090507-s1");
    expect([first.runId, second.runId, third.runId]).toEqual([
      "t-20260928-090507-s1",
      "t-20260928-090507-s1-2",
      "t-20260928-090507-s1-3",
    ]);
    expect(third.dir).toBe(join(runsDir, "t-20260928-090507-s1-3"));
    expect(readdirSync(runsDir).sort()).toEqual([first.runId, second.runId, third.runId]);
  });

  it("writes a resolved config that loads back unchanged", () => {
    const config = loadConfig("configs/baseline.yaml");
    const path = join(tmp, "resolved.yaml");
    writeResolvedConfig(path, config, "example-20260928-090507-s1", "--offline");
    const text = readFileSync(path, "utf8");
    expect(text.split("\n").slice(0, 2)).toEqual([
      `# Resolved config for run example-20260928-090507-s1. Re-run it exactly with: npm run swarm -- ${path} --offline`,
      "# task and prompt_template are relative to this file's folder.",
    ]);
    expect(loadConfig(path)).toEqual(config);
  });
});

describe("formatTick", () => {
  it("prints one aligned line per tick", () => {
    const summary = { tick: 3, active: 5, posts: 2, doc_opens: 1, writes: 0, asleep: 1, finished: 0, cache_hits: 2, cost_usd: 0.0123 };
    expect(formatTick(summary, 40)).toBe(
      "tick  3/40 · 5 active · 2 posts · 1 doc · 0 writes · 1 asleep · 0 finished · $0.0123 (2 cached)",
    );
    expect(formatTick({ ...summary, cache_hits: 0, writes: 1 }, 8)).toBe(
      "tick 3/8 · 5 active · 2 posts · 1 doc · 1 write · 1 asleep · 0 finished · $0.0123",
    );
  });
});

describe("formatCost", () => {
  const usage = { ...ZERO_USAGE, cost_usd: 0.1234 };
  const totals = { ticks: 4, model_calls: 10, cache_hits: 0, usage, posts: 0, deliverable_versions: 0 };
  const aborted = (cache_hit: boolean) => ({ agent: "Otter", cache_key: "k", cache_hit, usage: { ...ZERO_USAGE, cost_usd: 0.01 } });

  it("says when every call came from the cache, or how many did", () => {
    expect(formatCost({ totals, unapplied: [] }, "live")).toBe("$0.1234");
    expect(formatCost({ totals: { ...totals, cache_hits: 3 }, unapplied: [] }, "live")).toBe(
      "$0.1234 (3 of 10 calls from the cache)",
    );
    expect(formatCost({ totals: { ...totals, cache_hits: 10 }, unapplied: [] }, "live")).toBe(
      "$0.1234 (from the cache: nothing new was spent)",
    );
    expect(formatCost({ totals: { ...totals, cache_hits: 10 }, unapplied: [] }, "offline")).toBe(
      "$0.1234 (from the cache: nothing new was spent)",
    );
    expect(formatCost({ totals: { ...totals, model_calls: 0 }, unapplied: [] }, "offline")).toBe("$0.1234");
  });

  it("counts the unapplied responses of an aborted tick", () => {
    const all = { ...totals, cache_hits: 10 };
    expect(formatCost({ totals: all, unapplied: [aborted(false)] }, "live")).toBe(
      "$0.1234 (10 of 11 calls from the cache), including $0.0100 for 1 response of the aborted tick",
    );
    expect(formatCost({ totals: all, unapplied: [aborted(true)] }, "live")).toBe(
      "$0.1234 (from the cache: nothing new was spent), including $0.0100 for 1 response of the aborted tick",
    );
  });

  it("marks a scripted run's cost as simulated", () => {
    expect(formatCost({ totals, unapplied: [] }, "scripted")).toBe("$0.1234 (simulated)");
    expect(formatCost({ totals, unapplied: [aborted(false), aborted(false)] }, "scripted")).toBe(
      "$0.1234 (simulated), including $0.0200 for 2 responses of the aborted tick",
    );
  });
});

describe("main", () => {
  it("rejects bad arguments with the usage text", async () => {
    expect(await main([])).toBe(2);
    expect(output.join("\n")).toContain("Missing the config file.");
    expect(output.join("\n")).toContain("Usage: npm run swarm --");
    expect(await main(["a.yaml", "b.yaml"])).toBe(2);
    expect(await main(["a.yaml", "--bogus"])).toBe(2);
    expect(await main(["a.yaml", "--seed", "x"])).toBe(2);
  });

  it("prints config errors as one message without a stack", async () => {
    const path = join(tmp, "broken.yaml");
    writeFileSync(path, "task: x\nagents:\n  count: 2\n  model:\n    id: m\n    params:\n      stream: true\n");
    expect(await main([path, "--scripted"])).toBe(1);
    const text = output.join("\n");
    expect(text).toContain(`Error: Invalid config ${path}:\n  - agents.model.params.stream: set by the harness`);
    expect(text).not.toMatch(/\n\s+at /);
  });

  it("prints a missing task folder as a config error", async () => {
    expect(await main([writeConfig("no-task", join(tmp, "missing-task")), "--scripted"])).toBe(1);
    expect(output.join("\n")).toMatch(/^Error: Task folder .*missing-task does not exist\.$/m);
  });

  it("--dry-run renders the prompts and writes nothing", async () => {
    const runsDir = join(tmp, "dry-runs");
    const config = writeConfig("dry", writeTinyTask());
    expect(await main([config, "--scripted", "--dry-run", "--seed", "9", "--runs-dir", runsDir])).toBe(0);
    const text = output.join("\n");
    expect(text).toContain("Task tiny: 3 documents, 24 words");
    expect(text).toContain("seed: 9");
    expect(text).toMatch(/--- System prompt \(\w+\) ---\nYou are \w+\. You are one of several agents/);
    expect(text).toContain("<task>\nWrite a short summary of the documents. Keep {braces} as they are.\n</task>");
    expect(text).toContain("--- Kickoff ---\nCheck the board and introduce yourself before you start.");
    expect(text).toContain("read_board, post_message, list_documents, read_document");
    expect(existsSync(runsDir)).toBe(false);
  });

  it("runs a scripted swarm end to end, and its run.yaml re-runs to the same event log", async () => {
    const runsDir = join(tmp, "runs");
    const taskDir = writeTinyTask();
    const config = writeConfig("e2e", taskDir);

    expect(await main([config, "--scripted", "--runs-dir", runsDir])).toBe(0);
    const [runId] = readdirSync(runsDir);
    expect(runId).toMatch(/^tiny-\d{8}-\d{6}-s5$/);
    const runDir = join(runsDir, runId!);
    expect(readdirSync(runDir).sort()).toEqual(["deliverable.md", "events.jsonl", "prompt.md", "run.yaml", "task"]);
    expect(readFileSync(join(runDir, "prompt.md"))).toEqual(readFileSync(TEMPLATE));
    expect(readFileSync(join(runDir, "task", "task.md"))).toEqual(readFileSync(join(taskDir, "task.md")));
    expect(readdirSync(join(runDir, "task", "docs")).sort()).toEqual(["alpha.md", "beta.md", "gamma.txt"]);
    expect(output.join("\n")).toContain(`Run folder: ${runDir}`);

    const resolved = loadConfig(join(runDir, "run.yaml"));
    expect(resolved.task).toBe("task");
    expect(resolved.task_name).toBe("tiny");
    expect(resolved.environment.prompt_template).toBe("prompt.md");
    // A scripted run has no cache entries, so --offline couldn't re-run it.
    expect(readFileSync(join(runDir, "run.yaml"), "utf8")).toMatch(/^# .*Re-run it exactly with: npm run swarm -- \S+run\.yaml --scripted\n/);
    expect(resolved.run.seed).toBe(5);
    expect(resolved.agents.model.params).toEqual({ temperature: 0.7, max_tokens: 2000 });
    // The names drawn by seed are recorded, so re-runs never depend on the name pool.
    const drawn = readEvents(join(runDir, "events.jsonl"))[0]!;
    expect(drawn.type === "run_started" && resolved.agents.names).toEqual(
      drawn.type === "run_started" ? drawn.agents.map((agent) => agent.name) : null,
    );

    const events = readEvents(join(runDir, "events.jsonl"));
    const first = events[0]!;
    const last = events.at(-1)!;
    expect(first.type).toBe("run_started");
    expect(last.type).toBe("run_ended");
    if (first.type !== "run_started" || last.type !== "run_ended") throw new Error("unreachable");
    expect(first.run_id).toBe(runId);
    expect(first.config).toEqual(resolved);
    expect(first.task.name).toBe("tiny");
    expect(first.task.docs.map((doc) => doc.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(first.mode).toBe("scripted");
    expect(first.model_info).toBeNull();
    expect(Object.values(first.system_prompts)[0]).toContain("Keep {braces} as they are.");
    expect(output.join("\n")).toMatch(/^Cost: {3}\$\d+\.\d{4} \(simulated\)$/m);

    const writes = events.filter((event) => event.type === "deliverable_written");
    const finalText = writes.at(-1)?.type === "deliverable_written" ? writes.at(-1)!.version.text : "";
    expect(readFileSync(join(runDir, "deliverable.md"), "utf8")).toBe(finalText);

    output = [];
    expect(await main([join(runDir, "run.yaml"), "--scripted", "--runs-dir", runsDir])).toBe(0);
    const rerunId = readdirSync(runsDir).find((id) => id !== runId)!;
    expect(rerunId).toMatch(/^tiny-\d{8}-\d{6}-s5(-2)?$/);
    const rerunEvents = readEvents(join(runsDir, rerunId, "events.jsonl"));
    expect(normalizeForComparison(rerunEvents)).toEqual(normalizeForComparison(events));
    expect(rerunEvents[0]).toMatchObject({ run_id: rerunId, task: { name: "tiny" } });
    expect(output).toContain(`Re-run of ${runId}: the event logs are compared at the end.`);
    expect(output).toContain(`Re-run matches ${runId}: ${events.length} events identical`);
    expect(readFileSync(join(runsDir, rerunId, "deliverable.md"), "utf8")).toBe(finalText);
  });

  it("--offline logs an offline run, and a cache miss ends it with api_error", async () => {
    const runsDir = join(tmp, "offline-runs");
    const cacheDir = join(tmp, "empty-cache");
    const config = writeConfig("offline", writeTinyTask());
    expect(await main([config, "--offline", "--runs-dir", runsDir, "--cache-dir", cacheDir])).toBe(1);
    const [runId] = readdirSync(runsDir);
    const events = readEvents(join(runsDir, runId!, "events.jsonl"));
    expect(events[0]).toMatchObject({ type: "run_started", mode: "offline", model_info: null });
    expect(events.at(-1)).toMatchObject({ type: "run_ended", reason: "api_error", unapplied: [] });
    const text = output.join("\n");
    expect(text).toMatch(/Error: Offline and no cached response for \w+ at tick 1/);
    expect(text).toContain("Cost:   $0.0000\n");
  });

  it("exits 3 when a re-run's log differs from the original's, and compares nothing under a new seed", async () => {
    const runsDir = join(tmp, "mismatch-runs");
    expect(await main([writeConfig("mismatch", writeTinyTask()), "--scripted", "--runs-dir", runsDir])).toBe(0);
    const [runId] = readdirSync(runsDir);
    const runDir = join(runsDir, runId!);
    const eventsPath = join(runDir, "events.jsonl");
    const events = readEvents(eventsPath);
    const post = events.find((event) => event.type === "post_created")!;
    if (post.type !== "post_created") throw new Error("unreachable");
    const originalText = post.post.text;
    post.post.text = "Edited after the fact.";
    writeFileSync(eventsPath, events.map((event) => `${JSON.stringify(event)}\n`).join(""));

    output = [];
    expect(await main([join(runDir, "run.yaml"), "--scripted", "--runs-dir", runsDir])).toBe(3);
    expect(output).toContain(`Re-run differs from ${runId} at seq ${post.seq} (post_created), post.text:`);
    expect(output).toContain('  original: "Edited after the fact."');
    expect(output).toContain(`  re-run:   ${JSON.stringify(originalText)}`);

    output = [];
    expect(await main([join(runDir, "run.yaml"), "--scripted", "--seed", "6", "--runs-dir", runsDir])).toBe(0);
    expect(output.join("\n")).not.toContain("Re-run");
  });

  it("re-runs a moved or copied run folder from its own snapshot", async () => {
    const runsDir = join(tmp, "moving-runs");
    expect(await main([writeConfig("moving", writeTinyTask()), "--scripted", "--runs-dir", runsDir])).toBe(0);
    const [runId] = readdirSync(runsDir);
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const moved = join(elsewhere, "moved-run");
    renameSync(join(runsDir, runId!), moved);
    const rerunsDir = join(tmp, "moved-reruns");

    output = [];
    expect(await main([join(moved, "run.yaml"), "--scripted", "--runs-dir", rerunsDir])).toBe(0);
    expect(output.join("\n")).toMatch(/Re-run matches moved-run: \d+ events identical/);

    // A copy whose task was edited re-runs from the copy's snapshot, so its log differs.
    const edited = join(elsewhere, "edited-run");
    cpSync(moved, edited, { recursive: true });
    writeFileSync(join(edited, "task", "task.md"), "An edited task.\n");
    output = [];
    expect(await main([join(edited, "run.yaml"), "--scripted", "--runs-dir", rerunsDir])).toBe(3);
    expect(output.join("\n")).toContain("Re-run differs from edited-run at seq 0 (run_started), task.text:");
  });

  it("compares a re-run of a cut-short run up to where the original stopped", async () => {
    const runsDir = join(tmp, "cut-runs");
    expect(await main([writeConfig("cut", writeTinyTask()), "--scripted", "--runs-dir", runsDir])).toBe(0);
    const [runId] = readdirSync(runsDir);
    const eventsPath = join(runsDir, runId!, "events.jsonl");
    const complete = readEvents(eventsPath);
    const tick3 = complete.findIndex((event) => event.type === "tick_started" && event.tick === 3);
    expect(tick3).toBeGreaterThan(0);
    // What the engine writes when Ctrl-C lands during tick 3's calls.
    const cutShort = (kept: RunEvent[]): string =>
      [
        ...kept,
        {
          seq: kept.length,
          tick: 3,
          at: kept.at(-1)!.at,
          type: "run_ended",
          reason: "interrupted",
          error: null,
          totals: { ticks: 3, model_calls: 0, cache_hits: 0, usage: ZERO_USAGE, posts: 0, deliverable_versions: 0 },
          unapplied: [],
        },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join("");
    const kept = complete.slice(0, tick3 + 1);
    writeFileSync(eventsPath, cutShort(kept));

    output = [];
    expect(await main([join(runsDir, runId!, "run.yaml"), "--scripted", "--runs-dir", runsDir])).toBe(0);
    expect(output).toContain(`Re-run matches ${runId} up to its interrupted at tick 3: ${kept.length} events identical`);

    const post = kept.find((event) => event.type === "post_created")!;
    if (post.type !== "post_created") throw new Error("unreachable");
    post.post.text = "Edited after the fact.";
    writeFileSync(eventsPath, cutShort(kept));
    output = [];
    expect(await main([join(runsDir, runId!, "run.yaml"), "--scripted", "--runs-dir", runsDir])).toBe(3);
    expect(output).toContain(`Re-run differs from ${runId} at seq ${post.seq} (post_created), post.text:`);
  });
});

describe("apiKeyFrom", () => {
  it("trims the key, and requires it only when the run needs it", () => {
    expect(apiKeyFrom("  sk-or-v1-abc \n", true)).toBe("sk-or-v1-abc");
    expect(apiKeyFrom(undefined, false)).toBeNull();
    expect(() => apiKeyFrom("   ", true)).toThrow(/OPENROUTER_API_KEY is not set/);
  });

  it("rejects a key that can't be sent in a header, without quoting it", () => {
    const key = "sk-or-v1-FAKEKEY\nsecond-line";
    expect(() => apiKeyFrom(key, true)).toThrow(/can't be sent in an HTTP header/);
    expect(() => apiKeyFrom(key, true)).not.toThrow(/FAKEKEY|second-line/);
    expect(apiKeyFrom(key, false)).toBe(key);
  });
});
