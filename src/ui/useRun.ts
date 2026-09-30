/**
 * The run view's data layer: loading a run's event log and following it live, plus pure helpers over
 * the log and the derived RunState that several views share (tick resolution, per-tick indexes,
 * step summaries, and cross-link highlights).
 */
import { useEffect, useState } from "react";
import { staleAfterMs } from "../shared/api.ts";
import type { RunConfig } from "../shared/config.ts";
import { stepKey } from "../shared/derive.ts";
import type { RunEndedEvent, RunEvent, TickStartedEvent } from "../shared/events.ts";
import type { RunState, StepRecord } from "../shared/runstate.ts";
import { errorMessage, fetchEvents, streamEvents } from "./api.ts";
import type { Selection } from "./contract.ts";
import type { TickParam } from "./url.ts";

/* ---------- Loading ---------- */

/**
 * loading: fetching the log. error: it couldn't be loaded. waiting: the run folder exists but hasn't
 * logged run_started yet (the stream is open and will fill it). ready: events[0] is run_started.
 */
export type RunPhase = "loading" | "error" | "waiting" | "ready";

export interface RunData {
  phase: RunPhase;
  /** Every event received so far, seq ascending. A new array whenever events arrive. */
  events: readonly RunEvent[];
  error: string | null;
  /** Set when live updates stopped with an error: the log shown may be behind. */
  streamError: string | null;
  /** The live stream is open. */
  streaming: boolean;
  /** The live stream lost its connection and the browser is trying to reconnect. */
  reconnecting: boolean;
  /** Reloads the log and reopens the stream. */
  retry(): void;
}

/** `batch` appended to `events`, skipping anything already there (by seq). Returns `events` itself when nothing is new. */
export function appendEvents(events: readonly RunEvent[], batch: readonly RunEvent[]): readonly RunEvent[] {
  const lastSeq = events.at(-1)?.seq ?? -1;
  const fresh = batch.filter((event) => event.seq > lastSeq);
  return fresh.length === 0 ? events : [...events, ...fresh];
}

/**
 * Loads a run's log, then, unless it already ended, streams new events from the last seq + 1 and
 * appends each batch. The stream closes once run_ended arrives.
 */
export function useRun(runId: string): RunData {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ runId: string; attempt: number } | null>(null);
  const [events, setEvents] = useState<readonly RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let closeStream: (() => void) | null = null;
    setLoaded(null);
    setEvents([]);
    setError(null);
    setStreamError(null);
    setStreaming(false);
    setReconnecting(false);

    fetchEvents(runId)
      .then((initial) => {
        if (cancelled) return;
        setEvents(initial);
        setLoaded({ runId, attempt });
        if (initial.at(-1)?.type === "run_ended") return;
        setStreaming(true);
        closeStream = streamEvents(
          runId,
          (initial.at(-1)?.seq ?? -1) + 1,
          (batch) => {
            if (!cancelled) setEvents((previous) => appendEvents(previous, batch));
          },
          () => {
            if (!cancelled) setStreaming(false);
          },
          (streamFailure) => {
            if (cancelled) return;
            setStreaming(false);
            setReconnecting(false);
            setStreamError(
              streamFailure instanceof Error ? streamFailure.message : "The live connection to the server was lost.",
            );
          },
          (connected) => {
            if (!cancelled) setReconnecting(!connected);
          },
        );
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(errorMessage(failure));
        setLoaded({ runId, attempt });
      });

    return () => {
      cancelled = true;
      closeStream?.();
    };
  }, [runId, attempt]);

  const current = loaded !== null && loaded.runId === runId && loaded.attempt === attempt;
  let phase: RunPhase;
  let shownError = error;
  if (!current) phase = "loading";
  else if (error !== null) phase = "error";
  else if (events.length === 0) phase = "waiting";
  else if (events[0]?.type !== "run_started") {
    phase = "error";
    shownError = "The event log doesn't start with run_started.";
  } else phase = "ready";

  return {
    phase,
    events: current ? events : [],
    error: shownError,
    streamError,
    streaming,
    reconnecting: current && reconnecting,
    retry: () => setAttempt((n) => n + 1),
  };
}

/** Date.now(), refreshed every `intervalMs`; null stops the refreshes. */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* ---------- The log ---------- */

/** The highest tick in the log (ticks never decrease along the log). */
export function latestTickOf(events: readonly RunEvent[]): number {
  return events.at(-1)?.tick ?? 0;
}

/** run_ended, which is always the last event, or null while the run is going. */
export function endedEventOf(events: readonly RunEvent[]): RunEndedEvent | null {
  const last = events.at(-1);
  return last?.type === "run_ended" ? last : null;
}

