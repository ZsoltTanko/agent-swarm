import { assistantForContext } from "../shared/context.ts";
import type { RunEventPayload, UnappliedCall } from "../shared/events.ts";
import { addUsage, ZERO_USAGE } from "../shared/types.ts";
import type { AgentInfo, ChatMessage, RunEndReason, ToolCall, Usage } from "../shared/types.ts";
import { World } from "./environment.ts";
import type { ToolOutcome } from "./environment.ts";
import { tickOrder } from "./rng.ts";
import { isToolName, parseJsonObject, parseToolArguments } from "./tools.ts";
import { ModelCallError } from "./types.ts";
import type { EngineOptions, ModelRequest, ModelResult, RunOutcome, TickSummary } from "./types.ts";

interface RunEnd {
  reason: RunEndReason;
  error: string | null;
  unapplied: UnappliedCall[];
}

/** A tool call's parts as the engine uses them; "" stands in for any that isn't a string. */
interface ToolCallParts {
  id: string;
  name: string;
  raw: string;
  /** The id, name, or arguments wasn't a string. */
  malformed: boolean;
}

/** Per-tick counts for the TickSummary. */
interface TickTally {
  posts: number;
  doc_opens: number;
  writes: number;
  cache_hits: number;
}

/**
 * Runs a swarm to completion. Each tick, every awake agent makes one model call (concurrently); the
 * results are then applied to the world one agent at a time in the tick's seeded order. Everything is
 * written to the event log, and each agent's context is exactly rebuildContext(events, agent).
 */
