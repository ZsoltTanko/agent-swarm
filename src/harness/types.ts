import type { RunConfig } from "../shared/config.ts";
import type { ModelInfo, RunEvent, RunEventPayload } from "../shared/events.ts";
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
}

export type ModelCallErrorKind =
  /** Non-retryable, or retries exhausted: the run aborts with api_error. */
  | "fatal"
  /** The request exceeded the model's context window: the agent stops with context_full. */
  | "context_length"
  /** --offline and the response isn't cached. */
  | "cache_miss";

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly kind: ModelCallErrorKind,
    readonly status: number | null = null,
    readonly body: unknown = null,
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
  /** Basename of the task directory. */
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
  /** Null for offline re-runs and scripted runs. */
  modelInfo: ModelInfo | null;
  onTick?: (summary: TickSummary) => void;
  /** Aborting ends the run with reason "interrupted" after the in-flight tick's calls settle. */
  signal?: AbortSignal;
}

export interface RunOutcome {
  reason: RunEndReason;
  error: string | null;
  totals: RunTotals;
  finalDeliverable: string;
}
