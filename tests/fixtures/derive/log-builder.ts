import { RunConfigSchema } from "../../../src/shared/config.ts";
import type { RunEvent, RunEventPayload, SleepReason, UnappliedCall } from "../../../src/shared/events.ts";
import type { DeliverableVersion, RunEndReason, Usage } from "../../../src/shared/types.ts";

export const CALL_USAGE: Usage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  reasoning_tokens: 40,
  cached_tokens: 200,
  cost_usd: 0.25,
};

export interface LogOptions {
  readBudget?: number;
  tickCap?: number;
}

/**
 * Builds synthetic event logs by hand. Assigns seq and at, tracks the current tick and its
 * shuffle order, numbers posts and deliverable versions, and pairs each tool's domain events
 * with its tool_call event in the order the engine emits them.
 */
export class LogBuilder {
  readonly events: RunEvent[] = [];
  private currentTick = 0;
  private order: string[] = [];
  private readonly toolIndex = new Map<string, number>();
  private nextPostId = 1;
  private readonly versions: DeliverableVersion[] = [];

  constructor(
    private readonly agents: string[],
    docs: string[],
    options: LogOptions = {},
  ) {
    const config = RunConfigSchema.parse({
      task: "tasks/example",
      agents: { count: agents.length, model: { id: "test/model" } },
      environment: { doc_read_budget: options.readBudget ?? 2 },
      run: { tick_cap: options.tickCap ?? 10 },
    });
    this.emit({
      type: "run_started",
      run_id: "test-run",
      config,
      seed: 1,
      agents: agents.map((name, index) => ({ name, index, model: "test/model" })),
      task: {
        name: "example",
        text: "Write a memo.",
        docs: docs.map((id) => ({ id, filename: `${id}.md`, title: id, words: 100, chars: 600, sha256: id })),
      },
      system_prompts: Object.fromEntries(agents.map((name) => [name, `You are ${name}.`])),
      kickoff: "Check the board and introduce yourself before you start.",
      tools: [],
      mode: "live",
      model_info: null,
    });
  }

  emit(payload: RunEventPayload, tick = this.currentTick): RunEvent {
    const seq = this.events.length;
    const at = new Date(Date.UTC(2026, 8, 28, 12, 0, 0, seq * 10)).toISOString();
    const event = { seq, tick, at, ...payload } as RunEvent;
    this.events.push(event);
    return event;
  }

  startTick(tick: number, order: string[], state: { asleep?: string[]; finished?: string[] } = {}): this {
    this.currentTick = tick;
    this.order = order;
    this.toolIndex.clear();
    const active = [...order].sort((a, b) => this.agents.indexOf(a) - this.agents.indexOf(b));
    this.emit({ type: "tick_started", active, order, asleep: state.asleep ?? [], finished: state.finished ?? [] });
    return this;
  }

  call(agent: string, options: { usage?: Partial<Usage>; truncated?: boolean } = {}): RunEvent {
    return this.emit({
      type: "model_call",
      agent,
      order_index: this.order.indexOf(agent),
      cache_key: `key-${agent}-${this.currentTick}`,
      cache_hit: false,
      message: { role: "assistant", content: `${agent} thinking at ${this.currentTick}` },
      finish_reason: options.truncated ? "length" : "tool_calls",
      native_finish_reason: null,
      truncated: options.truncated ?? false,
      usage: { ...CALL_USAGE, ...options.usage },
      provider: "test",
      openrouter_metadata: null,
      system_fingerprint: null,
      generation_id: null,
      latency_ms: 1200,
      attempts: 1,
      request_messages: 2,
    });
  }

  tool(agent: string, name: string, args: Record<string, unknown> = {}, error: string | null = null): RunEvent {
    const index = this.toolIndex.get(agent) ?? 0;
    this.toolIndex.set(agent, index + 1);
    return this.emit({
      type: "tool_call",
      agent,
      call_id: `call-${agent}-${this.currentTick}-${index}`,
      index,
      name,
      raw_arguments: JSON.stringify(args),
      arguments: args,
      result: error ?? "ok",
      error,
    });
  }

  post(agent: string, text: string, replyTo: number | null = null): number {
    const id = this.nextPostId++;
    this.emit({ type: "post_created", post: { id, author: agent, tick: this.currentTick, text, reply_to: replyTo } });
    this.tool(agent, "post_message", replyTo === null ? { text } : { text, reply_to: replyTo });
    return id;
  }

  readBoard(agent: string, postIds: number[]): this {
    this.emit({ type: "board_delivered", agent, post_ids: postIds });
    this.tool(agent, "read_board");
    return this;
  }

  openDoc(agent: string, docId: string, firstOpen: boolean, readsLeft: number): this {
    this.emit({ type: "document_opened", agent, doc_id: docId, first_open: firstOpen, reads_left: readsLeft });
    this.tool(agent, "read_document", { id: docId });
    return this;
  }

  readDeliverable(agent: string, version: number): this {
    this.emit({ type: "deliverable_read", agent, version });
    this.tool(agent, "read_deliverable");
    return this;
  }

  write(agent: string, text: string, writerHadSeenReplaced: boolean): DeliverableVersion {
    const replaced = this.versions.at(-1);
    const version: DeliverableVersion = {
      version: this.versions.length + 1,
      author: agent,
      tick: this.currentTick,
      text,
      replaced_version: replaced?.version ?? 0,
      replaced_author: replaced?.author ?? null,
      writer_had_seen_replaced: writerHadSeenReplaced,
    };
    this.versions.push(version);
    this.emit({ type: "deliverable_written", version });
    this.tool(agent, "write_deliverable", { text });
    return version;
  }

  sleep(agent: string, reason: SleepReason = "no_tool_calls"): this {
    this.emit({ type: "agent_slept", agent, reason });
    return this;
  }

  wake(agent: string): this {
    this.emit({ type: "agent_woke", agent, message: `[step ${this.currentTick + 1}/10 · 1 unread posts]` });
    return this;
  }

  done(agent: string, note: string | null): this {
    this.emit({ type: "agent_done", agent, note });
    this.tool(agent, "done", note === null ? {} : { note });
    return this;
  }

  stop(agent: string): this {
    this.emit({
      type: "agent_stopped",
      agent,
      reason: "context_full",
      detail: "context would exceed 1000 tokens",
      cache_key: `key-${agent}-${this.currentTick}`,
    });
    return this;
  }

  end(reason: RunEndReason, tick = this.currentTick, unapplied: UnappliedCall[] = []): this {
    this.emit(
      {
        type: "run_ended",
        reason,
        error: null,
        totals: {
          ticks: tick,
          model_calls: 0,
          cache_hits: 0,
          usage: { ...CALL_USAGE },
          posts: this.nextPostId - 1,
          deliverable_versions: this.versions.length,
        },
        unapplied,
      },
      tick,
    );
    return this;
  }
}
