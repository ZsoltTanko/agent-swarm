import { Agent, fetch as undiciFetch } from "undici";
import { HARNESS_OWNED_PARAMS } from "../../shared/config.ts";
import { MAX_BACKOFF_MS, MAX_JITTER_MS } from "../../shared/retry.ts";
import type { AssistantMessage, Usage } from "../../shared/types.ts";
import { ResponseCache, cacheKey, type CachedResponse } from "../cache.ts";
import {
  ModelCallError,
  type CallContext,
  type ModelClient,
  type ModelRequest,
  type ModelResult,
} from "../types.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface RetryInfo {
  /** 1-based number of the retry about to be made. */
  attempt: number;
  delayMs: number;
  /** Why the previous attempt failed. */
  reason: string;
  agent: string;
  tick: number;
}

export interface OpenRouterClientOptions {
  /** Null when no key is configured: cache hits still work, misses are fatal. */
  apiKey: string | null;
  cacheDir: string;
  /** Any cache miss is an error (kind "cache_miss"). */
  offline: boolean;
  /** Per attempt, covering headers and body. */
  timeoutMs: number;
  /** Retries after the first attempt. */
  maxRetries: number;
  onRetry?: (info: RetryInfo) => void;
  /** Defaults to undici's fetch with headers/body timeouts raised to timeoutMs. */
  fetchImpl?: typeof fetch;
  /** The backoff wait. It should end early when `signal` aborts; the default does. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  baseUrl?: string;
}

/** Statuses (HTTP, or error.code inside a 200 body) worth retrying. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 524, 529]);
const RETRYABLE_ERROR_TYPES = new Set([
  "provider_overloaded",
  "provider_unavailable",
  "timeout",
  "server",
  "rate_limit_exceeded",
]);
const CONTEXT_OVERFLOW_MESSAGE = /context length|context window|maximum context|too many tokens|prompt is too long/i;

/**
 * Visible ASCII only. Anything else (a space, a line break from a quoted .env value) can't be sent in
 * the Authorization header, and fetch's error for it would quote the whole key.
 */
export function isSendableApiKey(key: string): boolean {
  return /^[\x21-\x7e]+$/.test(key);
}

/** The request body: { model, ...params, messages, tools }. Params may not set harness-owned keys. */
export function buildRequestBody(request: ModelRequest): Record<string, unknown> {
  for (const key of HARNESS_OWNED_PARAMS) {
    if (Object.hasOwn(request.params, key)) {
      throw new Error(`Model params may not set "${key}"; the harness sets it.`);
    }
  }
  return { model: request.model, ...request.params, messages: request.messages, tools: request.tools };
}

export function createOpenRouterModelClient(options: OpenRouterClientOptions): ModelClient {
  const cache = new ResponseCache(options.cacheDir);
  const url = `${(options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const sleep = options.sleep ?? sleepUnlessAborted;
  let fetchImpl = options.fetchImpl;

  function store(entry: CachedResponse): void {
    try {
      cache.put(entry);
    } catch (error) {
      throw new ModelCallError(`Could not write the response cache: ${(error as Error).message}`, "fatal");
    }
  }

  /** Failure reasons can quote request headers; the key never leaves the client in one. */
  function redact(text: string): string {
    return options.apiKey ? text.replaceAll(options.apiKey, "[redacted]") : text;
  }

  async function call(request: ModelRequest, context: CallContext): Promise<ModelResult> {
    let body: Record<string, unknown>;
    try {
      body = buildRequestBody(request);
    } catch (error) {
      throw new ModelCallError((error as Error).message, "fatal");
    }
    const key = cacheKey(body, context.seed, context.tick, context.agent);

    let cached: CachedResponse | null;
    try {
      cached = cache.get(key);
    } catch (error) {
      throw new ModelCallError((error as Error).message, "fatal");
    }
    if (cached?.error) {
      throw new ModelCallError(cached.error.message, cached.error.kind, cached.error.status, cached.response, key);
    }
    if (cached) return parseCompletion(cached.response, cached.headers, cached.latency_ms, key, true, cached.attempts);

    if (options.offline) {
      throw new ModelCallError(
        `Offline and no cached response for ${context.agent} at tick ${context.tick} (cache key ${key}).`,
        "cache_miss",
      );
    }
    if (options.apiKey === null) {
      throw new ModelCallError("No OpenRouter API key is configured (set OPENROUTER_API_KEY).", "fatal");
    }
    if (!isSendableApiKey(options.apiKey)) {
      throw new ModelCallError(
        "The OpenRouter API key contains a space, line break, or other character that can't be sent in an HTTP header.",
        "fatal",
      );
    }

    fetchImpl ??= createUndiciFetch(options.timeoutMs);
    const bodyText = JSON.stringify(body);
    const headers = {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "swarm-experiment",
      "X-OpenRouter-Metadata": "enabled",
    };

    for (let attempt = 0; ; attempt++) {
      if (context.signal?.aborted) throw interruptedError(context);
      const outcome = await attemptOnce(fetchImpl, url, headers, bodyText, options.timeoutMs, context.signal);
      const attempts = attempt + 1;
      if (outcome.kind === "success") {
        store({
          key,
          request: body,
          response: outcome.raw,
          headers: outcome.headers,
          latency_ms: outcome.latencyMs,
          attempts,
          created_at: new Date().toISOString(),
        });
        return parseCompletion(outcome.raw, outcome.headers, outcome.latencyMs, key, false, attempts);
      }
      if (outcome.kind === "interrupted") throw interruptedError(context);
      const reason = redact(outcome.reason);
      if (outcome.kind === "context_length") {
        // Final for this request, like a response: cached so that re-runs stop the agent the same way.
        const error = { kind: outcome.kind, status: outcome.status, message: reason };
        store({
          key,
          request: body,
          response: outcome.body,
          headers: outcome.headers,
          latency_ms: outcome.latencyMs,
          attempts,
          created_at: new Date().toISOString(),
          error,
        });
        throw new ModelCallError(reason, outcome.kind, outcome.status, outcome.body, key);
      }
      if (outcome.kind === "fatal") throw new ModelCallError(reason, outcome.kind, outcome.status, outcome.body);
      if (attempt >= options.maxRetries) {
        throw new ModelCallError(
          `OpenRouter call failed after ${attempts} attempt${attempts === 1 ? "" : "s"}; last failure: ${reason}`,
          "fatal",
          outcome.status,
          outcome.body,
        );
      }
      const delayMs =
        outcome.retryAfterMs ??
        Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) + Math.round(Math.random() * MAX_JITTER_MS);
      options.onRetry?.({ attempt: attempts, delayMs, reason, agent: context.agent, tick: context.tick });
      await sleep(delayMs, context.signal);
    }
  }

  return { call };
}

function interruptedError(context: CallContext): ModelCallError {
  return new ModelCallError(`The call for ${context.agent} at tick ${context.tick} was interrupted.`, "interrupted");
}

/** Waits `ms`, or less if `signal` aborts first. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/**
 * Node's global fetch caps headers and body at 300 s through its global dispatcher, too short for
 * long non-streaming reasoning calls. This fetch uses a dispatcher with both raised to timeoutMs.
 */
function createUndiciFetch(timeoutMs: number): typeof fetch {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const fetchWithDispatcher = (input: string, init: RequestInit) =>
    undiciFetch(input, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher });
  return fetchWithDispatcher as unknown as typeof fetch;
}

type AttemptOutcome =
  | { kind: "success"; raw: unknown; headers: Record<string, string>; latencyMs: number }
  | { kind: "interrupted" }
  | { kind: "retryable"; reason: string; status: number | null; body: unknown; retryAfterMs: number | null }
  | { kind: "fatal"; reason: string; status: number | null; body: unknown }
  | {
      kind: "context_length";
      reason: string;
      status: number;
      body: unknown;
      headers: Record<string, string>;
      latencyMs: number;
    };

async function attemptOnce(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  bodyText: string,
  timeoutMs: number,
  interrupt: AbortSignal | undefined,
): Promise<AttemptOutcome> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  let status: number;
  let responseHeaders: Record<string, string>;
  let text: string;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: bodyText,
      signal: interrupt ? AbortSignal.any([timeout, interrupt]) : timeout,
    });
    status = response.status;
    responseHeaders = collectHeaders(response.headers);
    text = await response.text();
  } catch (error) {
    if (interrupt?.aborted) return { kind: "interrupted" };
    const reason = describeFetchError(error, timeoutMs);
    return { kind: "retryable", reason, status: null, body: null, retryAfterMs: null };
  }
  const latencyMs = Math.round(performance.now() - started);
  const retryAfterMs = parseRetryAfter(responseHeaders["retry-after"]);
  const parsed = parseJson(text);
  const body = parsed === undefined ? text : parsed;
  const contextLength = (reason: string): AttemptOutcome => ({
    kind: "context_length",
    reason,
    status,
    body,
    headers: responseHeaders,
    latencyMs,
  });

  if (status < 200 || status > 299) {
    const error = errorObject(body);
    const detail = error ? describeError(error) : excerpt(text);
    const reason = `HTTP ${status}: ${detail}`;
    if (isContextOverflow(error, status)) return contextLength(reason);
    if (RETRYABLE_STATUSES.has(status) || (status === 402 && retryAfterMs !== null)) {
      return { kind: "retryable", reason, status, body, retryAfterMs };
    }
    return { kind: "fatal", reason, status, body };
  }

  if (!isRecord(body)) {
    const reason = `HTTP ${status} with a body that isn't a JSON object: ${excerpt(text)}`;
    return { kind: "retryable", reason, status, body, retryAfterMs };
  }

