import { watch, type FSWatcher } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { staleAfterMs, type DocumentResponse, type RunSummary } from "../shared/api.ts";
import type { RunEndedEvent, RunEvent, RunStartedEvent } from "../shared/events.ts";
import type { RunEndReason } from "../shared/types.ts";

export const EVENTS_FILE = "events.jsonl";
export const TAIL_POLL_MS = 500;

const NEWLINE = 0x0a;
/** Spaces are allowed, so a duplicated folder ("<id> copy") still works; separators and ".." aren't. */
const RUN_ID_PATTERN = /^[A-Za-z0-9._ -]+$/;

/** A run folder name that every /api/runs/:id route accepts, and so the only kind the listing shows. */
export function isValidRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id) && id !== "." && !id.includes("..");
}

/* ---------- JSONL ---------- */

function parseLine(line: string): RunEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { seq?: unknown }).seq === "number" &&
      typeof (value as { tick?: unknown }).tick === "number" &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      return value as RunEvent;
    }
  } catch {
    // A malformed line is skipped rather than failing the whole log.
  }
  return null;
}

/**
 * Parses the newline-terminated lines of `bytes`. Anything after the last newline is a line the
 * harness is still writing: it is left out, and `consumed` stops before it.
 * Splitting on the newline byte is safe for UTF-8, where 0x0a never occurs inside a multi-byte character.
 */
export function parseJsonl(bytes: Uint8Array): { events: RunEvent[]; consumed: number } {
  const end = bytes.lastIndexOf(NEWLINE);
  if (end < 0) return { events: [], consumed: 0 };
  const events: RunEvent[] = [];
  for (const line of Buffer.from(bytes.buffer, bytes.byteOffset, end).toString("utf8").split("\n")) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return { events, consumed: end + 1 };
}

/** ENOENT, or ENOTDIR when a path component is a file (e.g. a stray file in runs/). */
function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/* ---------- Reading runs ---------- */

