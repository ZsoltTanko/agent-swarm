import type { RunConfig } from "../shared/config.ts";
import type { ModelInfo, RunEvent, RunEventPayload, RunMode, UnappliedCall } from "../shared/events.ts";
import type {
  AgentInfo,
  AssistantMessage,
  ChatMessage,
  DocMeta,
  RunEndReason,
  RunTotals,
  ToolDefinition,
  Usage,
} from "../shared/types.ts";

/* ---------- Model client ---------- */

export interface ModelRequest {
  model: string;
  /** Resolved params (provider pin, max_tokens, reasoning, sampling, ...), merged into the body verbatim. */
  params: Record<string, unknown>;
  messages: ChatMessage[];
  tools: ToolDefinition[];
}

export interface CallContext {
  agent: string;
  tick: number;
  seed: number;
  /** Aborting it cancels the call: the request in flight and any backoff wait (a ModelCallError of kind "interrupted"). */
  signal?: AbortSignal;
}

export interface ModelResult {
  message: AssistantMessage;
  finish_reason: string | null;
  native_finish_reason: string | null;
  truncated: boolean;
  usage: Usage;
  provider: string | null;
  openrouter_metadata: unknown;
  system_fingerprint: string | null;
  generation_id: string | null;
  latency_ms: number;
  cache_key: string;
  cache_hit: boolean;
  /** Requests it took to get the response (1 = no retry); a cache hit carries the original call's count. */
  attempts: number;
}

export type ModelCallErrorKind =
  /** Non-retryable, or retries exhausted: the run aborts with api_error. */
  | "fatal"
  /** The request exceeded the model's context window: the agent stops with context_full. */
  | "context_length"
  /** --offline and the response isn't cached. */
  | "cache_miss"
  /** CallContext.signal was aborted. */
  | "interrupted";

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly kind: ModelCallErrorKind,
    readonly status: number | null = null,
    readonly body: unknown = null,
    /** The response-cache entry holding this outcome, for a context_length error that was cached. */
    readonly cacheKey: string | null = null,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export interface ModelClient {
  call(request: ModelRequest, context: CallContext): Promise<ModelResult>;
}

/* ---------- Task ---------- */

export interface LoadedDocument {
  meta: DocMeta;
  text: string;
}

export interface LoadedTask {
  /** The config's task_name, else the basename of the task directory. */
  name: string;
  /** Absolute path of the task directory. */
  dir: string;
  /** task.md verbatim. */
  text: string;
  /** Sorted by filename (natural order). */
  docs: LoadedDocument[];
}

/* ---------- Event log ---------- */

export interface EventLogWriter {
  /** Assigns seq and at, appends one JSON line synchronously, and returns the full event. */
  emit(tick: number, payload: RunEventPayload): RunEvent;
  close(): void;
}

/* ---------- Engine ---------- */

export interface TickSummary {
  tick: number;
  active: number;
  posts: number;
  doc_opens: number;
  writes: number;
  asleep: number;
  finished: number;
  cache_hits: number;
  /** Cumulative for the run. */
  cost_usd: number;
}

export interface EngineOptions {
  runId: string;
  /** Resolved config. */
  config: RunConfig;
  task: LoadedTask;
  /** In index order; names already assigned by seed. */
  agents: AgentInfo[];
  /** Rendered system prompt per agent name. */
  systemPrompts: Record<string, string>;
  kickoff: string;
  tools: ToolDefinition[];
  model: ModelClient;
  log: EventLogWriter;
  mode: RunMode;
  /** Null when the run made no catalog lookup: scripted and offline runs, and re-runs of a run's run.yaml. */
  modelInfo: ModelInfo | null;
  onTick?: (summary: TickSummary) => void;
  /**
   * Aborting ends the run with reason "interrupted": the signal is passed to every model call, so the
   * calls in flight are cancelled, and the tick they belong to isn't applied.
   */
  signal?: AbortSignal;
}

export interface RunOutcome {
  reason: RunEndReason;
  error: string | null;
  totals: RunTotals;
  /** As in run_ended. */
  unapplied: UnappliedCall[];
  finalDeliverable: string;
}
