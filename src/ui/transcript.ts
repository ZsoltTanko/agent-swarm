import { rebuildContext } from "../shared/context.ts";
import type { RunEvent, TickStartedEvent, ToolCallEvent } from "../shared/events.ts";
import type { StepRecord } from "../shared/runstate.ts";
import type { AssistantMessage, ChatMessage, ToolCall, ToolMessage } from "../shared/types.ts";

/** One tool call of a step, paired with the result the agent received. */
export interface TranscriptTool {
  /** Position within the step's tool calls. */
  index: number;
  /** The call as the model emitted it; null when the context has a result with no matching call. */
  call: ToolCall | null;
  /** The tool message as it went into the context (status line included); null until it is logged. */
  result: ToolMessage | null;
  /** The logged tool_call event: parsed arguments and error. */
  event: ToolCallEvent | null;
}

export type TranscriptItem =
  | { kind: "system"; key: "system"; text: string }
  | { kind: "kickoff"; key: "kickoff"; text: string }
  | {
      kind: "step";
      key: string;
      /** Null only when the context and the step records disagree (should not happen). */
      step: StepRecord | null;
      /** The assistant message as it was replayed in later requests. */
      message: AssistantMessage;
      tools: TranscriptTool[];
    }
  | {
      kind: "wake";
      key: string;
      /** Tick at whose end the agent was woken. */
      tick: number | null;
      /** The user message the agent received. */
      text: string;
      /** Tick of the step in which the agent last fell asleep. */
      asleepSince: number | null;
    }
  | { kind: "stopped"; key: string; step: StepRecord; detail: string | null };

export interface WakeRecord {
  tick: number;
  message: string;
}

export interface StopRecord {
  tick: number;
  detail: string;
}

/**
 * Groups an agent's rebuilt context into transcript items. `messages` is rebuildContext(events, agent, cut);
 * `steps` are the agent's StepRecords up to the same cut, in tick order; `wakes` and `stops` are its
 * agent_woke and agent_stopped events up to the cut, in log order.
 *
 * rebuildContext emits, in order: system, kickoff, then one assistant message per model_call, one tool
 * message per tool_call, and one user message per agent_woke. So the n-th assistant message belongs to
 * the n-th step that has a call, the tool messages after it to that step (by position), and the n-th
 * user message after the kickoff is the n-th wake. A stop ends the agent for good, so stopped steps go last.
 */
export function groupTranscript(
  messages: readonly ChatMessage[],
  steps: readonly StepRecord[],
  wakes: readonly WakeRecord[],
  stops: readonly StopRecord[] = [],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let position = 0;
  const first = messages[0];
  if (first?.role === "system") {
    items.push({ kind: "system", key: "system", text: first.content });
    position = 1;
    const kickoff = messages[1];
    if (kickoff?.role === "user") {
      items.push({ kind: "kickoff", key: "kickoff", text: kickoff.content });
      position = 2;
    }
  }

  const callSteps = steps.filter((step) => step.call !== null);
  let stepIndex = 0;
  let wakeIndex = 0;
  let lastSleep: number | null = null;
  let current: Extract<TranscriptItem, { kind: "step" }> | null = null;
  let toolPosition = 0;

  for (let i = position; i < messages.length; i++) {
    const message = messages[i]!;
    switch (message.role) {
      case "assistant": {
        const step = callSteps[stepIndex++] ?? null;
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        current = {
          kind: "step",
          key: step?.key ?? `message-${i}`,
          step,
          message,
          tools: calls.map((call, index) => ({ index, call, result: null, event: null })),
        };
        toolPosition = 0;
        items.push(current);
        if (step?.slept) lastSleep = step.tick;
        break;
      }
      case "tool": {
        if (current === null) break;
        let entry = current.tools[toolPosition];
        if (entry === undefined) {
          entry = { index: toolPosition, call: null, result: null, event: null };
          current.tools.push(entry);
        }
        entry.result = message;
        entry.event = current.step?.tool_calls[toolPosition] ?? null;
        toolPosition++;
        break;
      }
      case "user": {
        const wake = wakes[wakeIndex++];
        items.push({
          kind: "wake",
          key: `wake-${wake?.tick ?? i}-${i}`,
          tick: wake?.tick ?? null,
          text: message.content,
          asleepSince: lastSleep,
        });
        current = null;
        break;
      }
      case "system":
        break;
    }
  }

  for (const step of steps) {
    if (step.call !== null || step.stopped === null) continue;
    const stop = stops.find((record) => record.tick === step.tick);
    items.push({ kind: "stopped", key: step.key, step, detail: stop?.detail ?? null });
  }
  return items;
}

/** The agent's transcript as of `cutSeq` (inclusive). `steps` may hold every agent's steps. */
export function buildTranscript(
  events: readonly RunEvent[],
  agent: string,
  cutSeq: number,
  steps: readonly StepRecord[],
): TranscriptItem[] {
  const messages = rebuildContext(events, agent, cutSeq);
  const wakes: WakeRecord[] = [];
  const stops: StopRecord[] = [];
  for (const event of events) {
    if (event.seq > cutSeq) break;
    if (event.type === "agent_woke" && event.agent === agent) wakes.push({ tick: event.tick, message: event.message });
    else if (event.type === "agent_stopped" && event.agent === agent) stops.push({ tick: event.tick, detail: event.detail });
  }
  return groupTranscript(
    messages,
    steps.filter((step) => step.agent === agent),
    wakes,
    stops,
  );
}