  const topError = errorObject(body);
  if (topError) {
    const reason = `HTTP ${status} carrying an error: ${describeError(topError)}`;
    if (isContextOverflow(topError, null)) return contextLength(reason);
    if (isRetryableBodyError(topError)) return { kind: "retryable", reason, status, body, retryAfterMs };
    return { kind: "fatal", reason, status, body };
  }

  const choice = firstChoice(body);
  if (!choice || !isRecord(choice.message)) {
    return { kind: "retryable", reason: `HTTP ${status} without choices[0].message`, status, body, retryAfterMs };
  }
  const choiceError = errorObject(choice);
  if (choiceError || choice.finish_reason === "error") {
    const detail = choiceError ? describeError(choiceError) : "finish_reason is \"error\"";
    const reason = `HTTP ${status} with a failed choice: ${detail}`;
    if (choiceError && isContextOverflow(choiceError, null)) return contextLength(reason);
    // Classified like an error in the body; a bare finish_reason "error" says nothing more, so it's retried.
    if (!choiceError || isRetryableBodyError(choiceError)) return { kind: "retryable", reason, status, body, retryAfterMs };
    return { kind: "fatal", reason, status, body };
  }
  if (isEmptyCompletion(choice, body.usage)) {
    const reason = `HTTP ${status} with an empty completion (no content, tool calls, or reasoning)`;
    return { kind: "retryable", reason, status, body, retryAfterMs };
  }
  if (!hasWellFormedToolCalls(choice.message)) {
    // Never cached or applied: the engine replays tool calls verbatim and reads their names and arguments.
    const reason = `HTTP ${status} with malformed tool_calls (each needs a string id, function.name, and function.arguments)`;
    return { kind: "retryable", reason, status, body, retryAfterMs };
  }
  return { kind: "success", raw: body, headers: responseHeaders, latencyMs };
}

