import type { EnvironmentConfig } from "../shared/config.ts";
import { TOOL_NAMES } from "../shared/types.ts";
import type { JsonSchemaObject, ToolDefinition, ToolName } from "../shared/types.ts";

interface ArgumentSpec {
  type: "string" | "integer";
  /** Required arguments must be present and non-null; optional ones may be absent or null. */
  required: boolean;
  description: string;
}

const ARGUMENTS: Record<ToolName, Record<string, ArgumentSpec>> = {
  read_board: {},
  post_message: {
    text: { type: "string", required: true, description: "The text of the post." },
    reply_to: { type: "integer", required: false, description: "The id of the post you're replying to." },
  },
  list_documents: {},
  read_document: {
    id: { type: "string", required: true, description: "The document id, as given by list_documents." },
  },
  read_deliverable: {},
  write_deliverable: {
    text: { type: "string", required: true, description: "The complete new text of the deliverable." },
  },
  wait: {},
  done: {
    note: { type: "string", required: false, description: "A note for the log." },
  },
};

/** 1532 -> "1,532". Locale-independent, so agent-facing text is deterministic. */
export function formatNumber(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** (1, "post") -> "1 post"; (3, "post") -> "3 posts". */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(n)} ${n === 1 ? singular : plural}`;
}

function description(name: ToolName, env: EnvironmentConfig): string {
  switch (name) {
    case "read_board":
      return "Return the posts on the message board that you haven't seen yet.";
    case "post_message":
      return `Post a message to the board. At most ${formatNumber(env.post_max_chars)} characters. Optionally reply to an earlier post by its id.`;
    case "list_documents":
      return "List all documents with their ids, titles, and lengths. Doesn't use any of your document reads.";
    case "read_document":
      return `Return the full text of a document. Opening a document you haven't opened before uses one of your ${formatNumber(env.doc_read_budget)} document reads; opening it again is free.`;
    case "read_deliverable":
      return "Return the current deliverable, its version number, and who wrote that version.";
    case "write_deliverable":
      return `Replace the entire deliverable with new text. At most ${formatNumber(env.deliverable_max_chars)} characters.`;
    case "wait":
      return "Wait until another agent posts on the board. You won't take any more steps until then.";
    case "done":
      return "Stop working. After this you can't act again. The optional note isn't shown to other agents.";
  }
}

function parameters(name: ToolName): JsonSchemaObject {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(ARGUMENTS[name])) {
    properties[key] = { type: spec.type, description: spec.description };
    if (spec.required) required.push(key);
  }
  return required.length > 0 ? { type: "object", properties, required } : { type: "object", properties };
}

/** The agents' tools, in TOOL_NAMES order (wait only when environment.wait_tool is on). Descriptions state mechanics only. */
export function buildTools(env: EnvironmentConfig): ToolDefinition[] {
  return TOOL_NAMES.filter((name) => name !== "wait" || env.wait_tool).map((name) => ({
    type: "function",
    function: { name, description: description(name, env), parameters: parameters(name) },
  }));
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raw tool-call arguments as an object: {} for empty or whitespace, null unless they are a JSON object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

export type ParsedArguments = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/**
 * Validates a tool call's raw arguments against the tool's parameters. Extra fields are kept but ignored.
 * Error messages are shown to the agent, so they are short and plain.
 */
export function parseToolArguments(name: ToolName, raw: string): ParsedArguments {
  let value: unknown = {};
  if (raw.trim() !== "") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: "Arguments aren't valid JSON." };
    }
  }
  if (!isPlainObject(value)) return { ok: false, error: "Arguments must be a JSON object." };

  for (const [key, spec] of Object.entries(ARGUMENTS[name])) {
    const arg = value[key];
    if (arg === undefined && spec.required) return { ok: false, error: `Missing required argument "${key}".` };
    if (arg === undefined || (arg === null && !spec.required)) continue;
    if (spec.type === "string" && typeof arg !== "string") {
      return { ok: false, error: `Argument "${key}" must be a string.` };
    }
    if (spec.type === "integer" && !Number.isInteger(arg)) {
      return { ok: false, error: `Argument "${key}" must be an integer.` };
    }
  }
  return { ok: true, args: value };
}