/** Seq of the last event at or before `tick`; -1 when there is none. Events are in seq order, ticks non-decreasing. */
export function lastSeqAtTick(events: readonly RunEvent[], tick: number): number {
  let low = 0;
  let high = events.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const event = events[mid]!;
    if (event.tick <= tick) {
      found = event.seq;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** The tick_started event of `tick`, if logged. */
export function tickStartedAt(events: readonly RunEvent[], tick: number): TickStartedEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.tick < tick) return null;
    if (event.tick === tick && event.type === "tick_started") return event;
  }
  return null;
}

/** A tool result or wake message split into its body and the trailing "[step 9/40 · …]" status line. */
export interface SplitResult {
  body: string;
  /** The status line's parts ("step 9/40", "3 unread posts", …); null when there is none. */
  status: string[] | null;
}

const STATUS_LINE = /(?:^|\n\n)\[(step \d+\/\d+(?: · [^\]\n]+)*)\]$/;

export function splitStatusLine(content: string): SplitResult {
  const match = STATUS_LINE.exec(content);
  if (!match) return { body: content, status: null };
  return { body: content.slice(0, match.index), status: match[1]!.split(" · ") };
}

/** Reasoning text as replayed in the context: text and summary blocks, else the plain reasoning string. */
export function reasoningOf(message: AssistantMessage): { text: string | null; encryptedBlocks: number } {
  const details = Array.isArray(message.reasoning_details) ? message.reasoning_details : [];
  const parts: string[] = [];
  let encryptedBlocks = 0;
  for (const block of details) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.length > 0) parts.push(record.text);
    else if (typeof record.summary === "string" && record.summary.length > 0) parts.push(record.summary);
    else if (record.type === "reasoning.encrypted") encryptedBlocks++;
  }
  if (parts.length > 0) return { text: parts.join("\n\n"), encryptedBlocks };
  const plain = typeof message.reasoning === "string" && message.reasoning.length > 0 ? message.reasoning : null;
  return { text: plain, encryptedBlocks };
}

/** Parsed tool arguments: the logged ones when present, else a best-effort parse of the raw string. */
export function toolArguments(tool: TranscriptTool): Record<string, unknown> | null {
  if (tool.event?.arguments) return tool.event.arguments;
  const raw = tool.call?.function.arguments ?? tool.event?.raw_arguments ?? "";
  if (raw.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function toolName(tool: TranscriptTool): string {
  return tool.call?.function.name ?? tool.event?.name ?? "unknown";
}

/** `id: "03-budget-memo", reply_to: 4`, leaving out `omit`; long values are cut to `max` characters. */
export function compactArguments(args: Record<string, unknown>, omit: readonly string[] = [], max = 60): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (omit.includes(key) || value === undefined) continue;
    let text = JSON.stringify(value) ?? String(value);
    if (text.length > max) text = `${text.slice(0, max - 1)}…`;
    parts.push(`${key}: ${text}`);
  }
  return parts.join(", ");
}

/** What a tool result points at, for cross-links. */
export type ResultLink =
  | { kind: "post"; id: number }
  | { kind: "version"; version: number }
  | { kind: "doc"; id: string; title: string; words: number };

/** Recognizes the harness's success messages ("Posted as #4.", "Saved as v8; …", a document header, …). */
export function resultLink(name: string, body: string, error: string | null): ResultLink | null {
  if (error !== null) return null;
  if (name === "post_message") {
    const match = /^Posted as #(\d+)\./.exec(body);
    return match ? { kind: "post", id: Number(match[1]) } : null;
  }
  if (name === "write_deliverable") {
    const match = /^Saved as v(\d+);/.exec(body);
    return match ? { kind: "version", version: Number(match[1]) } : null;
  }
  if (name === "read_deliverable") {
    const match = /^Deliverable v(\d+), written by/.exec(body);
    return match ? { kind: "version", version: Number(match[1]) } : null;
  }
  if (name === "read_document") {
    const match = /^(\S+) · "(.*)" · ([\d,]+) words?\n/.exec(body);
    return match ? { kind: "doc", id: match[1]!, title: match[2]!, words: Number(match[3]!.replace(/,/g, "")) } : null;
  }
  return null;
}

export const COLLAPSE_LINES = 12;

export function lineCount(text: string): number {
  if (text === "") return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

/** Whether a tool result body starts collapsed: every document body, and anything over COLLAPSE_LINES lines. */
export function startsCollapsed(name: string, body: string, error: string | null): boolean {
  if (name === "read_document" && error === null) return true;
  return lineCount(body) > COLLAPSE_LINES;
}

const INT_FORMAT = new Intl.NumberFormat("en-US");

/** 1234 -> "1,234". */
export function formatInt(n: number): string {
  return INT_FORMAT.format(Math.round(n));
}

/** "+312" / "−45" / "±0" for a signed change. */
export function formatDelta(n: number): string {
  if (n > 0) return `+${formatInt(n)}`;
  if (n < 0) return `−${formatInt(-n)}`;
  return "±0";
}

/** "06" for "06-radio-interview"; ids without a numeric prefix are returned whole. */
export function shortDocId(id: string): string {
  const match = /^(\d+)[-_ .]/.exec(id);
  return match ? match[1]! : id;
}

/** "unread: 06, 08", or "every document opened". */
export function unreadSummary(neverOpened: readonly string[]): string {
  return neverOpened.length === 0 ? "every document opened" : `unread: ${neverOpened.map(shortDocId).join(", ")}`;
}
