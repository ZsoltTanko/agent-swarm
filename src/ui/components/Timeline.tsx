import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import { formatDuration, formatTokens, formatUsd, stepKey } from "../../shared/derive.ts";
import type { StepRecord } from "../../shared/runstate.ts";
import type { ViewProps } from "../contract.ts";
import {
  IconBoard,
  IconDeliverable,
  IconDoc,
  IconDone,
  IconError,
  IconList,
  IconPost,
  IconSleep,
  IconStop,
  IconWake,
  IconWarning,
  IconWrite,
  type IconProps,
} from "../icons.tsx";
import {
  relatedToSelection,
  STEP_ACTION_LABELS,
  stepActions,
  type LogIndex,
  type StepAction,
  type StepActionKind,
} from "../useRun.ts";
import { AgentStatusIcon } from "./AgentStatus.tsx";
import { AgentDot, agentColor } from "./primitives.tsx";
import "./Timeline.css";

export interface TimelineProps extends ViewProps {
  logIndex: LogIndex;
  following: boolean;
}

const CELL_WIDTH = 50;
const LEFT_WIDTH = 216;

const ACTION_ICONS: Record<StepActionKind, ComponentType<IconProps>> = {
  board: IconBoard,
  post: IconPost,
  list: IconList,
  doc: IconDoc,
  "doc-reopen": IconDoc,
  "read-deliverable": IconDeliverable,
  write: IconWrite,
  done: IconDone,
  error: IconError,
  sleep: IconSleep,
  stop: IconStop,
  truncated: IconWarning,
};

const LEGEND: StepActionKind[] = [
  "board",
  "post",
  "doc",
  "doc-reopen",
  "read-deliverable",
  "write",
  "sleep",
  "done",
  "stop",
  "error",
  "truncated",
];

function ActionIcon({ action }: { action: StepAction }) {
  const Icon = ACTION_ICONS[action.kind];
  return (
    <span className={`tl-action tl-action-${action.kind}`}>
      <Icon size={12} />
      {action.count > 1 && <span className="tl-action-count num">{action.count}</span>}
    </span>
  );
}

function describeActions(actions: readonly StepAction[]): string {
  if (actions.length === 0) return "no actions";
  return actions
    .map((action) => `${STEP_ACTION_LABELS[action.kind]}${action.count > 1 ? ` ×${action.count}` : ""}`)
    .join(", ");
}

interface HoverState {
  /** The hovered or focused step's key. */
  key: string;
  /** The hovered or focused cell; its position is read when the card renders, so it follows scrolling. */
  element: HTMLElement;
}

/**
 * Agents × ticks. Each cell summarizes one step with icons in the order its actions happened; ticks an
 * agent slept through show a dotted line; columns after the selected tick are dimmed and empty.
 */
