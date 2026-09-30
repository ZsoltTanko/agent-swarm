import type {
  ModelCallEvent,
  SleepReason,
  RunEndedEvent,
  RunStartedEvent,
  ToolCallEvent,
} from "./events.ts";
import type {
  AgentInfo,
  AgentStatus,
  DeliverableVersion,
  Post,
  Usage,
} from "./types.ts";

/**
 * The world of a run as of a selected tick, derived purely from its event log by
 * deriveRunState(events, tick) in ./derive.ts. Every UI view renders from this.
 * "As of tick T" means: every event with tick <= T has happened, nothing later has.
 */
export interface RunState {
  run_id: string;
  started: RunStartedEvent;
  /** Present when the log contains run_ended, regardless of the selected tick. */
  ended: RunEndedEvent | null;
  status: "running" | "ended";
  /** The selected tick, clamped to [0, latest_tick]. */
  tick: number;
  /** Highest tick present in the log. */
  latest_tick: number;
  tick_cap: number;
  /** In AgentInfo.index order. */
  agents: AgentView[];
  /** Posts up to the selected tick, in commit order. */
  posts: PostView[];
  /** Steps up to the selected tick, sorted by (tick, order_index). */
  steps: StepRecord[];
  step_by_key: Record<string, StepRecord>;
  /** Deliverable versions up to the selected tick (v1 first). */
  deliverable: DeliverableVersion[];
  /** First opens of each document by each agent, up to the selected tick. */
  coverage: CoverageCell[];
  /** One entry per tick of the whole run (not cut at the selected tick); activity[i].tick === i + 1. */
  activity: TickActivity[];
  /** Usage summed up to the selected tick, including run_ended's unapplied calls once it is reached. */
  usage: Usage;
  metrics: RunMetrics;
}

/** One agent's step: its model call at a tick and everything that call caused. */
export interface StepRecord {
  /** `${agent}@${tick}` */
  key: string;
  agent: string;
  tick: number;
  order_index: number;
  /** Seq of the step's first event. The request context is rebuildContext(events, agent, seq - 1). */
  seq: number;
  /** Null when the agent was stopped (e.g. context_full) without a response. */
  call: ModelCallEvent | null;
  tool_calls: ToolCallEvent[];
  posts_created: number[];
  /** Post ids delivered by read_board calls in this step. */
  posts_received: number[];
  docs_opened: { doc_id: string; first_open: boolean }[];
  /** Deliverable versions read in this step. */
  deliverable_reads: number[];
  /** Deliverable versions written in this step. */
  deliverable_writes: number[];
  /** The agent fell asleep at the end of this step: it called wait, or its response had no tool calls. */
  slept: boolean;
  /** Why it fell asleep; null when it didn't. */
  sleep_reason: SleepReason | null;
  /** The agent called done in this step. */
  done: boolean;
  /** Set when the agent was stopped in this step. */
  stopped: string | null;
  truncated: boolean;
  /** Number of tool calls that returned an error. */
  errors: number;
}

export interface AgentView {
  info: AgentInfo;
  status: AgentStatus;
  reads_left: number;
  /** First opens only. */
  docs_opened: { doc_id: string; tick: number }[];
  posts: number;
  steps: number;
  ticks_asleep: number;
  first_post_tick: number | null;
  done_tick: number | null;
  done_note: string | null;
  stopped_reason: string | null;
  /** Highest deliverable version this agent has read or written. */
  last_seen_deliverable: number;
  /** Posts by others not yet delivered to this agent. */
  unread_posts: number;
  usage: Usage;
}

export interface PostView extends Post {
  /** First delivery to each other agent, up to the selected tick. */
  received_by: { agent: string; tick: number }[];
  /** Ids of posts replying to this one. */
  replies: number[];
}

export interface CoverageCell {
  agent: string;
  doc_id: string;
  tick: number;
}

export interface TickActivity {
  tick: number;
  active: number;
  calls: number;
  posts: number;
  doc_opens: number;
  writes: number;
  sleeps: number;
  cost_usd: number;
}

export interface RunMetrics {
  coverage: {
    /** Documents opened by at least one agent. */
    opened: number;
    total: number;
    never_opened: string[];
    /** Sum over documents of (agents who opened it - 1), for documents opened at least once. */
    duplicate_opens: number;
  };
  board: {
    posts: number;
    replies: number;
    per_agent: Record<string, { posts: number; first_post_tick: number | null; mean_length: number }>;
  };
  /**
   * Posts made while the author had unread posts: posts by others that existed at the start of the
   * author's tick and hadn't been delivered to the author before its step. A read_board in the same step
   * doesn't count, whatever its position: the model wrote the post before any tool result came back.
   */
  posting_blind: { posts: number; with_unread: number };
  deliverable: {
    versions: number;
    authors: string[];
    /** Writes with writer_had_seen_replaced === false. */
    unseen_overwrites: number;
    final_length: number;
  };
  activity: Record<string, { steps: number; ticks_asleep: number; done_tick: number | null }>;
  cost: { usage: Usage; per_agent: Record<string, Usage> };
}