export async function runSwarm(options: EngineOptions): Promise<RunOutcome> {
  const { config, agents, log, model, tools, signal } = options;
  const offered = new Set<string>(tools.map((tool) => tool.function.name));
  const seed = config.run.seed;
  const tickCap = config.run.tick_cap;
  const names = agents.map((agent) => agent.name);
  const world = new World({ task: options.task, agents: names, environment: config.environment, tickCap });

  const contexts = new Map<string, ChatMessage[]>();
  for (const name of names) {
    const system = options.systemPrompts[name];
    if (system === undefined) throw new Error(`There is no system prompt for agent ${name}.`);
    contexts.set(name, [
      { role: "system", content: system },
      { role: "user", content: options.kickoff },
    ]);
  }
  const contextOf = (name: string): ChatMessage[] => contexts.get(name)!;
  const agentInfo = new Map<string, AgentInfo>(agents.map((agent) => [agent.name, agent]));
  /**
   * Per agent, the highest post id it can know of; 0 before its first step. It becomes the agent's sleep
   * marker if it falls asleep, so a post it never learned of still wakes it. It never decreases, and is
   * raised at the end of each of the agent's steps and when the agent is woken:
   * - at a step's end, with the status line on, to the highest post id that existed then (the status line
   *   has just told the agent how many posts are unread); with it off, to the highest post id the agent
   *   has been shown, since nothing else tells it about posts;
   * - at a wake, to the highest post id that exists: the wake is the notice.
   */
  const postMarkers = new Map<string, number>(names.map((name) => [name, 0]));
  const raiseMarker = (name: string, known: number): void => {
    postMarkers.set(name, Math.max(postMarkers.get(name)!, known));
  };

  let usage: Usage = ZERO_USAGE;
  let modelCalls = 0;
  let cacheHits = 0;
  let lastTick = 0;

  log.emit(0, {
    type: "run_started",
    run_id: options.runId,
    config,
    seed,
    agents,
    task: { name: options.task.name, text: options.task.text, docs: options.task.docs.map((doc) => doc.meta) },
    system_prompts: options.systemPrompts,
    kickoff: options.kickoff,
    tools,
    mode: options.mode,
    model_info: options.modelInfo,
  });

  async function runTick(tick: number): Promise<RunEnd | null> {
    const active = names.filter((name) => world.status(name) === "awake");
    const order = tickOrder(active, seed, tick);
    lastTick = tick;
    log.emit(tick, {
      type: "tick_started",
      active,
      order,
      asleep: names.filter((name) => world.status(name) === "asleep"),
      finished: names.filter((name) => isFinished(world.status(name))),
    });

    const requests = new Map<string, ModelRequest>();
    for (const name of active) {
      requests.set(name, {
        model: agentInfo.get(name)!.model,
        params: config.agents.model.params,
        messages: [...contextOf(name)],
        tools,
      });
    }
    const settled = await settleAll(active, config.run.max_concurrency, (name) =>
      model.call(requests.get(name)!, { agent: name, tick, seed, signal }),
    );

    // An aborted tick isn't applied, but the calls that did return were paid for: run_ended lists them.
    const unapplied = (): UnappliedCall[] =>
      active.flatMap((agent, index) => {
        const outcome = settled[index]!;
        if (outcome.status !== "fulfilled") return [];
        const result = outcome.value;
        return [{ agent, cache_key: result.cache_key, cache_hit: result.cache_hit, usage: result.usage }];
      });
    if (signal?.aborted) return { reason: "interrupted", error: null, unapplied: unapplied() };
    for (const outcome of settled) {
      if (outcome.status === "rejected" && !isContextLength(outcome.reason)) {
        return { reason: "api_error", error: errorMessage(outcome.reason), unapplied: unapplied() };
      }
    }

    const outcomes = new Map(active.map((name, index) => [name, settled[index]!]));
    const tally: TickTally = { posts: 0, doc_opens: 0, writes: 0, cache_hits: 0 };
    const emitDomain = (payload: RunEventPayload): void => {
      if (payload.type === "post_created") tally.posts += 1;
      else if (payload.type === "document_opened" && payload.first_open) tally.doc_opens += 1;
      else if (payload.type === "deliverable_written") tally.writes += 1;
      log.emit(tick, payload);
    };

    order.forEach((name, orderIndex) => {
      const outcome = outcomes.get(name)!;
      if (outcome.status === "rejected") {
        world.stop(name);
        log.emit(tick, {
          type: "agent_stopped",
          agent: name,
          reason: "context_full",
          detail: errorMessage(outcome.reason),
          cache_key: outcome.reason instanceof ModelCallError ? outcome.reason.cacheKey : null,
        });
        return;
      }
      const result = outcome.value;
      recordModelCall(tick, name, orderIndex, result, requests.get(name)!.messages.length);
      if (result.cache_hit) tally.cache_hits += 1;

      const toolCalls = Array.isArray(result.message.tool_calls) ? result.message.tool_calls : [];
      if (toolCalls.length === 0) {
        world.sleep(name, postMarkers.get(name)!);
        log.emit(tick, { type: "agent_slept", agent: name, reason: "no_tool_calls" });
        return;
      }
      toolCalls.forEach((call, index) => {
        const parts = toolCallParts(call);
        const { result: text, error, events, args } = applyToolCall(name, tick, parts, index);
        for (const payload of events) emitDomain(payload);
        const content =
          index === toolCalls.length - 1 && config.environment.status_line
            ? `${text}\n\n${world.statusLine(name, tick)}`
            : text;
        log.emit(tick, {
          type: "tool_call",
          agent: name,
          call_id: parts.id,
          index,
          name: parts.name,
          raw_arguments: parts.raw,
          arguments: args,
          result: content,
          error,
        });
        contextOf(name).push({ role: "tool", tool_call_id: parts.id, content });
      });
      raiseMarker(name, config.environment.status_line ? world.posts.length : world.highestKnownPost(name));
      if (world.waitRequested(name)) {
        world.sleep(name, postMarkers.get(name)!);
        log.emit(tick, { type: "agent_slept", agent: name, reason: "wait" });
      }
    });

    for (const name of names) {
      if (!world.shouldWake(name)) continue;
      world.wake(name);
      raiseMarker(name, world.posts.length);
      const message = config.environment.status_line ? world.statusLine(name, tick) : `[step ${tick}/${tickCap}]`;
      contextOf(name).push({ role: "user", content: message });
      log.emit(tick, { type: "agent_woke", agent: name, message });
    }

    const statuses = names.map((name) => world.status(name));
    const summary: TickSummary = {
      tick,
      active: active.length,
      posts: tally.posts,
      doc_opens: tally.doc_opens,
      writes: tally.writes,
      asleep: statuses.filter((status) => status === "asleep").length,
      finished: statuses.filter(isFinished).length,
      cache_hits: tally.cache_hits,
      cost_usd: usage.cost_usd,
    };
    options.onTick?.(summary);

    // A natural end is reported over a cap reached on the same tick.
    const end = (reason: RunEndReason): RunEnd => ({ reason, error: null, unapplied: [] });
    if (statuses.every((status) => status === "done")) return end("all_done");
    if (statuses.every(isFinished)) return end("all_stopped");
    if (!statuses.includes("awake")) return end("quiescent");
    if (usage.cost_usd >= config.run.max_cost_usd) return end("cost_cap");
    if (tick === tickCap) return end("tick_cap");
    return null;
  }

  function recordModelCall(
    tick: number,
    agent: string,
    orderIndex: number,
    result: ModelResult,
    requestMessages: number,
  ): void {
    log.emit(tick, {
      type: "model_call",
      agent,
      order_index: orderIndex,
      cache_key: result.cache_key,
      cache_hit: result.cache_hit,
      message: result.message,
      finish_reason: result.finish_reason,
      native_finish_reason: result.native_finish_reason,
      truncated: result.truncated,
      usage: result.usage,
      provider: result.provider,
      openrouter_metadata: result.openrouter_metadata,
      system_fingerprint: result.system_fingerprint,
      generation_id: result.generation_id,
      latency_ms: result.latency_ms,
      attempts: result.attempts,
      request_messages: requestMessages,
    });
    contextOf(agent).push(assistantForContext(result.message));
    modelCalls += 1;
    if (result.cache_hit) cacheHits += 1;
    usage = addUsage(usage, result.usage);
  }

  /** Decides what one tool call does. The first rule that applies wins. */
  function applyToolCall(
    agent: string,
    tick: number,
    call: ToolCallParts,
    index: number,
  ): ToolOutcome & { args: Record<string, unknown> | null } {
    const { name, raw } = call;
    const args = call.malformed ? null : parseJsonObject(raw);
    const limit = config.run.max_tool_calls_per_step;
    if (world.status(agent) === "done") {
      return { ...failure("You've already called done; this call was ignored."), args };
    }
    if (index >= limit) {
      return { ...failure(`Too many tool calls in one step (limit ${limit}). This call was ignored.`), args };
    }
    if (call.malformed) return { ...failure("Malformed tool call."), args };
    if (!isToolName(name) || !offered.has(name)) return { ...failure(`Unknown tool "${name}".`), args };
    const parsed = parseToolArguments(name, raw);
    if (!parsed.ok) return { ...failure(parsed.error), args };
    return { ...world.execute(agent, tick, name, parsed.args), args: parsed.args };
  }

  let end: RunEnd | null = null;
  for (let tick = 1; tick <= tickCap && end === null; tick++) {
    end = signal?.aborted ? { reason: "interrupted", error: null, unapplied: [] } : await runTick(tick);
  }
  // runTick always ends the run at tick_cap, so `end` is set here.
  const { reason, error, unapplied } = end ?? { reason: "tick_cap", error: null, unapplied: [] };
  for (const call of unapplied) usage = addUsage(usage, call.usage);

  const totals = {
    ticks: lastTick,
    model_calls: modelCalls,
    cache_hits: cacheHits,
    usage,
    posts: world.posts.length,
    deliverable_versions: world.versions.length,
  };
  log.emit(lastTick, { type: "run_ended", reason, error, totals, unapplied });
  return { reason, error, totals, unapplied, finalDeliverable: world.deliverableText };
}

/**
 * The client validates tool calls before a response is used, but the engine reads them defensively, so
 * that a malformed one (from an old cache entry, say) becomes a tool error instead of a crash.
 */
function toolCallParts(call: ToolCall): ToolCallParts {
  const loose = call as unknown as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
  const id = loose?.id;
  const name = loose?.function?.name;
  const raw = loose?.function?.arguments;
  return {
    id: typeof id === "string" ? id : "",
    name: typeof name === "string" ? name : "",
    raw: typeof raw === "string" ? raw : "",
    malformed: typeof id !== "string" || typeof name !== "string" || typeof raw !== "string",
  };
}

function isFinished(status: string): boolean {
  return status === "done" || status === "stopped";
}

function isContextLength(error: unknown): boolean {
  return error instanceof ModelCallError && error.kind === "context_length";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: string): ToolOutcome {
  return { result: error, error, events: [] };
}

/** Runs fn over items with at most `limit` in flight; results are in item order. */
async function settleAll<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
