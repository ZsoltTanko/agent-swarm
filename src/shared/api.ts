/** Response shapes of the observer server's HTTP API. Browser-safe: no Node imports. */
import type { RunConfig } from "./config.ts";
import type { RunMode } from "./events.ts";
import { MAX_BACKOFF_MS, MAX_JITTER_MS } from "./retry.ts";
import type { DocMeta, RunEndReason } from "./types.ts";

/**
 * "ended" once the log contains run_ended; "stale" when it doesn't and events.jsonl hasn't changed
 * for staleAfterMs(config) (the harness was probably killed); otherwise "running".
 */
export type RunStatus = "running" | "ended" | "stale";

/** Reasoning calls can take several minutes, so a quiet log isn't dead until well after that. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * How long a healthy run can go without logging: the engine logs nothing while a tick's calls are in
 * flight, and a call may time out on every attempt with a full backoff between attempts. Calls beyond
 * max_concurrency wait for a slot. At least STALE_AFTER_MS.
 */
export function staleAfterMs(config: RunConfig): number {
  const { call_timeout_s, max_retries, max_concurrency } = config.run;
  const slowestCall = (max_retries + 1) * call_timeout_s * 1000 + max_retries * (MAX_BACKOFF_MS + MAX_JITTER_MS);
  const waves = Math.ceil(config.agents.count / max_concurrency);
  return Math.max(STALE_AFTER_MS, waves * slowestCall);
}

/** GET /api/runs returns RunSummary[], newest first. */
export interface RunSummary {
  /** The run folder name, used in every /api/runs/:id route. */
  id: string;
  /** Task name (the config's task_name, else the basename of the task directory). */
  task: string;
  /** OpenRouter model id. */
  model: string;
  seed: number;
  /** Number of agents. */
  agents: number;
  /** From run_started: a scripted run's cost_usd is simulated, an offline run's was spent by the run it re-ran. */
  mode: RunMode;
  status: RunStatus;
  /** Highest tick present in the log (0 when only run_started is there). */
  latest_tick: number;
  tick_cap: number;
  cost_usd: number;
  posts: number;
  deliverable_versions: number;
  end_reason: RunEndReason | null;
  /** ISO timestamp of run_started. */
  started_at: string;
  /** ISO timestamp of the latest event. */
  updated_at: string;
}

/** GET /api/runs/:id */
export interface RunDetail {
  summary: RunSummary;
  /** runs/<id>/run.yaml verbatim; empty when the file is missing. */
  run_yaml: string;
}

/** GET /api/runs/:id/docs/:docId */
export interface DocumentResponse {
  meta: DocMeta;
  text: string;
}

/** GET /api/cache/:key: one response-cache file, as the harness wrote it. */
export interface CachedCall {
  /** sha256 hex of the request body, seed, tick, and agent name. */
  key: string;
  /** The request body sent to OpenRouter. */
  request: Record<string, unknown>;
  /** The raw chat completion response; when `error` is set, the raw error body instead. */
  response: Record<string, unknown>;
  headers: Record<string, string>;
  latency_ms: number;
  /** Requests it took to get the response (1 = no retry). */
  attempts: number;
  created_at: string;
  /** Set when the request failed because it exceeded the context window (the agent_stopped of that step). */
  error?: { kind: "context_length"; status: number | null; message: string };
}

/** Body of every non-2xx JSON response. */
export interface ApiError {
  error: string;
}

/**
 * GET /api/runs/:id/stream?from=N is a server-sent event stream:
 * - "events": data is a JSON RunEvent[] (seq ascending); the message id is the last seq in it.
 *   The first message carries everything already logged with seq >= N, later ones each new batch.
 * - "end": sent after the batch containing run_ended; data is StreamEndData. The server then closes
 *   the stream, so clients should close their EventSource on "end" to stop it from reconnecting.
 * A reconnect with Last-Event-ID resumes after that seq.
 */
export const STREAM_EVENTS = { events: "events", end: "end" } as const;

export interface StreamEndData {
  /** Seq of the run_ended event. */
  last_seq: number;
}
