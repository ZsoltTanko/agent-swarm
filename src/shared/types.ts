/** Domain and wire types shared by the harness, the server, and the UI. Browser-safe: no Node imports. */

export const TOOL_NAMES = [
  "read_board",
  "post_message",
  "list_documents",
  "read_document",
  "read_deliverable",
  "write_deliverable",
  "done",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** choices[0].message from an OpenRouter chat completion, kept verbatim (unknown fields included). */
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning?: string | null;
  /** Structured reasoning blocks (reasoning.text / reasoning.summary / reasoning.encrypted). Replayed unmodified. */
  reasoning_details?: unknown[];
  refusal?: string | null;
  [key: string]: unknown;
}

export interface SystemMessage {
  role: "system";
  content: string;
}
export interface UserMessage {
  role: "user";
  content: string;
}
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}
export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function: { name: ToolName; description: string; parameters: JsonSchemaObject };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cost_usd: number;
}

export const ZERO_USAGE: Usage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  reasoning_tokens: 0,
  cached_tokens: 0,
  cost_usd: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

export interface AgentInfo {
  name: string;
  /** Stable index (0-based) used for colors and ordering in the UI. */
  index: number;
  /** OpenRouter model id. */
  model: string;
}

export interface Post {
  /** 1-based, in commit order. */
  id: number;
  author: string;
  tick: number;
  text: string;
  reply_to: number | null;
}

export interface DocMeta {
  /** Filename without extension. */
  id: string;
  filename: string;
  /** First Markdown heading, else the filename. */
  title: string;
  words: number;
  chars: number;
  sha256: string;
}

export interface DeliverableVersion {
  /** 1-based; version 0 is the implicit empty deliverable. */
  version: number;
  author: string;
  tick: number;
  text: string;
  replaced_version: number;
  /** Null when the replaced version was the empty v0. */
  replaced_author: string | null;
  /** False when the writer overwrote a version it had never read (and didn't write itself). */
  writer_had_seen_replaced: boolean;
}

export type AgentStatus = "awake" | "asleep" | "done" | "stopped";

export type RunEndReason =
  | "all_done"
  | "quiescent"
  | "tick_cap"
  | "cost_cap"
  | "api_error"
  | "interrupted";

export interface RunTotals {
  ticks: number;
  model_calls: number;
  cache_hits: number;
  usage: Usage;
  posts: number;
  deliverable_versions: number;
}
