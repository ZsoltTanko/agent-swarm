import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { DocumentResponse } from "../../shared/api.ts";
import { rebuildContext } from "../../shared/context.ts";
import { formatDuration, formatTokens, formatUsd, stepKey } from "../../shared/derive.ts";
import type { RunState, StepRecord } from "../../shared/runstate.ts";
import type { RunEvent, ToolCallEvent } from "../../shared/events.ts";
import { errorMessage, isNotFound, loadDocument } from "../api.ts";
import { NO_SELECTION, type Selection, type ViewProps } from "../contract.ts";
import { IconClose, IconExternal, IconWarning } from "../icons.tsx";
import { reasoningOf } from "../transcript.ts";
import { encodeSelection } from "../url.ts";
import { pinnedEndpoint, type LogIndex } from "../useRun.ts";
import { AgentStatusPill } from "./AgentStatus.tsx";
import { VersionDiff } from "./DeliverableView.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { JsonView } from "./JsonView.tsx";
import { RawCall } from "./RawCall.tsx";
import { endReasonLabel } from "./RunsList.tsx";
import { AgentDot, AgentName, Pill } from "./primitives.tsx";
import "./Inspector.css";

export interface InspectorProps extends ViewProps {
  logIndex: LogIndex;
}

const KIND_LABELS: Record<Selection["kind"], string> = {
  none: "run overview",
  step: "step",
  post: "post",
  doc: "document",
  version: "deliverable version",
  agent: "agent",
};

/** Details of the selection: a step, post, document, deliverable version, or agent; the run overview otherwise. */
export function Inspector(props: InspectorProps) {
  const { selection, select } = props;
  return (
    <div className="inspector">
      <div className="panel-header">
        <span className="panel-title">Inspector</span>
        <span className="panel-count">{KIND_LABELS[selection.kind]}</span>
        {selection.kind !== "none" && (
          <button
            type="button"
            className="icon-btn insp-clear"
            aria-label="Clear selection"
            title="Clear selection (Esc)"
            onClick={() => select(NO_SELECTION)}
          >
            <IconClose size={12} />
          </button>
        )}
      </div>
      {/* Keyed on the selection so scroll position and expanded sections reset for each new one. */}
      <div className="panel-body insp-body" key={encodeSelection(selection) ?? "none"}>
        <InspectorBody {...props} />
      </div>
    </div>
  );
}

function InspectorBody(props: InspectorProps) {
  const { selection } = props;
  switch (selection.kind) {
    case "step":
      return <StepInspector {...props} agent={selection.agent} tick={selection.tick} />;
    case "post":
      return <PostInspector {...props} id={selection.id} />;
    case "doc":
      return <DocInspector {...props} docId={selection.id} />;
    case "version":
      return <VersionInspector {...props} version={selection.version} />;
    case "agent":
      return <AgentInspector {...props} name={selection.agent} />;
    case "none":
      return <RunOverview {...props} />;
  }
}

/* ---------- Building blocks ---------- */

