import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResponseCache } from "../src/harness/cache.ts";
import { createApp } from "../src/server/app.ts";
import { summarizeRun, tailEvents } from "../src/server/runs.ts";
import { STALE_AFTER_MS, staleAfterMs } from "../src/shared/api.ts";
import type { CachedCall, DocumentResponse, RunDetail, RunSummary, StreamEndData } from "../src/shared/api.ts";
import { RunConfigSchema } from "../src/shared/config.ts";
import type { RunEndedEvent, RunEvent, RunEventPayload, RunMode } from "../src/shared/events.ts";
import type { DocMeta, Usage } from "../src/shared/types.ts";

/* ---------- Fabricated runs ---------- */

const AGENTS = ["Heron", "Otter"] as const;
const DOC: DocMeta = {
  id: "alpha",
  filename: "alpha.md",
  title: "Alpha",
  words: 3,
  chars: 19,
  sha256: "0".repeat(64),
};
const DOC_TEXT = "# Alpha\n\nFirst doc.\n";
const CALL_USAGE: Usage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  reasoning_tokens: 50,
  cached_tokens: 0,
  cost_usd: 0.001,
};

/** Assigns seq and at like the harness's log writer; `at` counts seconds from `startedAt`. */
function eventLog(startedAt: string) {
  let seq = 0;
  const base = Date.parse(startedAt);
  return (tick: number, payload: RunEventPayload): RunEvent =>
    ({ seq, tick, at: new Date(base + 1000 * seq++).toISOString(), ...payload }) as RunEvent;
}
type EmitEvent = ReturnType<typeof eventLog>;

function runStarted(emit: EmitEvent, runId: string, mode: RunMode = "live"): RunEvent {
  const config = RunConfigSchema.parse({
    task: `runs/${runId}/task`,
    agents: { count: AGENTS.length, model: { id: "deepseek/deepseek-v4-flash", params: { max_tokens: 8000 } } },
    run: { seed: 7, tick_cap: 5 },
  });
  return emit(0, {
    type: "run_started",
    run_id: runId,
    config,
    seed: 7,
    agents: AGENTS.map((name, index) => ({ name, index, model: config.agents.model.id })),
    task: { name: "example", text: "Summarize the documents.", docs: [DOC] },
    system_prompts: Object.fromEntries(AGENTS.map((name) => [name, `You are ${name}.`])),
    kickoff: "Check the board and introduce yourself before you start.",
    tools: [],
    mode,
    model_info: null,
  });
}

/** One tick: Otter posts, then Heron reads the board and receives the post. */
function tick(emit: EmitEvent, tickNumber: number, postId: number): RunEvent[] {
  const call = (agent: string, orderIndex: number, name: string, args: string) =>
    emit(tickNumber, {
      type: "model_call",
      agent,
      order_index: orderIndex,
      cache_key: "a".repeat(64),
      cache_hit: false,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `${agent}-${tickNumber}`, type: "function", function: { name, arguments: args } }],
      },
      finish_reason: "tool_calls",
      native_finish_reason: "tool_calls",
      truncated: false,
      usage: CALL_USAGE,
      provider: "test",
      openrouter_metadata: null,
      system_fingerprint: null,
      generation_id: null,
      latency_ms: 1200,
      attempts: 1,
      request_messages: 2,
    });
  const toolCall = (agent: string, name: string, args: string, result: string) =>
    emit(tickNumber, {
      type: "tool_call",
      agent,
      call_id: `${agent}-${tickNumber}`,
      index: 0,
      name,
      raw_arguments: args,
      arguments: JSON.parse(args) as Record<string, unknown>,
      result,
      error: null,
    });
  const postArgs = JSON.stringify({ text: `Hello from step ${tickNumber}` });
  return [
    emit(tickNumber, { type: "tick_started", active: [...AGENTS], order: ["Otter", "Heron"], asleep: [], finished: [] }),
    call("Otter", 0, "post_message", postArgs),
    emit(tickNumber, {
      type: "post_created",
      post: { id: postId, author: "Otter", tick: tickNumber, text: `Hello from step ${tickNumber}`, reply_to: null },
    }),
    toolCall("Otter", "post_message", postArgs, `Posted as #${postId}.`),
    call("Heron", 1, "read_board", "{}"),
    emit(tickNumber, { type: "board_delivered", agent: "Heron", post_ids: [postId] }),
    toolCall("Heron", "read_board", "{}", `#${postId} Otter: Hello`),
  ];
}