/**
 * Turns a raw chat-completion body (validated by the client, or read back from the cache) into a
 * ModelResult. The assistant message is kept verbatim.
 */
export function parseCompletion(
  raw: unknown,
  headers: Record<string, string>,
  latencyMs: number,
  key: string,
  cacheHit: boolean,
  attempts: number,
): ModelResult {
  const record = isRecord(raw) ? raw : {};
  const choice = firstChoice(record);
  if (!choice || !isRecord(choice.message)) {
    throw new ModelCallError(`Response for cache key ${key} has no choices[0].message.`, "fatal", null, raw);
  }
  const finishReason = stringOrNull(choice.finish_reason);
  const metadata = record.openrouter_metadata ?? null;
  return {
    message: choice.message as AssistantMessage,
    finish_reason: finishReason,
    native_finish_reason: stringOrNull(choice.native_finish_reason),
    truncated: finishReason === "length",
    usage: parseUsage(record.usage),
    provider: stringOrNull(record.provider) ?? selectedProvider(metadata),
    openrouter_metadata: metadata,
    system_fingerprint: stringOrNull(record.system_fingerprint),
    generation_id: headers["x-generation-id"] ?? stringOrNull(record.id),
    latency_ms: latencyMs,
    cache_key: key,
    cache_hit: cacheHit,
    attempts,
  };
}

