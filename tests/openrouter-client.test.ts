import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResponseCache, cacheKey } from "../src/harness/cache.ts";
import {
  buildRequestBody,
  createOpenRouterModelClient,
  parseCompletion,
  parseRetryAfter,
  type OpenRouterClientOptions,
  type RetryInfo,
} from "../src/harness/openrouter/client.ts";
import { ModelCallError, type CallContext, type ModelRequest } from "../src/harness/types.ts";

const API_KEY = "sk-or-v1-test-key-that-must-never-leak";
const CONTEXT: CallContext = { agent: "Wren", tick: 3, seed: 7 };

const REQUEST: ModelRequest = {
  model: "deepseek/deepseek-v4-flash",
  params: {
    reasoning: { effort: "high" },
    temperature: 0.7,
    max_tokens: 16000,
    provider: { order: ["baidu/fp8"], allow_fallbacks: false, require_parameters: true },
  },
  messages: [
    { role: "system", content: "You are Wren." },
    { role: "user", content: "Check the board and introduce yourself before you start." },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_board",
        description: "Returns every post you haven't received yet.",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
};

/** A realistic non-streaming chat completion with reasoning and two tool calls. */
function completion(): Record<string, unknown> {
  return {
    id: "gen-1759080000-AbCdEf",
    object: "chat.completion",
    created: 1759080000,
    model: "deepseek/deepseek-v4-flash-20260423",
    provider: "Baidu",
    system_fingerprint: "fp_7a1b",
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: "tool_calls",
        native_finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          refusal: null,
          reasoning: "The board may already have posts. Read it, then introduce myself.",
          reasoning_details: [
            {
              type: "reasoning.text",
              text: "The board may already have posts. Read it, then introduce myself.",
              format: "unknown",
              index: 0,
            },
          ],
          tool_calls: [
            { index: 0, id: "call_0", type: "function", function: { name: "read_board", arguments: "{}" } },
            {
              index: 1,
              id: "call_1",
              type: "function",
              function: { name: "post_message", arguments: '{"text":"Hi, I\'m Wren."}' },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 1830,
      completion_tokens: 412,
      total_tokens: 2242,
      cost: 0.000157,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 1536, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 350 },
      cost_details: { upstream_inference_cost: 0.000157 },
    },
    openrouter_metadata: {
      requested: "deepseek/deepseek-v4-flash",
      strategy: "direct",
      attempt: 1,
      endpoints: {
        total: 1,
        available: [{ provider: "Baidu", model: "deepseek/deepseek-v4-flash", selected: true }],
      },
    },
  };
}

function emptyCompletion(): Record<string, unknown> {
  return {
    id: "gen-empty",
    choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: "" } }],
    usage: { prompt_tokens: 1830, completion_tokens: 0, total_tokens: 1830, cost: 0 },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

function fakeFetch(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps.shift();
    if (step === undefined) throw new Error("fetch called more often than the test expected");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(init ?? {});
    return step;
  }) as typeof fetch;
  return { impl, calls };
}