function runEnded(emit: EmitEvent, ticks: number): RunEvent {
  return emit(ticks, {
    type: "run_ended",
    reason: "all_done",
    error: null,
    totals: {
      ticks,
      model_calls: ticks * 2,
      cache_hits: 0,
      usage: { ...CALL_USAGE, cost_usd: 0.002 * ticks },
      posts: ticks,
      deliverable_versions: 0,
    },
    unapplied: [],
  });
}

function jsonl(events: readonly RunEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

/** A run folder with its task snapshot; the log holds run_started plus `ticks` ticks, and run_ended if `ended`. */
async function fabricateRun(
  runsDir: string,
  id: string,
  startedAt: string,
  ticks: number,
  ended: boolean,
  mode: RunMode = "live",
) {
  const dir = join(runsDir, id);
  await mkdir(join(dir, "task", "docs"), { recursive: true });
  await writeFile(join(dir, "run.yaml"), `task: runs/${id}/task\n`);
  await writeFile(join(dir, "prompt.md"), "You are {name}.\n");
  await writeFile(join(dir, "task", "task.md"), "Summarize the documents.\n");
  await writeFile(join(dir, "task", "docs", DOC.filename), DOC_TEXT);
  const emit = eventLog(startedAt);
  const events = [runStarted(emit, id, mode)];
  for (let t = 1; t <= ticks; t++) events.push(...tick(emit, t, t));
  if (ended) {
    events.push(runEnded(emit, ticks));
    await writeFile(join(dir, "deliverable.md"), "# Final\n");
  }
  await writeFile(join(dir, "events.jsonl"), jsonl(events));
  return { dir, emit, events };
}

/* ---------- SSE client ---------- */

interface SseMessage {
  event: string;
  data: string;
  id: string | undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms)),
  ]);
}

class SseReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  /** The next message (comments skipped), or null when the stream has closed. */
  async next(timeoutMs = 5000): Promise<SseMessage | null> {
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const block = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const message: SseMessage = { event: "message", data: "", id: undefined };
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = line.slice(0, colon);
          const value = line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") message.event = value;
          else if (field === "data") data.push(value);
          else if (field === "id") message.id = value;
        }
        if (data.length === 0) continue;
        message.data = data.join("\n");
        return message;
      }
      const { done, value } = await withTimeout(this.reader.read(), timeoutMs, "an SSE message");
      if (done) return null;
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async nextEvents(): Promise<RunEvent[]> {
    const message = await this.next();
    expect(message?.event).toBe("events");
    return JSON.parse(message!.data) as RunEvent[];
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

/* ---------- Tests ---------- */

const MINUTE = 60_000;

let root: string;
let runsDir: string;
let cacheDir: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "swarm-server-test-"));
  runsDir = join(root, "runs");
  cacheDir = join(root, "cache");
  await mkdir(runsDir, { recursive: true });
  await fabricateRun(runsDir, "run-ended", "2026-09-01T10:00:00.000Z", 2, true);
  await fabricateRun(runsDir, "run-live", "2026-09-03T10:00:00.000Z", 1, false);
  const stale = await fabricateRun(runsDir, "run-stale", "2026-09-02T10:00:00.000Z", 1, false);
  // Longer than any tick could take at the default timeouts and retries (about 76 minutes).
  const longAgo = new Date(Date.now() - 120 * MINUTE);
  await utimes(join(stale.dir, "events.jsonl"), longAgo, longAgo);
  // Neither has a run_started yet, so neither is listed.
  await mkdir(join(runsDir, "run-empty"));
  await writeFile(join(runsDir, "run-empty", "events.jsonl"), "");
  await mkdir(join(runsDir, "not-a-run"));
  await writeFile(join(runsDir, ".DS_Store"), "");
  app = createApp({ runsDir, cacheDir });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function getJson<T>(path: string, status = 200): Promise<T> {
  const response = await app.request(path);
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

describe("run listing", () => {
  it("lists started runs newest first with running, ended, and stale status", async () => {
    const runs = await getJson<RunSummary[]>("/api/runs");
    expect(runs.map((run) => [run.id, run.status])).toEqual([
      ["run-live", "running"],
      ["run-stale", "stale"],
      ["run-ended", "ended"],
    ]);
  });

  it("summarizes an ended run from its log", async () => {
    const detail = await getJson<RunDetail>("/api/runs/run-ended");
    expect(detail.summary).toEqual({
      id: "run-ended",
      task: "example",
      model: "deepseek/deepseek-v4-flash",
      seed: 7,
      agents: 2,
      mode: "live",
      status: "ended",
      latest_tick: 2,
      tick_cap: 5,
      cost_usd: 0.004,
      posts: 2,
      deliverable_versions: 0,
      end_reason: "all_done",
      started_at: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-01T10:00:15.000Z",
    } satisfies RunSummary);
    expect(detail.run_yaml).toBe("task: runs/run-ended/task\n");
  });

  it("carries the run's mode, so scripted and offline costs aren't read as spend", async () => {
    for (const mode of ["scripted", "offline"] as const) {
      const dir = join(runsDir, `run-${mode}`);
      await fabricateRun(runsDir, `run-${mode}`, "2026-08-02T00:00:00.000Z", 1, true, mode);
      expect(await summarizeRun(dir)).toMatchObject({ id: `run-${mode}`, mode, status: "ended" });
      await rm(dir, { recursive: true });
    }
    const listed = await getJson<RunSummary[]>("/api/runs");
    expect(listed.map((run) => [run.id, run.mode])).toContainEqual(["run-ended", "live"]);
  });

  it("summarizes a running run and follows its growth", async () => {
    const dir = join(runsDir, "run-growing");
    const { emit } = await fabricateRun(runsDir, "run-growing", "2026-08-01T00:00:00.000Z", 1, false);
    const before = await summarizeRun(dir);
    expect(before).toMatchObject({ status: "running", latest_tick: 1, posts: 1, end_reason: null });
    expect(before?.cost_usd).toBeCloseTo(0.002);
    await appendFile(join(dir, "events.jsonl"), jsonl(tick(emit, 2, 2)));
    expect(await summarizeRun(dir)).toMatchObject({ status: "running", latest_tick: 2, posts: 2 });
    await rm(dir, { recursive: true });
  });

  it("returns 404 for unknown runs and runs that haven't started", async () => {
    expect((await getJson<{ error: string }>("/api/runs/nope", 404)).error).toBeTruthy();
    await getJson("/api/runs/run-empty", 404);
    await getJson("/api/runs/not-a-run", 404);
  });

  it("keeps a quiet run running while one of its calls could still be timing out and retrying", async () => {
    const dir = join(runsDir, "run-quiet");
    await fabricateRun(runsDir, "run-quiet", "2026-08-03T00:00:00.000Z", 1, false);
    const quiet = new Date(Date.now() - 11 * MINUTE);
    await utimes(join(dir, "events.jsonl"), quiet, quiet);
    expect(await summarizeRun(dir)).toMatchObject({ status: "running" });
    await rm(dir, { recursive: true });
  });

  it("lists only folders the run routes accept, spaces included", async () => {
    await fabricateRun(runsDir, "run-ended copy", "2026-07-01T00:00:00.000Z", 1, true);
    await fabricateRun(runsDir, "run+plus", "2026-07-02T00:00:00.000Z", 1, true);
    const ids = (await getJson<RunSummary[]>("/api/runs")).map((run) => run.id);
    expect(ids).toContain("run-ended copy");
    expect(ids).not.toContain("run+plus");
    expect((await getJson<RunDetail>("/api/runs/run-ended%20copy")).summary.id).toBe("run-ended copy");
    expect(await getJson<RunEvent[]>("/api/runs/run-ended%20copy/events")).toHaveLength(9);
    await rm(join(runsDir, "run-ended copy"), { recursive: true });
    await rm(join(runsDir, "run+plus"), { recursive: true });
  });
});

describe("staleAfterMs", () => {
  const config = (run: Record<string, number>, count = 2) =>
    RunConfigSchema.parse({ task: "t", agents: { count, model: { id: "m" } }, run });

  it("allows every attempt of a call to time out, with full backoff between attempts", () => {
    // 7 attempts × 600 s + 6 backoffs × 61 s.
    expect(staleAfterMs(config({}))).toBe(4_566_000);
    // Calls beyond max_concurrency wait for a slot: three waves.
    expect(staleAfterMs(config({ max_concurrency: 4 }, 12))).toBe(3 * 4_566_000);
  });

  it("is never less than STALE_AFTER_MS", () => {
    expect(staleAfterMs(config({ call_timeout_s: 60, max_retries: 1 }))).toBe(STALE_AFTER_MS);
  });
});

describe("run resources", () => {
  it("returns the events of a run", async () => {
    const events = await getJson<RunEvent[]>("/api/runs/run-ended/events");
    expect(events.map((event) => event.seq)).toEqual([...Array(16).keys()]);
    expect(events[0]?.type).toBe("run_started");
    expect(events.at(-1)?.type).toBe("run_ended");
  });

  it("ignores a partial trailing line", async () => {
    const dir = join(runsDir, "run-partial");
    await fabricateRun(runsDir, "run-partial", "2026-08-02T00:00:00.000Z", 1, false);
    await appendFile(join(dir, "events.jsonl"), '{"seq":8,"tick":2,"at":"2026');
    const events = await getJson<RunEvent[]>("/api/runs/run-partial/events");
    expect(events).toHaveLength(8);
    await rm(dir, { recursive: true });
  });

  it("returns a document from the run's task snapshot", async () => {
    const doc = await getJson<DocumentResponse>("/api/runs/run-ended/docs/alpha");
    expect(doc).toEqual({ meta: DOC, text: DOC_TEXT });
    await getJson("/api/runs/run-ended/docs/beta", 404);
    await getJson("/api/runs/run-ended/docs/task", 404);
  });

  it("returns the final deliverable once it exists", async () => {
    const response = await app.request("/api/runs/run-ended/deliverable");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe("# Final\n");
    await getJson("/api/runs/run-live/deliverable", 404);
  });

  it("returns cached calls by key", async () => {
    const key = "ab".padEnd(64, "0");
    const cached: CachedCall = {
      key,
      request: { model: "deepseek/deepseek-v4-flash", messages: [] },
      response: { id: "gen-1", choices: [] },
      headers: { "x-generation-id": "gen-1" },
      latency_ms: 950,
      attempts: 1,
      created_at: "2026-09-01T10:00:02.000Z",
    };
    new ResponseCache(cacheDir).put(cached);
    expect(await getJson<CachedCall>(`/api/cache/${key}`)).toEqual(cached);
    await getJson(`/api/cache/${"cd".padEnd(64, "0")}`, 404);
    await getJson("/api/cache/not-a-key", 404);
    await getJson(`/api/cache/${key.toUpperCase()}`, 404);
  });
});

describe("path validation", () => {
  it("rejects traversal in run ids", async () => {
    await writeFile(join(root, "events.jsonl"), jsonl([runStarted(eventLog("2026-01-01T00:00:00.000Z"), "x")]));
    for (const id of ["..", ".", "..%2F", "..%2F..%2Fetc", "%2E%2E", "run-ended%2F..", "a..b", "run%20ended"]) {
      const response = await app.request(`/api/runs/${id}/events`);
      expect(response.status, id).toBe(404);
      expect(await response.json(), id).toHaveProperty("error");
    }
  });

  it("rejects traversal in document ids", async () => {
    for (const docId of ["..", "..%2Frun.yaml", "..%2F..%2Frun-ended%2Frun.yaml", "%2E%2E"]) {
      expect((await app.request(`/api/runs/run-ended/docs/${docId}`)).status, docId).toBe(404);
    }
  });

  it("returns JSON 404s for unknown API paths", async () => {
    expect((await getJson<{ error: string }>("/api/nothing", 404)).error).toBe("Not found");
  });
});

describe("event stream", () => {
  it("streams existing events, then appended ones, then end", async () => {
    const { dir, emit, events } = await fabricateRun(runsDir, "run-stream", "2026-08-03T00:00:00.000Z", 1, false);
    const file = join(dir, "events.jsonl");
    const response = await app.request("/api/runs/run-stream/stream?from=0");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const sse = new SseReader(response.body!);

    const backlog = await sse.nextEvents();
    expect(backlog).toEqual(events);

    const tick2 = tick(emit, 2, 2);
    await appendFile(file, jsonl(tick2));
    expect(await sse.nextEvents()).toEqual(tick2);

    // A line written in two pieces arrives once, whole.
    const tick3 = tick(emit, 3, 3);
    const text = jsonl(tick3);
    await appendFile(file, text.slice(0, 40));
    await new Promise((resolve) => setTimeout(resolve, 700));
    await appendFile(file, text.slice(40));
    const received: RunEvent[] = [];
    while (received.length < tick3.length) received.push(...(await sse.nextEvents()));
    expect(received).toEqual(tick3);

    const ended = runEnded(emit, 3);
    await appendFile(file, jsonl([ended]));
    expect(await sse.nextEvents()).toEqual([ended]);
    const end = await sse.next();
    expect(end?.event).toBe("end");
    expect(JSON.parse(end!.data)).toEqual({ last_seq: ended.seq } satisfies StreamEndData);
    expect(await sse.next()).toBeNull();
  });

  it("starts at from and resumes after Last-Event-ID", async () => {
    const response = await app.request("/api/runs/run-ended/stream?from=10");
    const sse = new SseReader(response.body!);
    const first = await sse.next();
    const events = JSON.parse(first!.data) as RunEvent[];
    expect(events.map((event) => event.seq)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(first?.id).toBe("15");
    expect((await sse.next())?.event).toBe("end");

    // A reconnect after the whole log was delivered gets only "end".
    const resumed = await app.request("/api/runs/run-ended/stream?from=0", { headers: { "Last-Event-ID": "15" } });
    const again = new SseReader(resumed.body!);
    expect((await again.next())?.event).toBe("end");
    expect(await again.next()).toBeNull();
  });

  it("keeps a live stream open until the client disconnects", async () => {
    const response = await app.request("/api/runs/run-live/stream");
    const sse = new SseReader(response.body!);
    expect((await sse.nextEvents()).length).toBe(8);
    await expect(sse.next(1200)).rejects.toThrow(/Timed out/);
    await sse.cancel();
  });

  it("rejects a bad from and unknown runs", async () => {
    expect((await app.request("/api/runs/run-live/stream?from=-1")).status).toBe(400);
    expect((await app.request("/api/runs/nope/stream")).status).toBe(404);
  });
});

describe("tailEvents", () => {
  it("waits for a log that doesn't exist yet and stops after run_ended", async () => {
    const dir = join(root, "tail-late");
    await mkdir(dir);
    const batches: RunEvent[][] = [];
    let onEnd: (ended: RunEndedEvent) => void = () => {};
    const endedPromise = new Promise<RunEndedEvent>((resolve) => (onEnd = resolve));
    const stop = tailEvents(dir, 1, (events) => void batches.push(events), (ended) => onEnd(ended));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(batches).toEqual([]);

    const emit = eventLog("2026-08-04T00:00:00.000Z");
    const events = [runStarted(emit, "tail-late"), ...tick(emit, 1, 1), runEnded(emit, 1)];
    await writeFile(join(dir, "events.jsonl"), jsonl(events));
    const ended = await withTimeout(endedPromise, 3000, "run_ended");
    expect(ended.seq).toBe(8);
    expect(batches.flat()).toEqual(events.slice(1));
    stop();
  });

  it("stops delivering once stopped", async () => {
    const { dir, emit } = await fabricateRun(root, "tail-stop", "2026-08-05T00:00:00.000Z", 1, false);
    const batches: RunEvent[][] = [];
    const stop = tailEvents(dir, 0, (events) => void batches.push(events), () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(batches).toHaveLength(1);
    stop();
    await appendFile(join(dir, "events.jsonl"), jsonl(tick(emit, 2, 2)));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(batches).toHaveLength(1);
  });
});

describe("static UI", () => {
  it("serves files and falls back to index.html outside /api", async () => {
    const uiDir = join(root, "ui");
    await mkdir(join(uiDir, "assets"), { recursive: true });
    await writeFile(join(uiDir, "index.html"), "<!doctype html><title>Swarm</title>");
    await writeFile(join(uiDir, "assets", "app.js"), "console.log(1);");
    const withUi = createApp({ runsDir, cacheDir, uiDir });

    const asset = await withUi.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toBe("console.log(1);");

    for (const path of ["/", "/runs/run-ended"]) {
      const page = await withUi.request(path);
      expect(page.status, path).toBe(200);
      expect(await page.text(), path).toContain("<title>Swarm</title>");
    }

    const api = await withUi.request("/api/nothing");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "Not found" });
    expect((await withUi.request("/api/runs")).status).toBe(200);
  });
});