/**
 * Whether a run that hasn't ended has gone quiet for longer than any healthy tick could take (the
 * harness was probably killed). Mirrors the server's rule, timed from the last event's timestamp.
 */
export function isStale(events: readonly RunEvent[], nowMs: number): boolean {
  const first = events[0];
  const last = events.at(-1);
  if (first?.type !== "run_started" || !last || last.type === "run_ended") return false;
  const lastAt = Date.parse(last.at);
  if (Number.isNaN(lastAt)) return false;
  return nowMs - lastAt > staleAfterMs(first.config);
}

/** The endpoint the run is pinned to: the first entry of the model params' provider.order, if any. */
export function pinnedEndpoint(config: RunConfig): string | null {
  const provider = config.agents.model.params["provider"];
  if (typeof provider !== "object" || provider === null) return null;
  const order = (provider as { order?: unknown }).order;
  if (!Array.isArray(order)) return null;
  const first: unknown = order[0];
  return typeof first === "string" && first.length > 0 ? first : null;
}

/** The tick to show for the URL's tick parameter, and whether the view follows new ticks as they arrive. */
export function resolveTick(
  param: TickParam,
  latestTick: number,
  running: boolean,
): { tick: number; following: boolean } {
  if (param === null || param === "live") return { tick: latestTick, following: running };
  return { tick: Math.min(Math.max(Math.floor(param), 0), latestTick), following: false };
}

/** Facts about the whole log that the state as of a tick doesn't carry. Built in one pass. */
export interface LogIndex {
  /** tick_started by tick. */
  tickStarts: Map<number, TickStartedEvent>;
  /** Ticks at whose end each agent was woken. */
  wakes: Map<string, Set<number>>;
  /** Ticks at which each agent took a step (a model call, or a stop without one), ascending. */
  stepTicks: Map<string, number[]>;
  /** The tick each post was created in. */
  postTicks: Map<number, number>;
  /** The tick each deliverable version was written in. */
  versionTicks: Map<number, number>;
}

export function indexLog(events: readonly RunEvent[]): LogIndex {
  const index: LogIndex = {
    tickStarts: new Map(),
    wakes: new Map(),
    stepTicks: new Map(),
    postTicks: new Map(),
    versionTicks: new Map(),
  };
  const addStep = (agent: string, tick: number) => {
    const ticks = index.stepTicks.get(agent);
    if (!ticks) index.stepTicks.set(agent, [tick]);
    else if (ticks.at(-1) !== tick) ticks.push(tick);
  };
  for (const event of events) {
    switch (event.type) {
      case "tick_started":
        index.tickStarts.set(event.tick, event);
        break;
      case "model_call":
      case "agent_stopped":
        addStep(event.agent, event.tick);
        break;
      case "agent_woke": {
        const ticks = index.wakes.get(event.agent) ?? new Set<number>();
        ticks.add(event.tick);
        index.wakes.set(event.agent, ticks);
        break;
      }
      case "post_created":
        index.postTicks.set(event.post.id, event.tick);
        break;
      case "deliverable_written":
        index.versionTicks.set(event.version.version, event.tick);
        break;
      default:
        break;
    }
  }
  return index;
}

/**
 * The tick of the agent's next (delta 1) or previous (delta -1) step relative to `fromTick`, over the
 * whole log; null when there is none.
 */
export function neighborStepTick(index: LogIndex, agent: string, fromTick: number, delta: 1 | -1): number | null {
  const ticks = index.stepTicks.get(agent) ?? [];
  if (delta > 0) return ticks.find((tick) => tick > fromTick) ?? null;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const tick = ticks[i]!;
    if (tick < fromTick) return tick;
  }
  return null;
}

/** The tick a selection belongs to (when it has one), from the whole log. */
export function selectionTick(selection: Selection, index: LogIndex): number | null {
  switch (selection.kind) {
    case "step":
      return selection.tick;
    case "post":
      return index.postTicks.get(selection.id) ?? null;
    case "version":
      return index.versionTicks.get(selection.version) ?? null;
    default:
      return null;
  }
}

/* ---------- Steps ---------- */

export type StepActionKind =
  | "board"
  | "post"
  | "list"
  | "doc"
  | "doc-reopen"
  | "read-deliverable"
  | "write"
  | "done"
  | "error"
  | "sleep"
  | "stop"
  | "truncated";

/** One run of identical consecutive actions in a step. */
export interface StepAction {
  kind: StepActionKind;
  count: number;
  /** One line per action, for tooltips and labels. */
  details: string[];
}

export const STEP_ACTION_LABELS: Record<StepActionKind, string> = {
  board: "read the board",
  post: "post",
  list: "list documents",
  doc: "open a document",
  "doc-reopen": "re-open a document",
  "read-deliverable": "read the deliverable",
  write: "write the deliverable",
  done: "done",
  error: "tool error",
  sleep: "slept",
  stop: "stopped",
  truncated: "truncated response",
};