describe("buildRequestBody", () => {
  it("is { model, ...params, messages, tools } with nothing added", () => {
    const body = buildRequestBody(REQUEST);
    expect(Object.keys(body)).toEqual(["model", "reasoning", "temperature", "max_tokens", "provider", "messages", "tools"]);
    expect(body.model).toBe(REQUEST.model);
    expect(body.messages).toBe(REQUEST.messages);
    expect(body.tools).toBe(REQUEST.tools);
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body).not.toHaveProperty("stream");
  });

  it.each(["model", "messages", "tools", "stream"])("rejects params that set %s", (key) => {
    expect(() => buildRequestBody({ ...REQUEST, params: { [key]: true } })).toThrow(new RegExp(`"${key}"`));
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    expect(parseRetryAfter("7", now)).toBe(7000);
    expect(parseRetryAfter("1.5", now)).toBe(1500);
    expect(parseRetryAfter("Mon, 28 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Mon, 28 Sep 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});

describe("parseCompletion", () => {
  it("maps a realistic response with reasoning_details and tool_calls", () => {
    const raw = completion();
    const result = parseCompletion(raw, { "x-generation-id": "gen-from-header" }, 850, "k".repeat(64), false, 1);
    const choice = (raw.choices as Record<string, unknown>[])[0]!;
    expect(result.message).toBe(choice.message);
    expect(result.message.tool_calls?.map((call) => call.function.name)).toEqual(["read_board", "post_message"]);
    expect(result.message.reasoning_details).toHaveLength(1);
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.native_finish_reason).toBe("tool_calls");
    expect(result.truncated).toBe(false);
    expect(result.usage).toEqual({
      prompt_tokens: 1830,
      completion_tokens: 412,
      reasoning_tokens: 350,
      cached_tokens: 1536,
      cost_usd: 0.000157,
    });
    expect(result.provider).toBe("Baidu");
    expect(result.openrouter_metadata).toBe(raw.openrouter_metadata);
    expect(result.system_fingerprint).toBe("fp_7a1b");
    expect(result.generation_id).toBe("gen-from-header");
    expect(result.latency_ms).toBe(850);
    expect(result.cache_key).toBe("k".repeat(64));
    expect(result.cache_hit).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("falls back to the body id, the selected metadata endpoint, nulls, and zeros", () => {
    const raw = completion();
    delete raw.provider;
    delete raw.system_fingerprint;
    delete raw.usage;
    const choice = (raw.choices as Record<string, unknown>[])[0]!;
    delete choice.native_finish_reason;
    choice.finish_reason = "length";
    const result = parseCompletion(raw, {}, 1, "k".repeat(64), true, 3);
    expect(result.generation_id).toBe("gen-1759080000-AbCdEf");
    expect(result.provider).toBe("Baidu");
    expect(result.system_fingerprint).toBeNull();
    expect(result.native_finish_reason).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cost_usd: 0 });
    expect(result.cache_hit).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it("gives a null provider and metadata when neither is present", () => {
    const raw = completion();
    delete raw.provider;
    delete raw.openrouter_metadata;
    const result = parseCompletion(raw, {}, 1, "k".repeat(64), false, 1);
    expect(result.provider).toBeNull();
    expect(result.openrouter_metadata).toBeNull();
  });
});

describe("createOpenRouterModelClient", () => {
  let dir: string;
  let sleeps: number[];
  let retries: RetryInfo[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-client-"));
    sleeps = [];
    retries = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function client(fetchImpl: typeof fetch, overrides: Partial<OpenRouterClientOptions> = {}) {
    return createOpenRouterModelClient({
      apiKey: API_KEY,
      cacheDir: dir,
      offline: false,
      timeoutMs: 600_000,
      maxRetries: 3,
      onRetry: (info) => retries.push(info),
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...overrides,
    });
  }

  async function callError(promise: Promise<unknown>): Promise<ModelCallError> {
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ModelCallError);
    const modelError = error as ModelCallError;
    expect(modelError.message).not.toContain(API_KEY);
    expect(JSON.stringify(modelError.body ?? null)).not.toContain(API_KEY);
    return modelError;
  }

  it("on a miss, POSTs the body with the right headers and caches the exact bytes sent", async () => {
    const { impl, calls } = fakeFetch([json(200, completion(), { "X-Generation-Id": "gen-hdr" })]);
    const result = await client(impl).call(REQUEST, CONTEXT);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "swarm-experiment",
      "X-OpenRouter-Metadata": "enabled",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const sent = init.body as string;
    expect(sent).toBe(JSON.stringify(buildRequestBody(REQUEST)));

    const key = cacheKey(JSON.parse(sent), CONTEXT.seed, CONTEXT.tick, CONTEXT.agent);
    expect(result.cache_key).toBe(key);
    expect(result.cache_hit).toBe(false);
    expect(result.generation_id).toBe("gen-hdr");
    expect(result.message.tool_calls).toHaveLength(2);

    const entry = new ResponseCache(dir).get(key);
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry!.request)).toBe(sent);
    expect(entry!.response).toEqual(completion());
    expect(entry!.headers["x-generation-id"]).toBe("gen-hdr");
    expect(entry!.latency_ms).toBe(result.latency_ms);
    expect(JSON.stringify(entry)).not.toContain(API_KEY);
  });

  it("serves a repeated request from the cache without calling fetch", async () => {
    const { impl, calls } = fakeFetch([json(200, completion())]);
    const model = client(impl);
    const first = await model.call(REQUEST, CONTEXT);
    const second = await model.call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(1);
    expect(second.cache_hit).toBe(true);
    expect(second.cache_key).toBe(first.cache_key);
    expect(second.latency_ms).toBe(first.latency_ms);
    expect(second.message).toEqual(first.message);
    expect(second.usage).toEqual(first.usage);
  });

  it("keys the cache by seed and tick as well as the body", async () => {
    const { impl, calls } = fakeFetch([json(200, completion()), json(200, completion())]);
    const model = client(impl);
    await model.call(REQUEST, CONTEXT);
    const other = await model.call(REQUEST, { ...CONTEXT, tick: CONTEXT.tick + 1 });
    expect(calls).toHaveLength(2);
    expect(other.cache_hit).toBe(false);
  });

  it("gives two agents with identical requests in one tick their own samples", async () => {
    const sample = (text: string) => {
      const raw = completion();
      const choice = (raw.choices as Record<string, unknown>[])[0]!;
      choice.message = { role: "assistant", content: text };
      choice.finish_reason = "stop";
      return json(200, raw);
    };
    const { impl, calls } = fakeFetch([sample("Wren's sample"), sample("Otter's sample")]);
    const model = client(impl);
    const wren = await model.call(REQUEST, CONTEXT);
    const otter = await model.call(REQUEST, { ...CONTEXT, agent: "Otter" });
    expect(calls).toHaveLength(2);
    expect(otter.cache_key).not.toBe(wren.cache_key);

    const offline = client(fakeFetch([]).impl, { offline: true });
    expect((await offline.call(REQUEST, CONTEXT)).message.content).toBe("Wren's sample");
    expect((await offline.call(REQUEST, { ...CONTEXT, agent: "Otter" })).message.content).toBe("Otter's sample");
  });

  it("offline: a miss is a cache_miss error and makes no request", async () => {
    const { impl, calls } = fakeFetch([]);
    const error = await callError(client(impl, { offline: true }).call(REQUEST, CONTEXT));
    expect(error.kind).toBe("cache_miss");
    expect(calls).toHaveLength(0);
  });

  it("offline: a hit is served, even without an API key", async () => {
    const { impl } = fakeFetch([json(200, completion())]);
    await client(impl).call(REQUEST, CONTEXT);
    const offline = client(fakeFetch([]).impl, { offline: true, apiKey: null });
    const result = await offline.call(REQUEST, CONTEXT);
    expect(result.cache_hit).toBe(true);
  });

  it("without an API key a miss is fatal and makes no request", async () => {
    const { impl, calls } = fakeFetch([]);
    const error = await callError(client(impl, { apiKey: null }).call(REQUEST, CONTEXT));
    expect(error.kind).toBe("fatal");
    expect(calls).toHaveLength(0);
  });

  it("params that set a harness-owned key are a fatal error", async () => {
    const { impl, calls } = fakeFetch([]);
    const error = await callError(client(impl).call({ ...REQUEST, params: { stream: true } }, CONTEXT));
    expect(error.kind).toBe("fatal");
    expect(calls).toHaveLength(0);
  });

  it("retries a 429, honoring Retry-After, and reports the retry", async () => {
    const rateLimited = json(
      429,
      { error: { code: 429, message: "Rate limit exceeded", metadata: { error_type: "rate_limit_exceeded" } } },
      { "Retry-After": "7" },
    );
    const { impl, calls } = fakeFetch([rateLimited, json(200, completion())]);
    const result = await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
    expect(sleeps).toEqual([7000]);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 7000, reason: expect.stringContaining("HTTP 429") as unknown, agent: "Wren", tick: 3 },
    ]);
    expect(result.cache_hit).toBe(false);
  });

  it("records the attempts a response took, caches them, and returns them on a cache hit", async () => {
    const overloaded = () => json(503, { error: { code: 503, message: "No provider available" } });
    const { impl } = fakeFetch([overloaded(), overloaded(), json(200, completion())]);
    const model = client(impl);
    const first = await model.call(REQUEST, CONTEXT);
    expect(first.attempts).toBe(3);
    expect(new ResponseCache(dir).get(first.cache_key)?.attempts).toBe(3);
    const hit = await model.call(REQUEST, CONTEXT);
    expect(hit).toMatchObject({ cache_hit: true, attempts: 3 });

    const once = await client(fakeFetch([json(200, completion())]).impl).call(REQUEST, { ...CONTEXT, tick: 9 });
    expect(once.attempts).toBe(1);
  });

  it("an abort cancels the request in flight: interrupted, no retry, nothing cached", async () => {
    const controller = new AbortController();
    const hangs = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { impl, calls } = fakeFetch([hangs]);
    const pending = client(impl).call(REQUEST, { ...CONTEXT, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await callError(pending);
    expect(error.kind).toBe("interrupted");
    expect(error.message).toBe("The call for Wren at tick 3 was interrupted.");
    expect(calls).toHaveLength(1);
    expect(retries).toHaveLength(0);
    expect(new ResponseCache(dir).get(cacheKey(buildRequestBody(REQUEST), CONTEXT.seed, CONTEXT.tick, CONTEXT.agent))).toBeNull();
  });

  it("an abort ends a backoff wait early", async () => {
    const controller = new AbortController();
    const rateLimited = json(429, { error: { code: 429, message: "Rate limit exceeded" } }, { "Retry-After": "60" });
    const { impl, calls } = fakeFetch([rateLimited]);
    const started = performance.now();
    const pending = client(impl, { sleep: undefined }).call(REQUEST, { ...CONTEXT, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const error = await callError(pending);
    expect(error.kind).toBe("interrupted");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(calls).toHaveLength(1);
    expect(retries.map((retry) => retry.delayMs)).toEqual([60_000]);
  });

  it("an already aborted signal makes no request, but a cache hit is still served", async () => {
    const { impl, calls } = fakeFetch([json(200, completion())]);
    const error = await callError(client(impl).call(REQUEST, { ...CONTEXT, signal: AbortSignal.abort() }));
    expect(error.kind).toBe("interrupted");
    expect(calls).toHaveLength(0);

    const model = client(impl);
    await model.call(REQUEST, CONTEXT);
    expect((await model.call(REQUEST, { ...CONTEXT, signal: AbortSignal.abort() })).cache_hit).toBe(true);
  });

  it("backs off exponentially with jitter when there is no Retry-After", async () => {
    const overloaded = () => json(503, { error: { code: 503, message: "No provider available" } });
    const { impl } = fakeFetch([overloaded(), overloaded(), overloaded(), json(200, completion())]);
    await client(impl).call(REQUEST, CONTEXT);
    expect(sleeps).toHaveLength(3);
    [1000, 2000, 4000].forEach((base, i) => {
      expect(sleeps[i]).toBeGreaterThanOrEqual(base);
      expect(sleeps[i]).toBeLessThan(base + 1000);
    });
    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2, 3]);
  });

  it.each([408, 500, 502, 504, 524, 529])("retries HTTP %i", async (status) => {
    const { impl, calls } = fakeFetch([json(status, { error: { code: status, message: "upstream" } }), json(200, completion())]);
    await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(2);
  });

  it("retries network errors and timeouts", async () => {
    const networkError = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    const neverAnswers = (init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { impl, calls } = fakeFetch([networkError, neverAnswers, json(200, completion())]);
    await client(impl, { timeoutMs: 20 }).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(3);
    expect(retries[0]!.reason).toMatch(/network error.*ECONNRESET/);
    expect(retries[1]!.reason).toMatch(/timed out/);
  });

  it("retries a 200 whose body is only a provider error", async () => {
    const providerError = {
      id: "gen-err",
      error: { code: 502, message: "Provider returned error", metadata: { error_type: "provider_unavailable" } },
    };
    const { impl, calls } = fakeFetch([json(200, providerError), json(200, completion())]);
    await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(2);
    expect(retries[0]!.reason).toContain("provider_unavailable");
  });

  it("retries a 200 whose error_type is retryable even when its code isn't", async () => {
    const providerError = { error: { code: 400, message: "busy", metadata: { error_type: "provider_overloaded" } } };
    const { impl, calls } = fakeFetch([json(200, providerError), json(200, completion())]);
    await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(2);
  });

  it("retries a 200 whose choice failed", async () => {
    const failedChoice = completion();
    const choice = (failedChoice.choices as Record<string, unknown>[])[0]!;
    choice.finish_reason = "error";
    choice.error = { code: 502, message: "Provider disconnected mid-stream", metadata: { error_type: "provider_unavailable" } };
    const { impl, calls } = fakeFetch([json(200, failedChoice), json(200, completion())]);
    const result = await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(2);
    expect(result.finish_reason).toBe("tool_calls");
  });

  it("retries an empty zero-token response", async () => {
    const { impl, calls } = fakeFetch([json(200, emptyCompletion()), json(200, completion())]);
    await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(2);
    expect(retries[0]!.reason).toContain("empty completion");
  });

  it("accepts a truncated response as-is", async () => {
    const truncated = completion();
    const choice = (truncated.choices as Record<string, unknown>[])[0]!;
    choice.finish_reason = "length";
    choice.message = { role: "assistant", content: "", reasoning: "Thinking until the budget ran out" };
    const { impl, calls } = fakeFetch([json(200, truncated)]);
    const result = await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])("does not retry HTTP %i", async (status) => {
    const body = { error: { code: status, message: "No cookie auth credentials found" } };
    const { impl, calls } = fakeFetch([json(status, body)]);
    const error = await callError(client(impl).call(REQUEST, CONTEXT));
    expect(error.kind).toBe("fatal");
    expect(error.status).toBe(status);
    expect(error.body).toEqual(body);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(calls).toHaveLength(1);
    expect(retries).toHaveLength(0);
  });

  it("does not retry a 402 without Retry-After, but does with it", async () => {
    const outOfCredits = { error: { code: 402, message: "Insufficient credits" } };
    const fatal = await callError(client(fakeFetch([json(402, outOfCredits)]).impl).call(REQUEST, CONTEXT));
    expect(fatal.kind).toBe("fatal");
    expect(fatal.status).toBe(402);

    const inFlight = json(
      402,
      { error: { code: 402, message: "In-flight budget", metadata: { limit_source: "openrouter_in_flight_budget" } } },
      { "Retry-After": "2" },
    );
    const { impl, calls } = fakeFetch([inFlight, json(200, completion())]);
    await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("classifies a 400 context overflow as context_length", async () => {
    const body = {
      error: {
        code: 400,
        message: "This endpoint's maximum context length is 1048576 tokens. However, you requested about 1100000 tokens.",
      },
    };
    const { impl, calls } = fakeFetch([json(400, body)]);
    const error = await callError(client(impl).call(REQUEST, CONTEXT));
    expect(error.kind).toBe("context_length");
    expect(error.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("classifies error_type context_length_exceeded as context_length, also inside a 200", async () => {
    const body = { error: { code: 400, message: "Input too long", metadata: { error_type: "context_length_exceeded" } } };
    const httpError = await callError(client(fakeFetch([json(400, body)]).impl).call(REQUEST, CONTEXT));
    expect(httpError.kind).toBe("context_length");
    const inBody = await callError(client(fakeFetch([json(200, body)]).impl).call(REQUEST, { ...CONTEXT, tick: 4 }));
    expect(inBody.kind).toBe("context_length");
  });

  it("caches a context_length failure and replays it without a request, offline too", async () => {
    const body = { error: { code: 400, message: "This endpoint's maximum context length is 1000 tokens." } };
    const { impl, calls } = fakeFetch([json(400, body, { "X-Generation-Id": "gen-overflow" })]);
    const first = await callError(client(impl).call(REQUEST, CONTEXT));
    expect(first.kind).toBe("context_length");
    const key = cacheKey(buildRequestBody(REQUEST), CONTEXT.seed, CONTEXT.tick, CONTEXT.agent);
    expect(first.cacheKey).toBe(key);
    const entry = new ResponseCache(dir).get(key)!;
    expect(entry).toMatchObject({
      response: body,
      headers: { "x-generation-id": "gen-overflow" },
      attempts: 1,
      error: { kind: "context_length", status: 400, message: first.message },
    });

    for (const replay of [client(impl), client(fakeFetch([]).impl, { offline: true, apiKey: null })]) {
      const again = await callError(replay.call(REQUEST, CONTEXT));
      expect(again).toMatchObject({ kind: "context_length", status: 400, message: first.message, cacheKey: key, body });
    }
    expect(calls).toHaveLength(1);
  });

  it("retries a response with malformed tool_calls, never caching it", async () => {
    const malformed = (mutate: (call: Record<string, unknown>) => void) => {
      const raw = completion();
      const message = (raw.choices as { message: { tool_calls: Record<string, unknown>[] } }[])[0]!.message;
      mutate(message.tool_calls[0]!);
      return json(200, raw);
    };
    const variants = [
      malformed((call) => delete (call.function as Record<string, unknown>).arguments),
      malformed((call) => ((call.function as Record<string, unknown>).arguments = null)),
      malformed((call) => ((call.function as Record<string, unknown>).arguments = { text: "hi" })),
      malformed((call) => delete call.function),
      malformed((call) => delete call.id),
    ];
    const { impl, calls } = fakeFetch([...variants, json(200, completion())]);
    const result = await client(impl, { maxRetries: 5 }).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(6);
    expect(retries.map((retry) => retry.reason)).toEqual(Array(5).fill(expect.stringContaining("malformed tool_calls")));
    expect(result.message.tool_calls).toHaveLength(2);

    const exhausted = await callError(
      client(fakeFetch([malformed((call) => delete call.function)]).impl, { maxRetries: 0 }).call(REQUEST, { ...CONTEXT, tick: 9 }),
    );
    expect(exhausted.kind).toBe("fatal");
    expect(new ResponseCache(dir).get(cacheKey(buildRequestBody(REQUEST), CONTEXT.seed, 9, CONTEXT.agent))).toBeNull();
  });

  it("classifies a choice-level error like a body error: a content-policy block is fatal at once", async () => {
    const blocked = completion();
    const choice = (blocked.choices as Record<string, unknown>[])[0]!;
    choice.finish_reason = "error";
    choice.error = { code: 403, message: "Flagged", metadata: { error_type: "content_policy_violation" } };
    const { impl, calls } = fakeFetch([json(200, blocked)]);
    const error = await callError(client(impl).call(REQUEST, CONTEXT));
    expect(error.kind).toBe("fatal");
    expect(error.message).toContain("content_policy_violation");
    expect(calls).toHaveLength(1);
    expect(retries).toHaveLength(0);
  });

  it("retries a bare finish_reason error that carries no error object", async () => {
    const failed = completion();
    (failed.choices as Record<string, unknown>[])[0]!.finish_reason = "error";
    const { impl, calls } = fakeFetch([json(200, failed), json(200, completion())]);
    await client(impl).call(REQUEST, CONTEXT);
    expect(calls).toHaveLength(2);
  });

  it("accepts a zero-token refusal, and a zero-token response with a finish reason, as answers", async () => {
    const refusal = emptyCompletion();
    const choice = (refusal.choices as Record<string, unknown>[])[0]!;
    choice.finish_reason = "content_filter";
    choice.message = { role: "assistant", content: null, refusal: "I can't help with that." };
    const stopped = emptyCompletion();
    (stopped.choices as Record<string, unknown>[])[0]!.finish_reason = "stop";
    const { impl, calls } = fakeFetch([json(200, refusal), json(200, stopped)]);
    const model = client(impl);
    expect((await model.call(REQUEST, CONTEXT)).message.refusal).toBe("I can't help with that.");
    expect((await model.call(REQUEST, { ...CONTEXT, tick: 4 })).finish_reason).toBe("stop");
    expect(calls).toHaveLength(2);
    expect(retries).toHaveLength(0);
  });

  it("refuses to send a key that can't go in a header, without quoting it", async () => {
    const { impl, calls } = fakeFetch([]);
    const badKey = `${API_KEY}\nsecond-line`;
    const error = await callError(client(impl, { apiKey: badKey }).call(REQUEST, CONTEXT));
    expect(error.kind).toBe("fatal");
    expect(error.message).not.toContain("second-line");
    expect(calls).toHaveLength(0);
  });

  it("redacts the key from failure reasons", async () => {
    const leaky = new TypeError(`Headers.append: "Bearer ${API_KEY}" is an invalid header value.`);
    const { impl } = fakeFetch([leaky, leaky]);
    const error = await callError(client(impl, { maxRetries: 1 }).call(REQUEST, CONTEXT));
    expect(retries[0]!.reason).toContain("[redacted]");
    expect(retries[0]!.reason).not.toContain(API_KEY);
    expect(error.message).toContain("[redacted]");
  });

  it("gives up with a fatal error after maxRetries retries and caches nothing", async () => {
    const badGateway = () => json(502, { error: { code: 502, message: "Provider down" } });
    const { impl, calls } = fakeFetch([badGateway(), badGateway(), badGateway()]);
    const error = await callError(client(impl, { maxRetries: 2 }).call(REQUEST, CONTEXT));
    expect(error.kind).toBe("fatal");
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/after 3 attempts.*HTTP 502.*Provider down/);
    expect(calls).toHaveLength(3);
    expect(retries).toHaveLength(2);
    const key = cacheKey(buildRequestBody(REQUEST), CONTEXT.seed, CONTEXT.tick, CONTEXT.agent);
    expect(new ResponseCache(dir).get(key)).toBeNull();
  });

  it("with maxRetries 0 the first retryable failure is fatal", async () => {
    const { impl, calls } = fakeFetch([json(503, { error: { code: 503, message: "busy" } })]);
    const error = await callError(client(impl, { maxRetries: 0 }).call(REQUEST, CONTEXT));
    expect(error.kind).toBe("fatal");
    expect(error.message).toMatch(/after 1 attempt;/);
    expect(calls).toHaveLength(1);
  });

  it("uses a custom base URL", async () => {
    const { impl, calls } = fakeFetch([json(200, completion())]);
    await client(impl, { baseUrl: "http://localhost:9999/api/v1/" }).call(REQUEST, CONTEXT);
    expect(calls[0]!.url).toBe("http://localhost:9999/api/v1/chat/completions");
  });

  it("by default uses undici's fetch: sends the body and times out a stalled response", async () => {
    const received: { body: string; headers: IncomingMessage["headers"] }[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ body, headers: req.headers });
        if (received.length === 1) return; // never answer the first attempt
        res.writeHead(200, { "Content-Type": "application/json", "X-Generation-Id": "gen-local" });
        res.end(JSON.stringify(completion()));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const model = createOpenRouterModelClient({
        apiKey: API_KEY,
        cacheDir: dir,
        offline: false,
        timeoutMs: 200,
        maxRetries: 1,
        onRetry: (info) => retries.push(info),
        sleep: async () => {},
        baseUrl: `http://127.0.0.1:${port}/api/v1`,
      });
      const result = await model.call(REQUEST, CONTEXT);
      expect(result.generation_id).toBe("gen-local");
      expect(retries.map((retry) => retry.reason)).toEqual([expect.stringMatching(/timed out/)]);
      expect(received).toHaveLength(2);
      expect(received[1]!.body).toBe(JSON.stringify(buildRequestBody(REQUEST)));
      expect(received[1]!.headers["x-openrouter-metadata"]).toBe("enabled");
      expect(received[1]!.headers["x-openrouter-title"]).toBe("swarm-experiment");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
