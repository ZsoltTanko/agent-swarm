import type { RunConfig } from "./config.ts";
import type {
  AgentInfo,
  AssistantMessage,
  DeliverableVersion,
  DocMeta,
  Post,
  RunEndReason,
  RunTotals,
  ToolDefinition,
  Usage,
} from "./types.ts";

/**
 * One line of runs/<run-id>/events.jsonl.
 *
 * Ticks are 1-based (agents see them as "steps"); run_started is tick 0.
 * Each tick starts with tick_started. Its steps follow in the tick's shuffle order. For each agent's step:
 *   model_call, then for each tool call its domain events (post_created, board_delivered,
 *   document_opened, deliverable_read, deliverable_written, agent_done) followed by its tool_call event;
 *   or model_call then agent_slept when the response had no tool calls;
 *   or agent_stopped alone, with no model_call, when the call failed because the context was too long.
 * agent_woke events come at the end of the tick in which the agent was woken, in agent-index order.
 * When a tick's calls end the run (api_error, interrupted), none of its steps are applied: tick_started
 * is followed directly by run_ended, whose `unapplied` lists that tick's calls that did return a response.
 * run_ended is always last, with the tick of the last tick started (0 if none was).
 */
export interface EventBase {
  /** Monotonic from 0 within a run. */
  seq: number;
  tick: number;
  /** Wall-clock ISO timestamp. Not part of a run's deterministic content. */
  at: string;
}

export interface ModelInfo {
  id: string;
  /** The model's /api/v1/models catalog entry, verbatim. */
  catalog: unknown;
  /** The pinned endpoint's /api/v1/models/{id}/endpoints record, verbatim. */
  endpoint: unknown;
}

export interface RunStartedEvent extends EventBase {
  type: "run_started";
  run_id: string;
  /** Resolved config (identical to run.yaml). */
  config: RunConfig;
  seed: number;
  agents: AgentInfo[];
  task: { name: string; text: string; docs: DocMeta[] };
  /** Rendered system prompt per agent name. */
  system_prompts: Record<string, string>;
  kickoff: string;
  tools: ToolDefinition[];
  mode: RunMode;
  /** Null when the run made no catalog lookup: scripted and offline runs, and re-runs of a run's run.yaml. */
  model_info: ModelInfo | null;
}

/**
 * Where a run's responses came from:
 * - "live": OpenRouter, with cache hits for requests already in the response cache;
 * - "offline": the response cache only (--offline), so the run spent nothing;
 * - "scripted": the scripted fake model (--scripted), whose costs are simulated.
 */
export type RunMode = "live" | "offline" | "scripted";

export interface TickStartedEvent extends EventBase {
  type: "tick_started";
  /** Agents making a model call this tick, in agent-index order. */
  active: string[];
  /** The seeded shuffle of `active`: the order in which effects are applied. */
  order: string[];
  asleep: string[];
  finished: string[];
}

export interface ModelCallEvent extends EventBase {
  type: "model_call";
  agent: string;
  /** Position of this agent in the tick's order. */
  order_index: number;
  cache_key: string;
  cache_hit: boolean;
  /** The assistant message exactly as received. */
  message: AssistantMessage;
  finish_reason: string | null;
  native_finish_reason: string | null;
  /** finish_reason was "length". */
  truncated: boolean;
  usage: Usage;
  provider: string | null;
  openrouter_metadata: unknown;
  system_fingerprint: string | null;
  generation_id: string | null;
  latency_ms: number;
  /** Requests it took to get the response (1 = no retry). A cache hit carries the original call's count. */
  attempts: number;
  /** Number of messages in the request. */
  request_messages: number;
}

export interface ToolCallEvent extends EventBase {
  type: "tool_call";
  agent: string;
  call_id: string;
  /** Position within the step's tool calls. */
  index: number;
  /** As emitted by the model; may be an unknown tool name. */
  name: string;
  raw_arguments: string;
  /** Parsed arguments, or null when they weren't valid JSON. */
  arguments: Record<string, unknown> | null;
  /** The tool message content exactly as appended to the agent's context (status line included). */
  result: string;
  /** Set when the call failed (unknown tool, bad arguments, budget exceeded, ...). */
  error: string | null;
}

export interface PostCreatedEvent extends EventBase {
  type: "post_created";
  post: Post;
}

export interface BoardDeliveredEvent extends EventBase {
  type: "board_delivered";
  agent: string;
  /** Posts returned by this read_board call (possibly empty). Exact read receipts. */
  post_ids: number[];
}

export interface DocumentOpenedEvent extends EventBase {
  type: "document_opened";
  agent: string;
  doc_id: string;
  /** False when re-opening a document this agent had already opened (free). */
  first_open: boolean;
  reads_left: number;
}

export interface DeliverableReadEvent extends EventBase {
  type: "deliverable_read";
  agent: string;
  /** 0 when the deliverable is still empty. */
  version: number;
}

export interface DeliverableWrittenEvent extends EventBase {
  type: "deliverable_written";
  version: DeliverableVersion;
}

export interface AgentSleptEvent extends EventBase {
  type: "agent_slept";
  agent: string;
  /** "wait": the agent called wait; "no_tool_calls": its response had no tool calls. */
  reason: SleepReason;
}

export type SleepReason = "wait" | "no_tool_calls";

export interface AgentWokeEvent extends EventBase {
  type: "agent_woke";
  agent: string;
  /** The user message appended to the agent's context. */
  message: string;
}

export interface AgentDoneEvent extends EventBase {
  type: "agent_done";
  agent: string;
  note: string | null;
}

export interface AgentStoppedEvent extends EventBase {
  type: "agent_stopped";
  agent: string;
  reason: "context_full";
  detail: string;
  /** The response-cache entry holding the error response; null when the model client has no cache. */
  cache_key: string | null;
}

/** A call of the tick that ended the run that returned a response which was never applied. */
export interface UnappliedCall {
  agent: string;
  cache_key: string;
  cache_hit: boolean;
  usage: Usage;
}

export interface RunEndedEvent extends EventBase {
  type: "run_ended";
  reason: RunEndReason;
  error: string | null;
  totals: RunTotals;
  /**
   * For api_error and interrupted: the calls of the aborted tick that returned anyway, in agent-index
   * order. They were paid for and cached but have no model_call; totals.usage includes them. Else empty.
   */
  unapplied: UnappliedCall[];
}

export type RunEvent =
  | RunStartedEvent
  | TickStartedEvent
  | ModelCallEvent
  | ToolCallEvent
  | PostCreatedEvent
  | BoardDeliveredEvent
  | DocumentOpenedEvent
  | DeliverableReadEvent
  | DeliverableWrittenEvent
  | AgentSleptEvent
  | AgentWokeEvent
  | AgentDoneEvent
  | AgentStoppedEvent
  | RunEndedEvent;

export type RunEventType = RunEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the log assigns seq, tick, and at. */
export type RunEventPayload = DistributiveOmit<RunEvent, keyof EventBase>;