function parseUsage(value: unknown): Usage {
  const usage = isRecord(value) ? value : {};
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return {
    prompt_tokens: numberOrZero(usage.prompt_tokens),
    completion_tokens: numberOrZero(usage.completion_tokens),
    reasoning_tokens: numberOrZero(completionDetails.reasoning_tokens),
    cached_tokens: numberOrZero(promptDetails.cached_tokens),
    cost_usd: numberOrZero(usage.cost),
  };
}

/** The provider marked selected in openrouter_metadata.endpoints.available. */
function selectedProvider(metadata: unknown): string | null {
  if (!isRecord(metadata) || !isRecord(metadata.endpoints)) return null;
  const available = metadata.endpoints.available;
  if (!Array.isArray(available)) return null;
  const selected = available.find((entry) => isRecord(entry) && entry.selected === true) as
    | Record<string, unknown>
    | undefined;
  return selected ? stringOrNull(selected.provider) : null;
}

/**
 * A zero-token response as OpenRouter defines it (and doesn't bill): no completion tokens and a blank
 * finish reason, here also with no content, refusal, tool calls, or reasoning. Typically a cold start.
 * A response that finished for a reason, a refusal among them, is an answer.
 */
function isEmptyCompletion(choice: Record<string, unknown>, usage: unknown): boolean {
  const message = choice.message as Record<string, unknown>;
  const finishReason = choice.finish_reason;
  const blankFinish = finishReason === null || finishReason === undefined || finishReason === "";
  const hasText = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const hasReasoning =
    (typeof message.reasoning === "string" && message.reasoning.length > 0) ||
    (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0);
  return (
    blankFinish &&
    !hasText(message.content) &&
    !hasText(message.refusal) &&
    !hasToolCalls &&
    !hasReasoning &&
    parseUsage(usage).completion_tokens === 0
  );
}

/** tool_calls is absent, null, or a list of { id, function: { name, arguments } } with string values. */
function hasWellFormedToolCalls(message: Record<string, unknown>): boolean {
  const calls = message.tool_calls;
  if (calls === undefined || calls === null) return true;
  if (!Array.isArray(calls)) return false;
  return calls.every(
    (call: unknown) =>
      isRecord(call) &&
      typeof call.id === "string" &&
      isRecord(call.function) &&
      typeof call.function.name === "string" &&
      typeof call.function.arguments === "string",
  );
}

function isRetryableBodyError(error: Record<string, unknown>): boolean {
  const code = typeof error.code === "number" ? error.code : Number(error.code);
  if (RETRYABLE_STATUSES.has(code)) return true;
  const type = errorType(error);
  return type !== null && (RETRYABLE_ERROR_TYPES.has(type) || type.startsWith("provider_"));
}

/** A context-window overflow, by typed error or (on HTTP 400) by message. */
function isContextOverflow(error: Record<string, unknown> | null, httpStatus: number | null): boolean {
  if (!error) return false;
  if (errorType(error) === "context_length_exceeded") return true;
  const code = httpStatus ?? (typeof error.code === "number" ? error.code : Number(error.code));
  return code === 400 && typeof error.message === "string" && CONTEXT_OVERFLOW_MESSAGE.test(error.message);
}

function errorType(error: Record<string, unknown>): string | null {
  return isRecord(error.metadata) ? stringOrNull(error.metadata.error_type) : null;
}

/** The `error` member of a body or choice, when it is set. */
function errorObject(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const error = value.error;
  if (isRecord(error)) return error;
  if (typeof error === "string" && error.length > 0) return { message: error };
  return null;
}

function describeError(error: Record<string, unknown>): string {
  const parts: string[] = [];
  if (error.code !== undefined) parts.push(`code ${String(error.code)}`);
  const type = errorType(error);
  if (type) parts.push(type);
  const message = typeof error.message === "string" ? error.message : "";
  const head = parts.length > 0 ? `[${parts.join(", ")}] ` : "";
  return `${head}${excerpt(message) || "(no message)"}`;
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code;
  if (err?.name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  }
  const cause = code ?? err?.cause?.message;
  return `network error: ${err?.message ?? String(error)}${cause ? ` (${cause})` : ""}`;
}

function firstChoice(record: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(record.choices)) return null;
  const choice: unknown = record.choices[0];
  return isRecord(choice) ? choice : null;
}

/** Lowercased response headers; set-cookie is left out. */
function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower !== "set-cookie") out[lower] = value;
  });
  return out;
}

/** Retry-After in ms, from delta-seconds or an HTTP date; null when absent or unparseable. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function excerpt(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
