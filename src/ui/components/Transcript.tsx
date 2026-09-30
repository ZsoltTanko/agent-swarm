import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { formatDuration, formatTokens, formatUsd, stepKey } from "../../shared/derive.ts";
import type { Selection, ViewProps } from "../contract.ts";
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
} from "../icons.tsx";
import {
  buildTranscript,
  compactArguments,
  formatInt,
  lastSeqAtTick,
  lineCount,
  reasoningOf,
  resultLink,
  splitStatusLine,
  startsCollapsed,
  tickStartedAt,
  toolArguments,
  toolName,
  type ResultLink,
  type TranscriptItem,
  type TranscriptTool,
} from "../transcript.ts";
import { relatedToSelection } from "../useRun.ts";
import { AgentStatusIcon } from "./AgentStatus.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { RawCall } from "./RawCall.tsx";
import { AgentDot, Pill, agentColor } from "./primitives.tsx";
import "./Transcript.css";

type Select = (selection: Selection) => void;
type StepItem = Extract<TranscriptItem, { kind: "step" }>;

/** Scrolls `target` into the scroller's view if it isn't already, aligning its top near the top. */
function revealInScroller(scroller: HTMLElement, target: HTMLElement): void {
  const scrollerBox = scroller.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const top = box.top - scrollerBox.top;
  if (top >= 0 && top < scroller.clientHeight - 48) return;
  scroller.scrollTop += top - 8;
}