/**
 * A step's actions in the order they happened, with consecutive identical actions merged: its tool
 * calls (failed calls as errors), then falling asleep, being stopped, and a truncated response.
 */
export function stepActions(step: StepRecord): StepAction[] {
  const actions: StepAction[] = [];
  const push = (kind: StepActionKind, detail: string) => {
    const last = actions.at(-1);
    if (last && last.kind === kind) {
      last.count++;
      last.details.push(detail);
    } else {
      actions.push({ kind, count: 1, details: [detail] });
    }
  };

  const boardReads = step.tool_calls.filter((call) => call.name === "read_board" && call.error === null).length;
  const received = step.posts_received;
  // Receipts are per step, so they can be attributed to a read only when the step read the board once.
  const boardDetail =
    boardReads !== 1
      ? "read_board"
      : received.length === 0
        ? "read_board → no new posts"
        : `read_board → ${received.length} new post${received.length === 1 ? "" : "s"} (${received.map((id) => `#${id}`).join(", ")})`;
  const opens = [...step.docs_opened];
  const posts = [...step.posts_created];
  const writes = [...step.deliverable_writes];
  const reads = [...step.deliverable_reads];
  for (const call of [...step.tool_calls].sort((a, b) => a.index - b.index)) {
    if (call.error !== null) {
      push("error", `${call.name}: ${call.error}`);
      continue;
    }
    switch (call.name) {
      case "read_board":
        push("board", boardDetail);
        break;
      case "post_message": {
        const id = posts.shift();
        push("post", id === undefined ? "post_message" : `post_message → #${id}`);
        break;
      }
      case "list_documents":
        push("list", "list_documents");
        break;
      case "read_document": {
        const opened = opens.shift();
        const id = opened?.doc_id ?? String(call.arguments?.["id"] ?? "?");
        if (opened && !opened.first_open) push("doc-reopen", `read_document ${id} (re-open)`);
        else push("doc", `read_document ${id}`);
        break;
      }
      case "read_deliverable": {
        const version = reads.shift();
        push("read-deliverable", version === undefined ? "read_deliverable" : `read_deliverable → v${version}`);
        break;
      }
      case "write_deliverable": {
        const version = writes.shift();
        push("write", version === undefined ? "write_deliverable" : `write_deliverable → v${version}`);
        break;
      }
      case "done":
        push("done", "done");
        break;
      case "wait":
        break;
      default:
        push("error", `${call.name}: unknown tool`);
        break;
    }
  }
  if (step.slept) push("sleep", step.sleep_reason === "wait" ? "wait: asleep until a new post" : "no tool calls: fell asleep");
  if (step.stopped !== null) push("stop", `stopped: ${step.stopped}`);
  if (step.truncated) push("truncated", "response truncated (finish_reason length)");
  return actions;
}

/* ---------- Cross-links ---------- */

/**
 * What to highlight for a selection. Steps: "primary" for the selected step or the step that wrote the
 * selected thing, "secondary" for steps that received, read, or opened it. Posts: the selected post,
 * posts the selected step created, and posts it received.
 */
export interface Related {
  steps: Map<string, "primary" | "secondary">;
  posts: Map<number, "selected" | "created" | "received">;
}

export function relatedToSelection(selection: Selection, state: RunState): Related {
  const related: Related = { steps: new Map(), posts: new Map() };
  switch (selection.kind) {
    case "step": {
      const key = stepKey(selection.agent, selection.tick);
      related.steps.set(key, "primary");
      const step = state.step_by_key[key];
      if (step) {
        for (const id of step.posts_received) related.posts.set(id, "received");
        for (const id of step.posts_created) related.posts.set(id, "created");
      }
      break;
    }
    case "post": {
      related.posts.set(selection.id, "selected");
      const post = state.posts.find((candidate) => candidate.id === selection.id);
      if (post) {
        for (const receipt of post.received_by) related.steps.set(stepKey(receipt.agent, receipt.tick), "secondary");
        related.steps.set(stepKey(post.author, post.tick), "primary");
      }
      break;
    }
    case "version": {
      for (const step of state.steps) {
        if (step.deliverable_reads.includes(selection.version)) related.steps.set(step.key, "secondary");
      }
      for (const step of state.steps) {
        if (step.deliverable_writes.includes(selection.version)) related.steps.set(step.key, "primary");
      }
      break;
    }
    case "doc": {
      for (const step of state.steps) {
        const opened = step.docs_opened.find((open) => open.doc_id === selection.id);
        if (opened) related.steps.set(step.key, opened.first_open ? "primary" : "secondary");
      }
      break;
    }
    case "agent":
    case "none":
      break;
  }
  return related;
}
