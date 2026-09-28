import type { RunEvent } from "./events.ts";
import type { AssistantMessage, ChatMessage } from "./types.ts";

/**
 * The form in which an assistant message is replayed in later requests.
 * Keeps content, tool calls, and reasoning; reasoning_details (when present) is passed back unmodified,
 * which providers such as DeepSeek and Anthropic require during tool use.
 */
export function assistantForContext(message: AssistantMessage): AssistantMessage {
  const replay: AssistantMessage = { role: "assistant", content: message.content ?? "" };
  if (message.tool_calls && message.tool_calls.length > 0) replay.tool_calls = message.tool_calls;
  if (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) {
    replay.reasoning_details = message.reasoning_details;
  } else if (typeof message.reasoning === "string" && message.reasoning.length > 0) {
    replay.reasoning = message.reasoning;
  }
  return replay;
}

/**
 * Rebuilds an agent's context (the `messages` of its requests) from the event log.
 * With `uptoSeq`, only events with seq <= uptoSeq are used, which gives the context as of that point:
 * the request for the model_call at seq S is rebuildContext(events, agent, S - 1).
 * The engine builds contexts incrementally in exactly this order; tests assert the two agree.
 */
export function rebuildContext(events: readonly RunEvent[], agent: string, uptoSeq = Infinity): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const event of events) {
    if (event.seq > uptoSeq) break;
    switch (event.type) {
      case "run_started": {
        const system = event.system_prompts[agent];
        if (system === undefined) return [];
        messages.push({ role: "system", content: system }, { role: "user", content: event.kickoff });
        break;
      }
      case "model_call":
        if (event.agent === agent) messages.push(assistantForContext(event.message));
        break;
      case "tool_call":
        if (event.agent === agent) {
          messages.push({ role: "tool", tool_call_id: event.call_id, content: event.result });
        }
        break;
      case "agent_woke":
        if (event.agent === agent) messages.push({ role: "user", content: event.message });
        break;
      default:
        break;
    }
  }
  return messages;
}