function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="insp-section">
      <h3 className="insp-section-title">
        <span>{title}</span>
        {aside !== undefined && <span className="insp-section-aside">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="insp-facts">
      {items.map(([label, value], i) => (
        <div key={i} className="insp-fact">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const CHARS_PER_LINE = 88;

/** `text` cut to about `maxLines` rendered lines, or null when it already fits. */
export function clipText(text: string, maxLines: number): string | null {
  const lines = text.split("\n");
  let budget = maxLines;
  const kept: string[] = [];
  for (const line of lines) {
    const cost = Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
    if (cost <= budget) {
      kept.push(line);
      budget -= cost;
      continue;
    }
    if (budget > 0) kept.push(line.slice(0, budget * CHARS_PER_LINE));
    return kept.join("\n");
  }
  return null;
}

/** Pre-wrapped text, collapsed to about `maxLines` lines when longer. */
function LongText({
  text,
  maxLines = 12,
  mono = false,
  expandLabel,
}: {
  text: string;
  maxLines?: number;
  mono?: boolean;
  expandLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const clipped = useMemo(() => clipText(text, maxLines), [text, maxLines]);
  const className = `insp-text${mono ? " mono" : ""}`;
  if (clipped === null) return <div className={className}>{text}</div>;
  const lineCount = text.split("\n").length;
  return (
    <div>
      <div className={className}>
        {open ? text : clipped}
        {!open && <span className="faint">…</span>}
      </div>
      <button type="button" className="link-btn insp-more" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open
          ? "Show less"
          : (expandLabel ?? `Show all · ${lineCount.toLocaleString()} lines, ${text.length.toLocaleString()} chars`)}
      </button>
    </div>
  );
}

function agentIndex(state: RunState, name: string): number {
  return state.agents.find((agent) => agent.info.name === name)?.info.index ?? 0;
}

function StepLink({ state, agent, tick, select }: { state: RunState; agent: string; tick: number; select: ViewProps["select"] }) {
  return (
    <button
      type="button"
      className="link-btn insp-steplink"
      onClick={() => select({ kind: "step", agent, tick })}
      title={`Select ${agent}'s step ${tick}`}
    >
      <AgentDot index={agentIndex(state, agent)} />
      {agent} · step {tick}
    </button>
  );
}

function PostLink({ id, select }: { id: number; select: ViewProps["select"] }) {
  return (
    <button type="button" className="link-btn mono" onClick={() => select({ kind: "post", id })}>
      #{id}
    </button>
  );
}

function DocLink({ id, select }: { id: string; select: ViewProps["select"] }) {
  return (
    <button type="button" className="link-btn mono" onClick={() => select({ kind: "doc", id })}>
      {id}
    </button>
  );
}

function VersionLink({ version, select }: { version: number; select: ViewProps["select"] }) {
  if (version === 0) return <span className="faint">v0 (empty)</span>;
  return (
    <button type="button" className="link-btn mono" onClick={() => select({ kind: "version", version })}>
      v{version}
    </button>
  );
}

function LinkList({ children, empty = "none" }: { children: ReactNode[]; empty?: string }) {
  if (children.length === 0) return <span className="faint">{empty}</span>;
  return <span className="insp-links">{children}</span>;
}

function FutureNotice({ message, tick, setTick }: { message: string; tick: number; setTick(tick: number): void }) {
  return (
    <div className="insp-notice">
      <p>{message}</p>
      <button type="button" className="btn" onClick={() => setTick(tick)}>
        Go to step {tick}
      </button>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="state-message">{children}</div>;
}

/* ---------- Step ---------- */

function StepInspector({
  events,
  state,
  select,
  setTick,
  openTab,
  setTranscriptAgent,
  logIndex,
  agent,
  tick,
}: InspectorProps & { agent: string; tick: number }) {
  const step = state.step_by_key[stepKey(agent, tick)];
  if (!step) {
    if (!state.agents.some((candidate) => candidate.info.name === agent)) {
      return <Empty>There is no agent named {agent} in this run.</Empty>;
    }
    if (tick > state.tick) {
      return (
        <FutureNotice
          message={`${agent}'s step ${tick} comes after the selected step (${state.tick}).`}
          tick={tick}
          setTick={setTick}
        />
      );
    }
    return <Empty>{agent} took no step at tick {tick}.</Empty>;
  }

  const call = step.call;
  const orderSize = logIndex.tickStarts.get(tick)?.order.length ?? null;
  const reasoning = call ? reasoningOf(call.message) : null;
  const reasoningText =
    reasoning === null
      ? null
      : (reasoning.text ??
        (reasoning.encryptedBlocks > 0
          ? `(Encrypted: ${reasoning.encryptedBlocks} ${reasoning.encryptedBlocks === 1 ? "block" : "blocks"}.)`
          : null));
  const content = call?.message.content ?? "";
  const refusal = typeof call?.message.refusal === "string" ? call.message.refusal : null;
  const agentView = state.agents.find((candidate) => candidate.info.name === agent);
  const woke = logIndex.wakes.get(agent)?.has(tick) ?? false;
  const cacheKey = call?.cache_key ?? stoppedCacheKey(events, step);

  return (
    <>
      <div className="insp-head">
        <AgentName name={agent} index={agentIndex(state, agent)} />
        <span className="insp-head-main">step {tick}</span>
        <span className="faint num">
          order {step.order_index + 1}
          {orderSize !== null ? ` of ${orderSize}` : ""}
        </span>
        <span className="insp-head-flags">
          {step.slept && <Pill>{step.sleep_reason === "wait" ? "waited" : "slept: no tool calls"}</Pill>}
          {step.done && <Pill tone="success">done</Pill>}
          {step.stopped && <Pill tone="warning">stopped: {step.stopped}</Pill>}
          {step.truncated && <Pill tone="warning">truncated</Pill>}
          {step.errors > 0 && (
            <Pill tone="danger">
              {step.errors} error{step.errors === 1 ? "" : "s"}
            </Pill>
          )}
        </span>
      </div>

      <div className="insp-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setTranscriptAgent(agent);
            openTab("transcript");
          }}
        >
          <IconExternal size={12} />
          Open transcript here
        </button>
      </div>

      {call ? (
        <Section title="Model call">
          <Facts
            items={[
              ["Provider", call.provider ?? <span className="faint">—</span>],
              ["Latency", <span className="num">{formatDuration(call.latency_ms)}</span>],
              ["Attempts", <span className="num">{call.attempts}</span>],
              ["Response cache", call.cache_hit ? "hit (replayed)" : "miss (fresh call)"],
              [
                "Tokens in",
                <span className="num">
                  {call.usage.prompt_tokens.toLocaleString()}
                  <span className="faint"> · {call.usage.cached_tokens.toLocaleString()} cached</span>
                </span>,
              ],
              [
                "Tokens out",
                <span className="num">
                  {call.usage.completion_tokens.toLocaleString()}
                  <span className="faint"> · {call.usage.reasoning_tokens.toLocaleString()} reasoning</span>
                </span>,
              ],
              ["Cost", <span className="num">{formatUsd(call.usage.cost_usd)}</span>],
              [
                "Finish reason",
                <span className="mono">
                  {call.finish_reason ?? "—"}
                  {call.native_finish_reason && call.native_finish_reason !== call.finish_reason
                    ? ` (${call.native_finish_reason})`
                    : ""}
                </span>,
              ],
              [
                "Truncated",
                call.truncated ? (
                  <span className="insp-warn">
                    <IconWarning size={12} /> yes: hit max_tokens
                  </span>
                ) : (
                  "no"
                ),
              ],
              ["Request", <span className="num">{call.request_messages} messages</span>],
              [
                "Cache key",
                <span className="mono insp-ellipsis" title={call.cache_key}>
                  {call.cache_key.slice(0, 16)}…
                </span>,
              ],
              ...(call.generation_id
                ? ([["Generation", <span className="mono insp-ellipsis">{call.generation_id}</span>]] as [
                    ReactNode,
                    ReactNode,
                  ][])
                : []),
            ]}
          />
        </Section>
      ) : (
        <Section title="Model call">
          <p className="insp-p">
            No response: the agent was stopped ({step.stopped ?? "unknown reason"}) before its call could be made.
          </p>
        </Section>
      )}

      {reasoningText !== null && (
        <Section title="Reasoning" aside={call ? `${formatTokens(call.usage.reasoning_tokens)} tokens` : undefined}>
          <LongText text={reasoningText} maxLines={14} />
        </Section>
      )}

      {content.trim() !== "" && (
        <Section title="Content">
          <LongText text={content} />
        </Section>
      )}
      {refusal && (
        <Section title="Refusal">
          <div className="insp-text error-text">{refusal}</div>
        </Section>
      )}

      {step.tool_calls.length > 0 && (
        <Section title="Tool calls" aside={`${step.tool_calls.length}`}>
          <ol className="insp-tools">
            {[...step.tool_calls]
              .sort((a, b) => a.index - b.index)
              .map((toolCall) => (
                <ToolCallView key={toolCall.call_id + toolCall.index} call={toolCall} />
              ))}
          </ol>
        </Section>
      )}

      <Section title="Effects">
        <Facts
          items={[
            [
              "Posts created",
              <LinkList>
                {step.posts_created.map((id) => (
                  <PostLink key={id} id={id} select={select} />
                ))}
              </LinkList>,
            ],
            [
              "Posts received",
              <LinkList
                empty={step.tool_calls.some((c) => c.name === "read_board" && c.error === null) ? "none new" : "didn't read the board"}
              >
                {step.posts_received.map((id) => (
                  <PostLink key={id} id={id} select={select} />
                ))}
              </LinkList>,
            ],
            [
              "Documents opened",
              <LinkList>
                {step.docs_opened.map((open, i) => (
                  <span key={`${open.doc_id}-${i}`}>
                    <DocLink id={open.doc_id} select={select} />
                    {!open.first_open && <span className="faint"> (re-open)</span>}
                  </span>
                ))}
              </LinkList>,
            ],
            [
              "Deliverable read",
              <LinkList>
                {step.deliverable_reads.map((version, i) => (
                  <VersionLink key={i} version={version} select={select} />
                ))}
              </LinkList>,
            ],
            [
              "Deliverable written",
              <LinkList>
                {step.deliverable_writes.map((version) => (
                  <VersionLink key={version} version={version} select={select} />
                ))}
              </LinkList>,
            ],
            ...(step.done
              ? ([["Done note", agentView?.done_note ?? <span className="faint">none</span>]] as [ReactNode, ReactNode][])
              : []),
            ...(woke ? ([["Woken", "at the end of this tick"]] as [ReactNode, ReactNode][]) : []),
          ]}
        />
      </Section>

      <Section title="Raw data">
        <Disclosure label="Request context, rebuilt from the log">
          {() => <JsonView value={rebuildContext(events, agent, step.seq - 1)} label="messages" defaultDepth={1} />}
        </Disclosure>
        {cacheKey ? (
          <Disclosure label="Raw request and response (response cache)">{() => <RawCall cacheKey={cacheKey} />}</Disclosure>
        ) : (
          <p className="insp-p faint">This step has no response-cache entry.</p>
        )}
        {call && (
          <Disclosure label="model_call event">
            {() => <JsonView value={call} label="model_call" defaultDepth={1} />}
          </Disclosure>
        )}
      </Section>
    </>
  );
}

/** The response-cache key of the context-length failure that stopped the agent in this step. */
function stoppedCacheKey(events: readonly RunEvent[], step: StepRecord): string | null {
  if (step.stopped === null) return null;
  for (const event of events) {
    if (event.type === "agent_stopped" && event.agent === step.agent && event.tick === step.tick) return event.cache_key;
  }
  return null;
}

function ToolCallView({ call }: { call: ToolCallEvent }) {
  const isDocument = call.name === "read_document" && call.error === null;
  const args = call.arguments;
  const entries = args ? Object.entries(args) : [];
  return (
    <li className={`insp-tool${call.error ? " has-error" : ""}`}>
      <div className="insp-tool-head">
        <span className="mono insp-tool-name">{call.name}</span>
        <span className="faint num">#{call.index + 1}</span>
        {call.error && <Pill tone="danger">error</Pill>}
      </div>

      {args === null ? (
        <div className="insp-tool-args">
          <div className="insp-warn">
            <IconWarning size={12} /> The arguments weren't valid JSON:
          </div>
          <div className="insp-text mono">{call.raw_arguments || "(empty)"}</div>
        </div>
      ) : entries.length > 0 ? (
        <dl className="insp-tool-args">
          {entries.map(([key, value]) => (
            <div key={key} className="insp-arg">
              <dt className="mono">{key}</dt>
              <dd>
                {typeof value === "string" ? (
                  <LongText text={value} maxLines={8} />
                ) : (
                  <div className="insp-text mono">{JSON.stringify(value, null, 2)}</div>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {call.error && <div className="error-text">{call.error}</div>}
      <div className="insp-tool-result">
        <div className="insp-label">Result</div>
        <LongText
          text={call.result}
          maxLines={isDocument ? 1 : 12}
          mono
          expandLabel={isDocument ? `Show document text · ${call.result.length.toLocaleString()} chars` : undefined}
        />
      </div>
    </li>
  );
}

type Fetched<T> = { status: "loading" } | { status: "missing" } | { status: "error"; message: string } | { status: "ready"; data: T };

/* ---------- Post ---------- */

function PostInspector({ state, select, setTick, logIndex, id }: InspectorProps & { id: number }) {
  const post = state.posts.find((candidate) => candidate.id === id);
  if (!post) {
    const tick = logIndex.postTicks.get(id);
    if (tick !== undefined) {
      return <FutureNotice message={`Post #${id} is written at step ${tick}, after the selected step (${state.tick}).`} tick={tick} setTick={setTick} />;
    }
    return <Empty>There is no post #{id} in this run.</Empty>;
  }
  const parent = post.reply_to !== null ? state.posts.find((candidate) => candidate.id === post.reply_to) : undefined;
  const receivers = new Set(post.received_by.map((receipt) => receipt.agent));
  const notYet = state.agents.filter((agent) => agent.info.name !== post.author && !receivers.has(agent.info.name));

  return (
    <>
      <div className="insp-head">
        <span className="insp-head-main mono">#{post.id}</span>
        <AgentName name={post.author} index={agentIndex(state, post.author)} />
        <StepLink state={state} agent={post.author} tick={post.tick} select={select} />
      </div>

      <Section title="Text" aside={`${post.text.length.toLocaleString()} chars`}>
        <div className="insp-text insp-post-text">{post.text}</div>
      </Section>

      {post.reply_to !== null && (
        <Section title="In reply to">
          <PostSnippet id={post.reply_to} author={parent?.author ?? null} text={parent?.text ?? null} state={state} select={select} />
        </Section>
      )}

      <Section title="Received by" aside={`${post.received_by.length} of ${state.agents.length - 1}`}>
        {post.received_by.length === 0 ? (
          <p className="insp-p faint">Nobody has received it yet.</p>
        ) : (
          <ul className="insp-list">
            {post.received_by.map((receipt) => (
              <li key={receipt.agent}>
                <StepLink state={state} agent={receipt.agent} tick={receipt.tick} select={select} />
                <span className="faint num"> · {receipt.tick - post.tick} step{receipt.tick - post.tick === 1 ? "" : "s"} later</span>
              </li>
            ))}
          </ul>
        )}
        {notYet.length > 0 && (
          <p className="insp-p">
            <span className="faint">Not yet received by </span>
            {notYet.map((agent, i) => (
              <span key={agent.info.name}>
                {i > 0 && ", "}
                <AgentName name={agent.info.name} index={agent.info.index} />
                {agent.status === "done" || agent.status === "stopped" ? <span className="faint"> ({agent.status})</span> : null}
              </span>
            ))}
          </p>
        )}
      </Section>

      <Section title="Replies" aside={String(post.replies.length)}>
        {post.replies.length === 0 ? (
          <p className="insp-p faint">No replies yet.</p>
        ) : (
          post.replies.map((replyId) => {
            const reply = state.posts.find((candidate) => candidate.id === replyId);
            return (
              <PostSnippet
                key={replyId}
                id={replyId}
                author={reply?.author ?? null}
                text={reply?.text ?? null}
                state={state}
                select={select}
              />
            );
          })
        )}
      </Section>
    </>
  );
}

function PostSnippet({
  id,
  author,
  text,
  state,
  select,
}: {
  id: number;
  author: string | null;
  text: string | null;
  state: RunState;
  select: ViewProps["select"];
}) {
  return (
    <div className="insp-snippet">
      <div className="insp-snippet-head">
        <PostLink id={id} select={select} />
        {author && <AgentName name={author} index={agentIndex(state, author)} />}
      </div>
      {text !== null && <div className="insp-snippet-text">{text.length > 220 ? `${text.slice(0, 220)}…` : text}</div>}
    </div>
  );
}

/* ---------- Document ---------- */

function DocInspector({ runId, state, select, docId }: InspectorProps & { docId: string }) {
  const meta = state.started.task.docs.find((doc) => doc.id === docId);
  const [doc, setDoc] = useState<Fetched<DocumentResponse>>({ status: "loading" });
  const known = meta !== undefined;

  useEffect(() => {
    if (!known) return;
    let cancelled = false;
    setDoc({ status: "loading" });
    loadDocument(runId, docId)
      .then((data) => !cancelled && setDoc({ status: "ready", data }))
      .catch((error: unknown) => {
        if (cancelled) return;
        setDoc(isNotFound(error) ? { status: "missing" } : { status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, docId, known]);

  const opens = state.steps.flatMap((step) =>
    step.docs_opened.filter((open) => open.doc_id === docId).map((open) => ({ step, first: open.first_open })),
  );
  const openers = new Set(opens.filter((open) => open.first).map((open) => open.step.agent));
  const notOpened = state.agents.filter((agent) => !openers.has(agent.info.name));

  if (!meta) return <Empty>This run's task has no document "{docId}".</Empty>;

  return (
    <>
      <div className="insp-head">
        <span className="insp-head-main">{meta.title}</span>
      </div>
      <Section title="Document">
        <Facts
          items={[
            ["Id", <span className="mono">{meta.id}</span>],
            ["File", <span className="mono">{meta.filename}</span>],
            ["Length", <span className="num">{meta.words.toLocaleString()} words · {meta.chars.toLocaleString()} chars</span>],
            [
              "sha256",
              <span className="mono insp-ellipsis" title={meta.sha256}>
                {meta.sha256.slice(0, 16)}…
              </span>,
            ],
          ]}
        />
      </Section>

      <Section title="Opened by" aside={`${openers.size} of ${state.agents.length}`}>
        {opens.length === 0 ? (
          <p className="insp-p faint">Nobody has opened it yet.</p>
        ) : (
          <ul className="insp-list">
            {opens.map(({ step, first }, i) => (
              <li key={`${step.key}-${i}`}>
                <StepLink state={state} agent={step.agent} tick={step.tick} select={select} />
                <span className="faint">{first ? " · first open" : " · re-open"}</span>
              </li>
            ))}
          </ul>
        )}
        {notOpened.length > 0 && opens.length > 0 && (
          <p className="insp-p">
            <span className="faint">Not opened by </span>
            {notOpened.map((agent) => agent.info.name).join(", ")}
          </p>
        )}
      </Section>

      <Section title="Text">
        {doc.status === "loading" && <p className="insp-p faint">Loading the document…</p>}
        {doc.status === "missing" && <p className="insp-p faint">The document isn't in the run's task snapshot.</p>}
        {doc.status === "error" && <p className="insp-p error-text">Couldn't load it: {doc.message}</p>}
        {doc.status === "ready" && (
          <LongText text={doc.data.text} maxLines={10} expandLabel={`Show full text · ${doc.data.text.length.toLocaleString()} chars`} />
        )}
      </Section>
    </>
  );
}

/* ---------- Deliverable version ---------- */

function VersionInspector({ state, select, setTick, logIndex, version }: InspectorProps & { version: number }) {
  const entry = state.deliverable.find((candidate) => candidate.version === version);
  if (!entry) {
    const tick = logIndex.versionTicks.get(version);
    if (tick !== undefined) {
      return (
        <FutureNotice
          message={`Version ${version} is written at step ${tick}, after the selected step (${state.tick}).`}
          tick={tick}
          setTick={setTick}
        />
      );
    }
    return <Empty>The deliverable has no version {version} in this run.</Empty>;
  }
  const previous = state.deliverable.find((candidate) => candidate.version === entry.replaced_version);
  const readers = state.steps.filter((step) => step.deliverable_reads.includes(version));
  const latest = state.deliverable.at(-1)?.version ?? 0;

  return (
    <>
      <div className="insp-head">
        <span className="insp-head-main mono">v{entry.version}</span>
        <AgentName name={entry.author} index={agentIndex(state, entry.author)} />
        <StepLink state={state} agent={entry.author} tick={entry.tick} select={select} />
        {entry.version === latest && <Pill>latest at step {state.tick}</Pill>}
      </div>

      <Section title="Write">
        <Facts
          items={[
            [
              "Replaced",
              entry.replaced_version === 0 ? (
                "the empty deliverable"
              ) : (
                <span>
                  <VersionLink version={entry.replaced_version} select={select} />
                  {entry.replaced_author && <span className="faint"> by {entry.replaced_author}</span>}
                </span>
              ),
            ],
            [
              "Writer had seen it",
              entry.writer_had_seen_replaced ? (
                "yes"
              ) : (
                <span className="insp-warn">
                  <IconWarning size={12} /> no: overwrote a version it never read
                </span>
              ),
            ],
            ["Length", <span className="num">{entry.text.length.toLocaleString()} chars</span>],
            [
              "Read by",
              <LinkList empty="nobody yet">
                {readers.map((step) => (
                  <StepLink key={step.key} state={state} agent={step.agent} tick={step.tick} select={select} />
                ))}
              </LinkList>,
            ],
          ]}
        />
      </Section>

      <Section title={entry.replaced_version === 0 ? "Changes from the empty deliverable" : `Changes from v${entry.replaced_version}`}>
        <div className="insp-diff">
          <VersionDiff before={previous?.text ?? ""} after={entry.text} />
        </div>
      </Section>

      <Section title="Text">
        <LongText text={entry.text} maxLines={12} />
      </Section>
    </>
  );
}

/* ---------- Agent ---------- */

function AgentInspector({ state, select, openTab, setTranscriptAgent, name }: InspectorProps & { name: string }) {
  const agent = state.agents.find((candidate) => candidate.info.name === name);
  if (!agent) return <Empty>There is no agent named {name} in this run.</Empty>;
  const budget = state.started.config.environment.doc_read_budget;
  const lastStep = [...state.steps].reverse().find((step) => step.agent === name);

  return (
    <>
      <div className="insp-head">
        <AgentName name={name} index={agent.info.index} />
        <AgentStatusPill status={agent.status} />
        <span className="faint mono">{agent.info.model}</span>
      </div>
      <div className="insp-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setTranscriptAgent(name);
            openTab("transcript");
          }}
        >
          <IconExternal size={12} />
          Open transcript
        </button>
        {lastStep && (
          <button type="button" className="btn" onClick={() => select({ kind: "step", agent: name, tick: lastStep.tick })}>
            Latest step ({lastStep.tick})
          </button>
        )}
      </div>

      <Section title={`As of step ${state.tick}`}>
        <Facts
          items={[
            ["Steps", <span className="num">{agent.steps}</span>],
            ["Ticks asleep", <span className="num">{agent.ticks_asleep}</span>],
            ["Posts", <span className="num">{agent.posts}</span>],
            ["First post", agent.first_post_tick === null ? <span className="faint">none yet</span> : `step ${agent.first_post_tick}`],
            ["Unread posts", <span className="num">{agent.unread_posts}</span>],
            ["Reads left", <span className="num">{agent.reads_left} of {budget}</span>],
            ["Deliverable seen", <VersionLink version={agent.last_seen_deliverable} select={select} />],
            ...(agent.done_tick !== null
              ? ([
                  ["Done", `step ${agent.done_tick}`],
                  ["Done note", agent.done_note ?? <span className="faint">none</span>],
                ] as [ReactNode, ReactNode][])
              : []),
            ...(agent.stopped_reason ? ([["Stopped", agent.stopped_reason]] as [ReactNode, ReactNode][]) : []),
          ]}
        />
      </Section>

      <Section title="Documents opened" aside={String(agent.docs_opened.length)}>
        {agent.docs_opened.length === 0 ? (
          <p className="insp-p faint">None yet.</p>
        ) : (
          <ul className="insp-list">
            {agent.docs_opened.map((open) => (
              <li key={open.doc_id}>
                <DocLink id={open.doc_id} select={select} />
                <span className="faint"> · </span>
                <StepLink state={state} agent={name} tick={open.tick} select={select} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Usage">
        <Facts
          items={[
            ["Prompt", <span className="num">{agent.usage.prompt_tokens.toLocaleString()}</span>],
            ["Cached", <span className="num">{agent.usage.cached_tokens.toLocaleString()}</span>],
            ["Completion", <span className="num">{agent.usage.completion_tokens.toLocaleString()}</span>],
            ["Reasoning", <span className="num">{agent.usage.reasoning_tokens.toLocaleString()}</span>],
            ["Cost", <span className="num">{formatUsd(agent.usage.cost_usd)}</span>],
          ]}
        />
      </Section>
    </>
  );
}

/* ---------- Run overview ---------- */

function paramText(value: unknown): string {
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function RunOverview({ state, select }: InspectorProps) {
  const { started, ended } = state;
  const config = started.config;
  const params = config.agents.model.params;
  const endpoint = pinnedEndpoint(config);
  const endpointRecord = started.model_info?.endpoint as { provider_name?: unknown; quantization?: unknown; context_length?: unknown } | undefined;
  // The end is shown only once the selected tick reaches it.
  const end = ended !== null && state.tick >= ended.tick ? ended : null;

  return (
    <>
      <p className="insp-hint">Select a step, post, document, or version to inspect it.</p>

      <Section title="Run">
        <Facts
          items={[
            ["Status", end ? `ended · ${endReasonLabel(end.reason)}` : state.status === "running" ? "running" : "in progress"],
            ...(end?.error ? ([["Error", <span className="error-text">{end.error}</span>]] as [ReactNode, ReactNode][]) : []),
            ...(end && end.unapplied.length > 0
              ? ([["Unapplied calls", `${end.unapplied.length} (paid for, never applied)`]] as [ReactNode, ReactNode][])
              : []),
            ["Seed", <span className="num">{started.seed}</span>],
            ["Step", <span className="num">{state.tick} of {state.tick_cap}</span>],
            ["Started", new Date(started.at).toLocaleString()],
          ]}
        />
      </Section>

      <Section title="Agents" aside={String(state.agents.length)}>
        <ul className="insp-agents">
          {state.agents.map((agent) => (
            <li key={agent.info.name}>
              <button type="button" className="link-btn" onClick={() => select({ kind: "agent", agent: agent.info.name })}>
                <AgentName name={agent.info.name} index={agent.info.index} />
              </button>
              <AgentStatusPill status={agent.status} />
              <span className="faint num">
                {agent.steps} steps · {agent.posts} posts · {formatUsd(agent.usage.cost_usd)}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Task" aside={started.task.name}>
        <LongText text={started.task.text} maxLines={8} />
      </Section>

      <Section title="Model">
        <Facts
          items={[
            ["Id", <span className="mono">{config.agents.model.id}</span>],
            ["Endpoint", endpoint ? <span className="mono">{endpoint}</span> : <span className="faint">not pinned</span>],
            ...(endpointRecord && typeof endpointRecord.provider_name === "string"
              ? ([
                  [
                    "Provider",
                    `${endpointRecord.provider_name}${typeof endpointRecord.quantization === "string" ? ` · ${endpointRecord.quantization}` : ""}`,
                  ],
                ] as [ReactNode, ReactNode][])
              : []),
            ...(endpointRecord && typeof endpointRecord.context_length === "number"
              ? ([["Context", <span className="num">{endpointRecord.context_length.toLocaleString()} tokens</span>]] as [ReactNode, ReactNode][])
              : []),
            ["Reasoning", <span className="mono">{paramText(params["reasoning"])}</span>],
            ["Temperature", <span className="mono">{paramText(params["temperature"])}</span>],
            ["max_tokens", <span className="mono">{paramText(params["max_tokens"])}</span>],
          ]}
        />
      </Section>

      <Section title="Environment">
        <Facts
          items={[
            ["Documents", <span className="num">{started.task.docs.length}</span>],
            ["Read budget", <span className="num">{config.environment.doc_read_budget} per agent</span>],
            ["Post limit", <span className="num">{config.environment.post_max_chars} chars</span>],
            ["Deliverable limit", <span className="num">{config.environment.deliverable_max_chars.toLocaleString()} chars</span>],
            ["Status line", config.environment.status_line ? "on" : "off"],
            ["Roster known", config.environment.roster_known ? "yes" : "no"],
            ["Kickoff", config.environment.kickoff],
            ["Step cap", <span className="num">{config.run.tick_cap}</span>],
            ["Tool calls per step", <span className="num">{config.run.max_tool_calls_per_step}</span>],
            ["Cost cap", <span className="num">{formatUsd(config.run.max_cost_usd)}</span>],
          ]}
        />
        <Disclosure label="Resolved config">{() => <JsonView value={config} label="config" defaultDepth={2} />}</Disclosure>
        <Disclosure label="System prompts">
          {() => <JsonView value={started.system_prompts} label="system_prompts" defaultDepth={1} />}
        </Disclosure>
      </Section>
    </>
  );
}
