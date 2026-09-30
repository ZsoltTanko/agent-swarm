import type { AssistantMessage, ToolCall } from "../../src/shared/types.ts";
import type { CallContext, ModelClient, ModelRequest, ModelResult } from "../../src/harness/types.ts";

/** One tool call in a scripted step. A string `args` is sent verbatim, so it can be malformed. */
export interface FakeCall {
  name: string;
  args?: Record<string, unknown> | string;
}

export interface FakeResponse {
  content?: string | null;
  calls?: FakeCall[];
  cost_usd?: number;
  /** Runs before the call resolves, e.g. to abort the run mid-tick. */
  before?: () => void;
}

/** A step is a list of tool calls, a fuller response, or an error the call rejects with. */
export type FakeStep = FakeCall[] | FakeResponse | Error;

export interface CapturedRequest {
  agent: string;
  tick: number;
  seed: number;
  request: ModelRequest;
}

/** Wraps a client so every request it receives is captured (deep-copied). */
export function capturing(inner: ModelClient): { client: ModelClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  return {
    client: {
      call(request, context) {
        requests.push({ ...context, request: structuredClone(request) });
        return inner.call(request, context);
      },
    },
    requests,
  };
}

/** Shorthand for a tool call. */
export function tc(name: string, args?: Record<string, unknown> | string): FakeCall {
  return args === undefined ? { name } : { name, args };
}

/**
 * A model client that plays back a script: the n-th call for an agent returns script[agent][n].
 * Captures a deep copy of every request. Running past the end of an agent's script rejects.
 */
export function createFakeModel(script: Record<string, FakeStep[]>): { client: ModelClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const counts = new Map<string, number>();
  const client: ModelClient = {
    async call(request: ModelRequest, context: CallContext): Promise<ModelResult> {
      requests.push({ ...context, request: structuredClone(request) });
      const n = counts.get(context.agent) ?? 0;
      counts.set(context.agent, n + 1);
      const step = script[context.agent]?.[n];
      if (step === undefined) throw new Error(`The script for ${context.agent} has no step ${n + 1}.`);
      if (step instanceof Error) throw step;
      const response: FakeResponse = Array.isArray(step) ? { calls: step } : step;
      response.before?.();
      await Promise.resolve();
      return fakeResult(context, n, response);
    },
  };
  return { client, requests };
}

function fakeResult(context: CallContext, n: number, response: FakeResponse): ModelResult {
  const calls = response.calls ?? [];
  const toolCalls: ToolCall[] = calls.map((call, index) => ({
    id: `${context.agent}-${n}-${index}`,
    type: "function",
    function: {
      name: call.name,
      arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}),
    },
  }));
  const message: AssistantMessage = {
    role: "assistant",
    content: response.content ?? null,
    reasoning: `Thinking about step ${n + 1}.`,
    reasoning_details: [{ type: "reasoning.text", text: `Thinking about step ${n + 1}.`, format: "unknown", index: 0 }],
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    message,
    finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
    native_finish_reason: null,
    truncated: false,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      reasoning_tokens: 5,
      cached_tokens: 0,
      cost_usd: response.cost_usd ?? 0.001,
    },
    provider: "Fake",
    openrouter_metadata: null,
    system_fingerprint: null,
    generation_id: `gen-${context.agent}-${n}`,
    latency_ms: 10,
    cache_key: `key-${context.agent}-${n}`,
    cache_hit: false,
    attempts: 1,
  };
}