/** All complete events of a run, in log order. Empty when events.jsonl doesn't exist yet. */
export async function readRunEvents(runDir: string): Promise<RunEvent[]> {
  try {
    return parseJsonl(await readFile(join(runDir, EVENTS_FILE))).events;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/** The run_started event, read from the first line only so large logs aren't parsed whole. */
export async function readRunStarted(runDir: string): Promise<RunStartedEvent | null> {
  let handle;
  try {
    handle = await open(join(runDir, EVENTS_FILE), "r");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return null;
      const newline = chunk.subarray(0, bytesRead).indexOf(NEWLINE);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const first = parseLine(Buffer.concat(chunks).toString("utf8"));
    return first?.type === "run_started" ? first : null;
  } finally {
    await handle.close();
  }
}

/** A task document from the run's own snapshot (task/docs/<filename>), or null if the run has no such document. */
export async function readDocument(runDir: string, docId: string): Promise<DocumentResponse | null> {
  const started = await readRunStarted(runDir);
  const meta = started?.task.docs.find((doc) => doc.id === docId);
  if (!meta || !isPlainFilename(meta.filename)) return null;
  try {
    return { meta, text: await readFile(join(runDir, "task", "docs", meta.filename), "utf8") };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** A single path segment: no separators and not "." or "..". */
export function isPlainFilename(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

/* ---------- Summaries ---------- */

type RunAggregate = Omit<RunSummary, "id" | "status"> & { ended: boolean; staleAfterMs: number };

function aggregate(events: readonly RunEvent[]): RunAggregate | null {
  const started = events.find((event) => event.type === "run_started");
  if (!started) return null;
  let latestTick = 0;
  let modelCost = 0;
  let posts = 0;
  let versions = 0;
  let ended: RunEndedEvent | null = null;
  for (const event of events) {
    latestTick = Math.max(latestTick, event.tick);
    if (event.type === "model_call") modelCost += event.usage.cost_usd;
    else if (event.type === "post_created") posts++;
    else if (event.type === "deliverable_written") versions++;
    else if (event.type === "run_ended") ended = event;
  }
  const endReason: RunEndReason | null = ended?.reason ?? null;
  return {
    task: started.task.name,
    model: started.config.agents.model.id,
    seed: started.seed,
    agents: started.agents.length,
    mode: started.mode,
    latest_tick: latestTick,
    tick_cap: started.config.run.tick_cap,
    cost_usd: ended ? ended.totals.usage.cost_usd : modelCost,
    posts,
    deliverable_versions: versions,
    end_reason: endReason,
    started_at: started.at,
    updated_at: events.at(-1)?.at ?? started.at,
    ended: ended !== null,
    staleAfterMs: staleAfterMs(started.config),
  };
}

const summaryCache = new Map<string, { mtimeMs: number; size: number; aggregate: RunAggregate | null }>();

/**
 * The run's summary, or null when it has no run_started yet. The parse is memoized per
 * (mtimeMs, size) of events.jsonl; status is recomputed on every call because "stale" depends on the clock.
 */
export async function summarizeRun(runDir: string): Promise<RunSummary | null> {
  const dir = resolve(runDir);
  let stats;
  try {
    stats = await stat(join(dir, EVENTS_FILE));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  let cached = summaryCache.get(dir);
  if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
    cached = { mtimeMs: stats.mtimeMs, size: stats.size, aggregate: aggregate(await readRunEvents(dir)) };
    summaryCache.set(dir, cached);
  }
  if (!cached.aggregate) return null;
  const { ended, staleAfterMs: quietLimit, ...rest } = cached.aggregate;
  const status = ended ? "ended" : Date.now() - stats.mtimeMs > quietLimit ? "stale" : "running";
  return { id: basename(dir), status, ...rest };
}

/**
 * Summaries of every run folder under runsDir that has started, newest first. A run that can't be read,
 * or whose folder name the run routes wouldn't accept, is left out.
 */
export async function listRuns(runsDir: string): Promise<RunSummary[]> {
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const summaries = await Promise.all(
    names.filter(isValidRunId).map((name) =>
      summarizeRun(join(runsDir, name)).catch((error: unknown) => {
        console.error(`Skipping run ${name}:`, error);
        return null;
      }),
    ),
  );
  return summaries
    .filter((summary): summary is RunSummary => summary !== null)
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id));
}

/* ---------- Tailing ---------- */

/**
 * Follows a run's events.jsonl from `fromSeq`: calls onEvents with each batch of complete new events
 * (the first batch is everything already logged), and onEnd once run_ended has been delivered, after
 * which tailing stops. Works if the file doesn't exist yet. Returns a function that stops tailing.
 *
 * New data is noticed through fs.watch, with polling every TAIL_POLL_MS as a fallback. Callbacks are
 * awaited, so a slow consumer delays the next read instead of piling up batches. A run that has already
 * ended calls onEnd even when no events are at or past `fromSeq`.
 */
export function tailEvents(
  runDir: string,
  fromSeq: number,
  onEvents: (events: RunEvent[]) => void | Promise<void>,
  onEnd: (ended: RunEndedEvent) => void | Promise<void>,
): () => void {
  const file = join(runDir, EVENTS_FILE);
  let offset = 0;
  let nextSeq = fromSeq;
  let stopped = false;
  let reading = false;
  let readAgain = false;
  let watcher: FSWatcher | null = null;

  const closeWatcher = () => {
    watcher?.close();
    watcher = null;
  };

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    closeWatcher();
  };

  const ensureWatcher = () => {
    if (watcher || stopped) return;
    try {
      watcher = watch(file, { persistent: false }, (eventType) => {
        // After a rename the watch may follow the old file; re-attach on the next read.
        if (eventType === "rename") closeWatcher();
        void poll();
      });
      watcher.on("error", closeWatcher);
    } catch {
      // The file doesn't exist yet; polling retries.
    }
  };

  const readAppended = async (): Promise<RunEvent[]> => {
    let handle;
    try {
      handle = await open(file, "r");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    try {
      const { size } = await handle.stat();
      // The log only grows; a smaller file was replaced, so read it from the start. nextSeq prevents duplicates.
      if (size < offset) offset = 0;
      if (size === offset) return [];
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const { events, consumed } = parseJsonl(buffer.subarray(0, bytesRead));
      offset += consumed;
      return events;
    } finally {
      await handle.close();
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    try {
      do {
        readAgain = false;
        ensureWatcher();
        const events = await readAppended();
        const endIndex = events.findIndex((event) => event.type === "run_ended");
        const upToEnd = endIndex >= 0 ? events.slice(0, endIndex + 1) : events;
        const fresh = upToEnd.filter((event) => event.seq >= nextSeq);
        const last = fresh.at(-1);
        if (last) {
          nextSeq = last.seq + 1;
          if (stopped) return;
          await onEvents(fresh);
        }
        const ended = endIndex >= 0 ? (events[endIndex] as RunEndedEvent) : undefined;
        if (ended) {
          if (stopped) return;
          stop();
          await onEnd(ended);
          return;
        }
      } while (readAgain && !stopped);
    } catch (error) {
      console.error(`Tailing ${file} failed:`, error);
    } finally {
      reading = false;
    }
  };

  const timer = setInterval(() => void poll(), TAIL_POLL_MS);
  timer.unref();
  void poll();
  return stop;
}