export function Timeline({
  state,
  selection,
  select,
  setTick,
  openTab,
  setTranscriptAgent,
  logIndex,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  // Stable handlers, so the memoized cells re-render only when what they show changes.
  const selectStep = useCallback((agent: string, tick: number) => select({ kind: "step", agent, tick }), [select]);
  const openStep = useCallback(
    (agent: string, tick: number) => {
      select({ kind: "step", agent, tick });
      setTranscriptAgent(agent);
      openTab("transcript");
    },
    [select, setTranscriptAgent, openTab],
  );
  const hoverStep = useCallback((key: string, element: HTMLElement | null) => {
    setHover(element ? { key, element } : null);
  }, []);

  const related = useMemo(() => relatedToSelection(selection, state), [selection, state]);
  const actionsByStep = useMemo(() => {
    const map = new Map<string, StepAction[]>();
    for (const step of state.steps) map.set(step.key, stepActions(step));
    return map;
  }, [state.steps]);

  const ticks = useMemo(() => Array.from({ length: state.latest_tick }, (_, i) => i + 1), [state.latest_tick]);
  const selectedAgent = selection.kind === "agent" || selection.kind === "step" ? selection.agent : null;

  // One tab stop for the whole grid (not one per cell): the selected step, else the first step of the
  // selected tick, else the latest step. j / k and the arrows move from there.
  const focusKey = useMemo(() => {
    if (selection.kind === "step") {
      const key = stepKey(selection.agent, selection.tick);
      if (state.step_by_key[key]) return key;
    }
    return (state.steps.find((step) => step.tick === state.tick) ?? state.steps.at(-1))?.key ?? null;
  }, [selection, state.steps, state.step_by_key, state.tick]);

  // When the grid has focus, focus follows the selection (j / k from the keyboard).
  useEffect(() => {
    const scroller = scrollRef.current;
    const active = document.activeElement;
    if (!scroller || focusKey === null || !(active instanceof HTMLElement) || !active.classList.contains("tl-step")) return;
    if (!scroller.contains(active) || active.dataset.stepKey === focusKey) return;
    scroller.querySelector<HTMLElement>(`[data-step-key="${CSS.escape(focusKey)}"]`)?.focus();
  }, [focusKey]);

  // Keep the selected tick's column in view, and a newly selected step's column (a cross-link from
  // another view may select a step that is scrolled out of sight).
  const selectedStepTick = selection.kind === "step" && selection.tick <= state.tick ? selection.tick : null;
  useLayoutEffect(() => {
    if (scrollRef.current) revealColumn(scrollRef.current, state.tick);
  }, [state.tick, state.latest_tick]);
  useLayoutEffect(() => {
    if (scrollRef.current && selectedStepTick !== null) revealColumn(scrollRef.current, selectedStepTick);
  }, [selectedStepTick, selectedAgent]);

  const columns = `${LEFT_WIDTH}px repeat(${ticks.length}, ${CELL_WIDTH}px)`;

  if (state.agents.length === 0) return <div className="state-message">This run has no agents.</div>;

  return (
    <div className="timeline">
      <div className="tl-legend" aria-label="Legend">
        {LEGEND.map((kind) => (
          <span key={kind} className="tl-legend-item">
            <ActionIcon action={{ kind, count: 1, details: [] }} />
            {STEP_ACTION_LABELS[kind]}
          </span>
        ))}
        <span className="tl-legend-item">
          <span className="tl-legend-asleep" aria-hidden="true" />
          asleep
        </span>
      </div>

      <div className="tl-scroll" ref={scrollRef} onScroll={() => setHover((current) => (current ? { ...current } : null))}>
        {ticks.length === 0 ? (
          <div className="state-message">No steps yet; the first tick hasn't started.</div>
        ) : (
          <div className="tl-grid" style={{ gridTemplateColumns: columns }} role="table" aria-label="Agent timeline">
            <div className="tl-row tl-head" role="row">
              <div className="tl-left tl-corner" role="columnheader">
                <span>Agent</span>
                <span className="tl-left-stats faint">reads · cost</span>
              </div>
              {ticks.map((tick) => (
                <div
                  key={tick}
                  role="columnheader"
                  className={`tl-tick${tick === state.tick ? " selected" : ""}${tick > state.tick ? " future" : ""}`}
                >
                  <button
                    type="button"
                    className="tl-tick-btn num"
                    tabIndex={-1}
                    onClick={() => setTick(tick)}
                    aria-label={`Go to step ${tick}`}
                  >
                    {tick}
                  </button>
                </div>
              ))}
            </div>

            {state.agents.map((agent) => {
              const name = agent.info.name;
              const wakes = logIndex.wakes.get(name);
              return (
                <div
                  key={name}
                  className={`tl-row${selectedAgent === name ? " tl-row-selected" : ""}`}
                  role="row"
                  style={{ "--agent-color": agentColor(agent.info.index) } as CSSProperties}
                >
                  <div className="tl-left" role="rowheader">
                    <button
                      type="button"
                      className="tl-agent"
                      onClick={() => select({ kind: "agent", agent: name })}
                      title={`Select ${name}`}
                    >
                      <AgentDot index={agent.info.index} />
                      <span className="tl-agent-name">{name}</span>
                      {agent.status === "awake" ? (
                        <span className="visually-hidden">awake</span>
                      ) : (
                        <span className={`tl-status tl-status-${agent.status}`}>
                          <AgentStatusIcon status={agent.status} />
                        </span>
                      )}
                    </button>
                    <span className="tl-left-stats num">
                      <span title={`${agent.reads_left} document reads left`}>
                        <IconDoc size={11} />
                        {agent.reads_left}
                      </span>
                      <span title={`Cost up to step ${state.tick}`}>{formatUsd(agent.usage.cost_usd)}</span>
                    </span>
                  </div>

                  {ticks.map((tick) => {
                    const cellClasses = ["tl-cell"];
                    if (tick === state.tick) cellClasses.push("selected-col");
                    if (tick > state.tick) {
                      cellClasses.push("future");
                      return <div key={tick} className={cellClasses.join(" ")} role="cell" />;
                    }

                    const key = stepKey(name, tick);
                    const step = state.step_by_key[key];
                    const woke = wakes?.has(tick) ?? false;
                    if (!step) {
                      const started = logIndex.tickStarts.get(tick);
                      let body: ReactNode = null;
                      let label = "";
                      if (started?.asleep.includes(name)) {
                        cellClasses.push("asleep");
                        body = woke ? <IconWake size={11} title="woken at the end of this step" /> : null;
                        label = woke ? "asleep, woken" : "asleep";
                      } else if (started?.active.includes(name)) {
                        // Active without a step: the tick is still running, or the run ended in it (an
                        // API error or an interrupt) before its steps were applied.
                        cellClasses.push("pending");
                        body = state.ended ? "×" : "…";
                        label = state.ended ? "not applied: the run ended during this step" : "step in progress";
                      }
                      return (
                        <div
                          key={tick}
                          className={cellClasses.join(" ")}
                          role="cell"
                          aria-label={label || undefined}
                          title={label || undefined}
                        >
                          {body}
                        </div>
                      );
                    }

                    const actions = actionsByStep.get(key) ?? [];
                    const relation = related.steps.get(key);
                    if (relation) cellClasses.push(`rel-${relation}`);
                    if (step.errors > 0 || step.stopped) cellClasses.push("has-error");
                    return (
                      <StepCell
                        key={tick}
                        agent={name}
                        tick={tick}
                        stepKey={key}
                        className={cellClasses.join(" ")}
                        actions={actions}
                        actionsSignature={actionsSignature(actions)}
                        woke={woke}
                        tabbable={key === focusKey}
                        pressed={relation === "primary" && selection.kind === "step"}
                        onSelect={selectStep}
                        onOpen={openStep}
                        onHover={hoverStep}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {hover && hover.element.isConnected && state.step_by_key[hover.key] && (
        <StepTooltip
          step={state.step_by_key[hover.key]!}
          rect={hover.element.getBoundingClientRect()}
          actions={actionsByStep.get(hover.key) ?? []}
          orderSize={logIndex.tickStarts.get(state.step_by_key[hover.key]!.tick)?.order.length ?? null}
        />
      )}
    </div>
  );
}

interface StepCellProps {
  agent: string;
  tick: number;
  stepKey: string;
  className: string;
  actions: readonly StepAction[];
  /** What `actions` shows; the cell re-renders only when this (not the array's identity) changes. */
  actionsSignature: string;
  woke: boolean;
  tabbable: boolean;
  pressed: boolean;
  onSelect(agent: string, tick: number): void;
  onOpen(agent: string, tick: number): void;
  onHover(key: string, element: HTMLElement | null): void;
}

function actionsSignature(actions: readonly StepAction[]): string {
  return actions.map((action) => `${action.kind}:${action.count}:${action.details.join("|")}`).join(",");
}

/**
 * One step's cell. Every scrub derives new step records, so the cell is memoized on what it shows:
 * with hundreds of cells, re-rendering only the changed ones keeps scrubbing smooth.
 */
const StepCell = memo(
  function StepCell({
    agent,
    tick,
    stepKey: key,
    className,
    actions,
    woke,
    tabbable,
    pressed,
    onSelect,
    onOpen,
    onHover,
  }: StepCellProps) {
    return (
      <div className={className} role="cell">
        <button
          type="button"
          className="tl-step"
          data-step-key={key}
          tabIndex={tabbable ? 0 : -1}
          aria-label={`${agent}, step ${tick}: ${describeActions(actions)}${woke ? ", woken" : ""}`}
          aria-pressed={pressed}
          onClick={() => onSelect(agent, tick)}
          onDoubleClick={() => onOpen(agent, tick)}
          onMouseEnter={(event) => onHover(key, event.currentTarget)}
          onMouseLeave={() => onHover(key, null)}
          onFocus={(event) => onHover(key, event.currentTarget)}
          onBlur={() => onHover(key, null)}
        >
          {actions.map((action, i) => (
            <ActionIcon key={i} action={action} />
          ))}
          {woke && (
            <span className="tl-action tl-action-wake">
              <IconWake size={11} />
            </span>
          )}
        </button>
      </div>
    );
  },
  (a, b) =>
    a.agent === b.agent &&
    a.tick === b.tick &&
    a.stepKey === b.stepKey &&
    a.className === b.className &&
    a.actionsSignature === b.actionsSignature &&
    a.woke === b.woke &&
    a.tabbable === b.tabbable &&
    a.pressed === b.pressed &&
    a.onSelect === b.onSelect &&
    a.onOpen === b.onOpen &&
    a.onHover === b.onHover,
);

/** Scrolls the grid horizontally so the tick's column is visible, if it isn't. */
function revealColumn(scroller: HTMLElement, tick: number): void {
  if (tick < 1) return;
  const left = LEFT_WIDTH + (tick - 1) * CELL_WIDTH;
  const visibleLeft = scroller.scrollLeft + LEFT_WIDTH;
  const visibleRight = scroller.scrollLeft + scroller.clientWidth;
  if (left < visibleLeft) scroller.scrollLeft = Math.max(0, left - LEFT_WIDTH - CELL_WIDTH);
  else if (left + CELL_WIDTH > visibleRight) scroller.scrollLeft = left + 2 * CELL_WIDTH - scroller.clientWidth;
}

const TOOLTIP_WIDTH = 320;

function StepTooltip({
  step,
  rect,
  actions,
  orderSize,
}: {
  step: StepRecord;
  rect: DOMRect;
  actions: readonly StepAction[];
  orderSize: number | null;
}) {
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - TOOLTIP_WIDTH - 8);
  const below = rect.bottom + 180 < window.innerHeight;
  const style = below
    ? { left, top: rect.bottom + 6, width: TOOLTIP_WIDTH }
    : { left, bottom: window.innerHeight - rect.top + 6, width: TOOLTIP_WIDTH };
  const call = step.call;

  return (
    <div className="tl-tooltip" style={style} role="tooltip">
      <div className="tl-tooltip-title">
        <strong>{step.agent}</strong> · step {step.tick}
        <span className="faint">
          {" "}
          · order {step.order_index + 1}
          {orderSize !== null ? ` of ${orderSize}` : ""}
        </span>
      </div>
      <ul className="tl-tooltip-calls">
        {actions.length === 0 && <li className="faint">No tool calls.</li>}
        {actions.flatMap((action, i) =>
          action.details.map((detail, j) => (
            <li key={`${i}-${j}`} className={`tl-tooltip-call tl-action-${action.kind}`}>
              {detail}
            </li>
          )),
        )}
      </ul>
      {call ? (
        <div className="tl-tooltip-usage num">
          {formatTokens(call.usage.prompt_tokens)} in · {formatTokens(call.usage.completion_tokens)} out
          {call.usage.reasoning_tokens > 0 ? ` (${formatTokens(call.usage.reasoning_tokens)} reasoning)` : ""} ·{" "}
          {formatUsd(call.usage.cost_usd)} · {formatDuration(call.latency_ms)}
          {call.cache_hit ? " · cached" : ""}
        </div>
      ) : (
        <div className="tl-tooltip-usage">No response: {step.stopped ?? "no model call"}.</div>
      )}
    </div>
  );
}