export function Transcript(props: ViewProps) {
  const { events, state, selection, transcriptAgent, setTranscriptAgent } = props;
  const agentView = state.agents.find((view) => view.info.name === transcriptAgent) ?? state.agents[0] ?? null;
  const agent = agentView?.info.name ?? null;

  // Step blocks are memoized; a stable select keeps them from re-rendering when the parent's changes.
  const selectRef = useRef(props.select);
  useLayoutEffect(() => {
    selectRef.current = props.select;
  });
  const select = useCallback<Select>((next) => selectRef.current(next), []);

  const cutSeq = useMemo(() => lastSeqAtTick(events, state.tick), [events, state.tick]);
  const items = useMemo(
    () => (agent === null ? [] : buildTranscript(events, agent, cutSeq, state.steps)),
    [events, agent, cutSeq, state.steps],
  );
  // Steps linked to a selected post, version, or document: its writer and its receivers, readers, or openers.
  const related = useMemo(
    () => (selection.kind === "step" ? new Map<string, unknown>() : relatedToSelection(selection, state).steps),
    [state, selection],
  );
  const selectedKey = selection.kind === "step" && selection.agent === agent ? stepKey(selection.agent, selection.tick) : null;

  const pendingTick = useMemo(() => {
    if (agent === null || state.status === "ended" || state.tick !== state.latest_tick) return null;
    const started = tickStartedAt(events, state.tick);
    if (started === null || !started.active.includes(agent)) return null;
    return state.step_by_key[stepKey(agent, state.tick)] ? null : state.tick;
  }, [events, agent, state]);

  const stepCount = items.reduce((n, item) => (item.kind === "step" || item.kind === "stopped" ? n + 1 : n), 0);

  // Scrolling: reveal the selected step; otherwise stay pinned to the newest step while the view is at the bottom.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onScroll = () => {
    const el = scrollerRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useLayoutEffect(() => {
    pinnedRef.current = true;
  }, [agent]);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || selectedKey === null) return;
    const target = scroller.querySelector<HTMLElement>(`[data-step-key="${CSS.escape(selectedKey)}"]`);
    if (target) revealInScroller(scroller, target);
    // Only when the selection or agent changes, not on every live batch.
  }, [selectedKey, agent]);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && selectedKey === null && pinnedRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [items, pendingTick, selectedKey]);

  if (agentView === null || agent === null) {
    return (
      <div className="view">
        <header className="panel-header">
          <h2 className="panel-title">Transcript</h2>
        </header>
        <p className="state-message">This run has no agents.</p>
      </div>
    );
  }

  return (
    <div className="view tr-root">
      <header className="panel-header tr-head">
        <h2 className="panel-title">Transcript</h2>
        <div className="tr-agents" role="group" aria-label="Agent">
          {state.agents.map((view) => (
            <button
              key={view.info.name}
              type="button"
              className="tr-agent-chip"
              aria-pressed={view.info.name === agent}
              style={{ "--agent-color": agentColor(view.info.index) } as CSSProperties}
              onClick={() => setTranscriptAgent(view.info.name)}
            >
              <AgentDot index={view.info.index} />
              {view.info.name}
              <AgentStatusIcon status={view.status} />
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="panel-count">
          {formatInt(stepCount)} {stepCount === 1 ? "step" : "steps"} · as of step {state.tick}
        </span>
      </header>
      <div className="panel-body tr-body" ref={scrollerRef} onScroll={onScroll}>
        <div className="tr-list">
          {items.map((item) => {
            switch (item.kind) {
              case "system":
                return (
                  <Disclosure
                    key={item.key}
                    className="tr-prompt"
                    label="System prompt"
                    meta={`${formatInt(item.text.length)} chars`}
                    preview={firstLine(item.text)}
                  >
                    <pre className="pre-block tr-prompt-text">{item.text}</pre>
                  </Disclosure>
                );
              case "kickoff":
                return (
                  <Disclosure
                    key={item.key}
                    className="tr-prompt"
                    label="Kickoff"
                    meta={`${formatInt(item.text.length)} chars`}
                    preview={firstLine(item.text)}
                  >
                    <pre className="pre-block tr-prompt-text">{item.text}</pre>
                  </Disclosure>
                );
              case "step":
                return (
                  <StepBlock
                    key={item.key}
                    item={item}
                    agentIndex={agentView.info.index}
                    orderCount={item.step ? (state.activity[item.step.tick - 1]?.active ?? 0) : 0}
                    selected={item.key === selectedKey}
                    related={related.has(item.key)}
                    select={select}
                  />
                );
              case "wake":
                return <WakeDivider key={item.key} item={item} />;
              case "stopped":
                return (
                  <article
                    key={item.key}
                    className={`tr-step is-stopped${item.key === selectedKey ? " is-selected" : ""}`}
                    data-step-key={item.key}
                    style={{ "--agent-color": agentColor(agentView.info.index) } as CSSProperties}
                  >
                    <header className="tr-step-head">
                      <button
                        type="button"
                        className="tr-step-select"
                        aria-current={item.key === selectedKey ? "true" : undefined}
                        onClick={() => select({ kind: "step", agent: item.step.agent, tick: item.step.tick })}
                      >
                        <span className="tr-step-title">Step {item.step.tick}</span>
                        <OrderMeta orderIndex={item.step.order_index} count={state.activity[item.step.tick - 1]?.active ?? 0} />
                      </button>
                    </header>
                    <div className="tr-step-body">
                      <p className="tr-marker is-warning">
                        <IconStop size={13} />
                        Stopped: {item.step.stopped === "context_full" ? "the context window is full" : item.step.stopped}
                      </p>
                      {item.detail && <p className="tr-muted">{item.detail}</p>}
                    </div>
                  </article>
                );
            }
          })}
          {pendingTick !== null && (
            <p className="tr-pending" role="status">
              Step {pendingTick}: waiting for the model's response…
            </p>
          )}
          {items.length <= 2 && pendingTick === null && (
            <p className="empty-note tr-no-steps">{agent} hasn't taken a step yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function OrderMeta({ orderIndex, count }: { orderIndex: number; count: number }) {
  return (
    <span className="tr-step-meta" title="Position in this tick's shuffled order: the order in which effects were applied">
      order {orderIndex + 1}
      {count > 0 ? ` of ${count}` : ""}
    </span>
  );
}

interface StepBlockProps {
  item: StepItem;
  agentIndex: number;
  orderCount: number;
  selected: boolean;
  related: boolean;
  select: Select;
}

/** Re-render a step only when what it shows changed: a live step gains tool results; selection moves. */
function sameStep(a: StepBlockProps, b: StepBlockProps): boolean {
  if (
    a.selected !== b.selected ||
    a.related !== b.related ||
    a.orderCount !== b.orderCount ||
    a.agentIndex !== b.agentIndex ||
    a.select !== b.select
  ) {
    return false;
  }
  const x = a.item;
  const y = b.item;
  if (x.key !== y.key || x.step?.call !== y.step?.call || x.tools.length !== y.tools.length) return false;
  if (x.step?.slept !== y.step?.slept || x.step?.done !== y.step?.done) return false;
  return x.tools.every((tool, i) => {
    const other = y.tools[i];
    return other !== undefined && tool.event === other.event && tool.result?.content === other.result?.content;
  });
}

const StepBlock = memo(function StepBlock({ item, agentIndex, orderCount, selected, related, select }: StepBlockProps) {
  const { step, message, tools } = item;
  const call = step?.call ?? null;
  const [rawOpen, setRawOpen] = useState(false);
  const reasoning = useMemo(() => reasoningOf(message), [message]);
  const content = typeof message.content === "string" ? message.content : "";
  const refusal = typeof message.refusal === "string" && message.refusal !== "" ? message.refusal : null;
  const className = `tr-step${selected ? " is-selected" : ""}${related ? " is-related" : ""}`;

  return (
    <article
      className={className}
      data-step-key={item.key}
      style={{ "--agent-color": agentColor(agentIndex) } as CSSProperties}
    >
      <header className="tr-step-head">
        <button
          type="button"
          className="tr-step-select"
          aria-current={selected ? "true" : undefined}
          disabled={step === null}
          onClick={() => step && select({ kind: "step", agent: step.agent, tick: step.tick })}
        >
          <span className="tr-step-title">Step {step?.tick ?? "?"}</span>
          {step && <OrderMeta orderIndex={step.order_index} count={orderCount} />}
          {call && (
            <>
              <span className="tr-step-meta tr-num" title="Prompt, completion, and reasoning tokens">
                {formatTokens(call.usage.prompt_tokens)} in · {formatTokens(call.usage.completion_tokens)} out ·{" "}
                {formatTokens(call.usage.reasoning_tokens)} reasoning
              </span>
              <span className="tr-step-meta tr-num" title="Cost">
                {formatUsd(call.usage.cost_usd)}
              </span>
              <span className="tr-step-meta tr-num" title="Latency">
                {formatDuration(call.latency_ms)}
              </span>
              {call.cache_hit && (
                <Pill title="The response came from the harness's response cache">cached</Pill>
              )}
              {call.attempts > 1 && (
                <Pill tone="warning" title="Requests it took to get this response">
                  {call.attempts} attempts
                </Pill>
              )}
            </>
          )}
          {step?.truncated && (
            <Pill tone="warning" title="finish_reason was length: the response hit max_tokens">
              <IconWarning size={11} />
              truncated
            </Pill>
          )}
          {step !== null && step.errors > 0 && (
            <Pill tone="danger">
              <IconError size={11} />
              {step.errors} {step.errors === 1 ? "error" : "errors"}
            </Pill>
          )}
        </button>
        {call && (
          <button type="button" className="toggle-btn" aria-expanded={rawOpen} onClick={() => setRawOpen((open) => !open)}>
            Raw call
          </button>
        )}
      </header>
      {rawOpen && call && (
        <div className="tr-raw">
          <p className="tr-muted">
            Cache key <code className="tr-mono">{call.cache_key}</code>
          </p>
          <RawCall cacheKey={call.cache_key} />
        </div>
      )}
      <div className="tr-step-body">
        {reasoning.text !== null && <Reasoning text={reasoning.text} />}
        {reasoning.text === null && reasoning.encryptedBlocks > 0 && (
          <p className="tr-muted">
            Encrypted reasoning ({reasoning.encryptedBlocks} {reasoning.encryptedBlocks === 1 ? "block" : "blocks"})
          </p>
        )}
        {content.trim() !== "" && <div className="tr-content">{content}</div>}
        {refusal && (
          <p className="tr-marker is-warning">
            <IconWarning size={13} />
            Refusal: {refusal}
          </p>
        )}
        {tools.map((tool) => (
          <ToolExchange key={tool.index} tool={tool} select={select} />
        ))}
        {step?.slept && (
          <p className="tr-marker">
            <IconSleep size={13} />
            {step.sleep_reason === "wait" ? "Waiting for a new post" : "Fell asleep (no tool calls)"}
          </p>
        )}
        {step?.done && (
          <p className="tr-marker">
            <IconDone size={13} />
            Done: won't act again
          </p>
        )}
      </div>
    </article>
  );
}, sameStep);

function Reasoning({ text }: { text: string }) {
  const long = lineCount(text) > 3 || text.length > 320;
  const [open, setOpen] = useState(false);
  return (
    <div className="tr-reasoning">
      <span className="tr-label">Reasoning</span>
      <div className={`tr-reasoning-text${long && !open ? " is-clamped" : ""}`}>
        {long && !open ? text.replace(/\n\s*\n/g, "\n") : text}
      </div>
      {long && (
        <button type="button" className="toggle-btn tr-reasoning-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : `Show all · ${formatInt(text.length)} chars`}
        </button>
      )}
    </div>
  );
}

function ToolIcon({ name }: { name: string }) {
  switch (name) {
    case "read_board":
      return <IconBoard size={12} />;
    case "post_message":
      return <IconPost size={12} />;
    case "list_documents":
      return <IconList size={12} />;
    case "read_document":
      return <IconDoc size={12} />;
    case "read_deliverable":
      return <IconDeliverable size={12} />;
    case "write_deliverable":
      return <IconWrite size={12} />;
    case "wait":
      return <IconSleep size={12} />;
    case "done":
      return <IconDone size={12} />;
    default:
      return <IconWarning size={12} title="Unknown tool" />;
  }
}

function ToolExchange({ tool, select }: { tool: TranscriptTool; select: Select }) {
  const name = toolName(tool);
  const args = toolArguments(tool);
  const error = tool.event?.error ?? null;
  const raw = tool.call?.function.arguments ?? tool.event?.raw_arguments ?? "";
  const text = args && typeof args.text === "string" ? args.text : null;
  const note = args && typeof args.note === "string" ? args.note : null;

  return (
    <div className={`tr-tool${error !== null ? " is-error" : ""}`}>
      <div className="tr-call">
        <span className="tr-chip">
          <ToolIcon name={name} />
          {name}
        </span>
        {args === null ? (
          <span className="tr-args is-invalid" title="The arguments aren't valid JSON">
            {raw.length > 120 ? `${raw.slice(0, 120)}…` : raw}
          </span>
        ) : (
          <CallArguments name={name} args={args} select={select} />
        )}
      </div>
      {name === "post_message" && text !== null && <blockquote className="tr-quote">{text}</blockquote>}
      {name === "write_deliverable" && text !== null && (
        <Disclosure className="tr-written" label="Text written" meta={`${formatInt(text.length)} chars`} preview={firstLine(text)}>
          <pre className="pre-block">{text}</pre>
        </Disclosure>
      )}
      {name === "done" && note !== null && <blockquote className="tr-quote">{note}</blockquote>}
      <ToolResult name={name} tool={tool} error={error} select={select} />
    </div>
  );
}

function CallArguments({ name, args, select }: { name: string; args: Record<string, unknown>; select: Select }) {
  if (name === "read_document" && typeof args.id === "string") {
    const id = args.id;
    const rest = compactArguments(args, ["id"]);
    return (
      <span className="tr-args">
        id:{" "}
        <button type="button" className="link-btn tr-mono" onClick={() => select({ kind: "doc", id })}>
          {id}
        </button>
        {rest && `, ${rest}`}
      </span>
    );
  }
  if (name === "post_message") {
    const replyTo = typeof args.reply_to === "number" ? args.reply_to : null;
    const length = typeof args.text === "string" ? args.text.length : null;
    const rest = compactArguments(args, ["text", "reply_to"]);
    return (
      <span className="tr-args">
        {length !== null && `${formatInt(length)} chars`}
        {replyTo !== null && (
          <>
            {" · reply to "}
            <button type="button" className="link-btn tr-mono" onClick={() => select({ kind: "post", id: replyTo })}>
              #{replyTo}
            </button>
          </>
        )}
        {rest && ` · ${rest}`}
      </span>
    );
  }
  const shown = compactArguments(args, name === "write_deliverable" || name === "done" ? ["text", "note"] : []);
  return shown ? <span className="tr-args">{shown}</span> : null;
}

function ToolResult({
  name,
  tool,
  error,
  select,
}: {
  name: string;
  tool: TranscriptTool;
  error: string | null;
  select: Select;
}) {
  const content = tool.result?.content ?? null;
  const split = useMemo(() => (content === null ? null : splitStatusLine(content)), [content]);
  const body = split?.body ?? "";
  const collapsible = split !== null && startsCollapsed(name, body, error);
  const [open, setOpen] = useState(!collapsible);
  if (split === null) return <p className="tr-result tr-muted">No result logged yet.</p>;

  const link = resultLink(name, body, error);
  const lines = lineCount(body);
  const toggleLabel =
    link?.kind === "doc"
      ? `${formatInt(link.words)} words`
      : `${formatInt(lines)} lines · ${formatInt(body.length)} chars`;

  return (
    <div className={`tr-result${error !== null ? " is-error" : ""}`}>
      <div className="tr-result-head">
        {error !== null ? (
          <span className="tr-label is-error">
            <IconError size={12} />
            Error
          </span>
        ) : (
          <span className="tr-label">Result</span>
        )}
        {link && <ResultLinkButton link={link} select={select} />}
        {collapsible && (
          <button type="button" className="toggle-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {toggleLabel}, {open ? "hide" : "show"}
          </button>
        )}
      </div>
      {open && body !== "" && <pre className="tr-result-body">{body}</pre>}
      {split.status && <StatusBadges parts={split.status} />}
    </div>
  );
}

function ResultLinkButton({ link, select }: { link: ResultLink; select: Select }) {
  switch (link.kind) {
    case "post":
      return (
        <button type="button" className="link-btn tr-result-link" onClick={() => select({ kind: "post", id: link.id })}>
          Post #{link.id}
        </button>
      );
    case "version":
      return (
        <button
          type="button"
          className="link-btn tr-result-link"
          onClick={() => select({ kind: "version", version: link.version })}
        >
          Deliverable v{link.version}
        </button>
      );
    case "doc":
      return (
        <button
          type="button"
          className="link-btn tr-result-link"
          title={link.title}
          onClick={() => select({ kind: "doc", id: link.id })}
        >
          Document {link.id}
        </button>
      );
  }
}

function StatusBadges({ parts }: { parts: string[] }) {
  return (
    <div className="tr-status" aria-label={`Status line: ${parts.join(", ")}`}>
      {parts.map((part, i) => (
        <span key={i} className="tr-status-part">
          {part}
        </span>
      ))}
    </div>
  );
}

function WakeDivider({ item }: { item: Extract<TranscriptItem, { kind: "wake" }> }) {
  const { body, status } = splitStatusLine(item.text);
  return (
    <div className="tr-wake" role="separator" aria-label={`Woken at step ${item.tick ?? "?"}`}>
      <span className="tr-wake-label">
        <IconWake size={12} />
        Woken at step {item.tick ?? "?"}
        {item.asleepSince !== null && item.asleepSince !== item.tick && ` · asleep since step ${item.asleepSince}`}
      </span>
      {/* The label already names the step; the rest of the status line is what the agent was told. */}
      {status && status.length > 1 && <StatusBadges parts={status.slice(1)} />}
      {body.trim() !== "" && <span className="tr-wake-text">{body}</span>}
    </div>
  );
}
