import { useState, type ReactNode } from "react";
import { formatTokens, formatUsd } from "../../shared/derive.ts";
import type { RunState } from "../../shared/runstate.ts";
import type { RunEndReason } from "../../shared/types.ts";
import type { ViewProps } from "../contract.ts";
import { formatInt, lineCount, unreadSummary } from "../transcript.ts";
import { AgentStatusPill } from "./AgentStatus.tsx";
import { ProseText } from "./DeliverableView.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { AgentName } from "./primitives.tsx";
import { RunCost } from "./RunsList.tsx";
import "./Summary.css";

const END_REASONS: Record<RunEndReason, string> = {
  all_done: "Every agent called done",
  all_stopped: "Every agent done or stopped",
  quiescent: "Quiescent: no agent awake",
  tick_cap: "Tick cap reached",
  cost_cap: "Cost cap reached",
  api_error: "API error",
  interrupted: "Interrupted",
};

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

function MetricCard({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="sum-card">
      <div className="sum-card-label">{label}</div>
      <div className="sum-card-value">{value}</div>
      {detail !== undefined && <div className="sum-card-detail">{detail}</div>}
    </div>
  );
}

/** The run's end, as of the selected tick: nothing after it has happened yet. */
function endCard(state: RunState): { value: string; detail: string } {
  const ended = state.ended;
  if (ended && state.tick >= ended.tick) {
    return {
      value: END_REASONS[ended.reason],
      detail: `${ended.reason} after step ${ended.tick}${ended.error ? ` · ${ended.error}` : ""}`,
    };
  }
  return {
    value: "In progress",
    detail: `step ${state.tick} of ${state.tick_cap}${state.status === "running" ? " · run is live" : ""}`,
  };
}

/** Endpoint fields worth showing from model_info.endpoint (an OpenRouter endpoint record, kept verbatim). */
function endpointFields(endpoint: unknown): [string, string][] {
  if (typeof endpoint !== "object" || endpoint === null) return [];
  const record = endpoint as Record<string, unknown>;
  const fields: [string, string][] = [];
  const add = (label: string, value: unknown, format: (v: never) => string = String) => {
    if (value !== undefined && value !== null && value !== "") fields.push([label, format(value as never)]);
  };
  add("Provider", record.provider_name);
  add("Endpoint", record.tag);
  add("Quantization", record.quantization);
  add("Context", record.context_length, (v: number) => `${formatInt(v)} tokens`);
  add("Max output", record.max_completion_tokens, (v: number) => `${formatInt(v)} tokens`);
  if (typeof record.pricing === "object" && record.pricing !== null) {
    const pricing = record.pricing as Record<string, unknown>;
    const perMillion = (value: unknown) => {
      const n = Number(value);
      return Number.isFinite(n) ? `$${(n * 1_000_000).toPrecision(3)}/M` : String(value);
    };
    if (pricing.prompt !== undefined) fields.push(["Input price", perMillion(pricing.prompt)]);
    if (pricing.completion !== undefined) fields.push(["Output price", perMillion(pricing.completion)]);
  }
  return fields;
}

function settingValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function DefinitionList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="sum-dl">
      {rows.map(([label, value]) => (
        <div key={label} className="sum-dl-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const PREVIEW_LINES = 24;

export function Summary({ state, select, openTab, setTranscriptAgent }: ViewProps) {
  const { metrics, started } = state;
  const config = started.config;
  const [showWholeDeliverable, setShowWholeDeliverable] = useState(false);

  const coverage = metrics.coverage;
  const board = metrics.board;
  const blind = metrics.posting_blind;
  const deliverable = metrics.deliverable;
  const usage = metrics.cost.usage;
  const end = endCard(state);
  const firstPost = Object.values(board.per_agent).reduce<number | null>(
    (first, agent) => (agent.first_post_tick === null ? first : first === null ? agent.first_post_tick : Math.min(first, agent.first_post_tick)),
    null,
  );
  const latest = state.deliverable.at(-1) ?? null;
  const previewText =
    latest === null || showWholeDeliverable || lineCount(latest.text) <= PREVIEW_LINES
      ? (latest?.text ?? "")
      : latest.text.split("\n").slice(0, PREVIEW_LINES).join("\n");
  const doneNotes = state.agents.filter((agent) => agent.done_note !== null && agent.done_tick !== null);
  const endpoint = endpointFields(started.model_info?.endpoint);

  return (
    <div className="view">
      <header className="panel-header">
        <h2 className="panel-title">Summary</h2>
        <span className="panel-count">as of step {state.tick}</span>
      </header>
      <div className="panel-body sum-body">
        <section className="sum-cards" aria-label="Metrics">
          <MetricCard
            label="Coverage"
            value={`${coverage.opened} of ${coverage.total} documents`}
            detail={`${formatInt(coverage.duplicate_opens)} duplicate ${coverage.duplicate_opens === 1 ? "open" : "opens"} · ${unreadSummary(coverage.never_opened)}`}
          />
          <MetricCard
            label="Board"
            value={`${formatInt(board.posts)} ${board.posts === 1 ? "post" : "posts"}`}
            detail={`${formatInt(board.replies)} ${board.replies === 1 ? "reply" : "replies"}${firstPost === null ? "" : ` · first at step ${firstPost}`}`}
          />
          <MetricCard
            label="Posting blind"
            value={`${formatInt(blind.with_unread)} of ${formatInt(blind.posts)} posts`}
            detail={`${percent(blind.with_unread, blind.posts)} posted with unread posts from earlier steps`}
          />
          <MetricCard
            label="Deliverable"
            value={`${formatInt(deliverable.versions)} ${deliverable.versions === 1 ? "version" : "versions"}`}
            detail={`${deliverable.authors.length} ${deliverable.authors.length === 1 ? "author" : "authors"} · ${formatInt(deliverable.unseen_overwrites)} unseen ${deliverable.unseen_overwrites === 1 ? "overwrite" : "overwrites"} · ${formatInt(deliverable.final_length)} chars`}
          />
          <MetricCard
            label="Tokens and cost"
            value={<RunCost usd={usage.cost_usd} mode={started.mode} />}
            detail={`${formatTokens(usage.prompt_tokens)} in (${formatTokens(usage.cached_tokens)} cached) · ${formatTokens(usage.completion_tokens)} out · ${formatTokens(usage.reasoning_tokens)} reasoning`}
          />
          <MetricCard label="End" value={end.value} detail={end.detail} />
        </section>

        <section className="sum-section" aria-labelledby="sum-agents">
          <h3 id="sum-agents" className="sum-heading">
            Agents
          </h3>
          <div className="sum-table-wrap">
            <table className="sum-table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="sum-num">
                    Posts
                  </th>
                  <th scope="col" className="sum-num">
                    First post
                  </th>
                  <th scope="col" className="sum-num">
                    Docs opened
                  </th>
                  <th scope="col" className="sum-num">
                    Steps
                  </th>
                  <th scope="col" className="sum-num">
                    Ticks asleep
                  </th>
                  <th scope="col" className="sum-num">
                    Done
                  </th>
                  <th scope="col" className="sum-num">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.agents.map((agent) => {
                  const name = agent.info.name;
                  const perBoard = board.per_agent[name];
                  const activity = metrics.activity[name];
                  return (
                    <tr key={name}>
                      <th scope="row">
                        <button
                          type="button"
                          className="link-btn sum-agent"
                          title={`Show ${name}'s transcript`}
                          onClick={() => {
                            setTranscriptAgent(name);
                            select({ kind: "agent", agent: name });
                            openTab("transcript");
                          }}
                        >
                          <AgentName name={name} index={agent.info.index} />
                        </button>
                      </th>
                      <td>
                        <AgentStatusPill status={agent.status} reason={agent.stopped_reason} />
                      </td>
                      <td className="sum-num">{formatInt(perBoard?.posts ?? agent.posts)}</td>
                      <td className="sum-num">{perBoard?.first_post_tick ?? "–"}</td>
                      <td className="sum-num">
                        {agent.docs_opened.length} / {config.environment.doc_read_budget}
                      </td>
                      <td className="sum-num">{formatInt(activity?.steps ?? agent.steps)}</td>
                      <td className="sum-num">{formatInt(activity?.ticks_asleep ?? agent.ticks_asleep)}</td>
                      <td className="sum-num">{activity?.done_tick ?? "–"}</td>
                      <td className="sum-num">{formatUsd(metrics.cost.per_agent[name]?.cost_usd ?? agent.usage.cost_usd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {doneNotes.length > 0 && (
            <Disclosure className="sum-notes" label="Done notes" meta={`${doneNotes.length}`}>
              <ul className="sum-notes-list">
                {doneNotes.map((agent) => (
                  <li key={agent.info.name}>
                    <span className="sum-note-who">
                      <AgentName name={agent.info.name} index={agent.info.index} /> at step {agent.done_tick}
                    </span>
                    <span className="sum-note-text">{agent.done_note}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </section>

        <section className="sum-section" aria-labelledby="sum-deliverable">
          <div className="sum-heading-row">
            <h3 id="sum-deliverable" className="sum-heading">
              Deliverable
            </h3>
            {latest && (
              <span className="panel-count">
                v{latest.version} by {latest.author} at step {latest.tick} · {formatInt(latest.text.length)} chars
              </span>
            )}
            {latest && (
              <button type="button" className="link-btn sum-heading-link" onClick={() => openTab("deliverable")}>
                Open version history
              </button>
            )}
          </div>
          {latest === null ? (
            <p className="empty-note">No one has written the deliverable yet.</p>
          ) : (
            <div className="sum-preview">
              <ProseText text={previewText} />
              {lineCount(latest.text) > PREVIEW_LINES && (
                <button
                  type="button"
                  className="toggle-btn sum-preview-toggle"
                  aria-expanded={showWholeDeliverable}
                  onClick={() => setShowWholeDeliverable((open) => !open)}
                >
                  {showWholeDeliverable ? "Show less" : `Show all ${formatInt(lineCount(latest.text))} lines`}
                </button>
              )}
            </div>
          )}
        </section>

        <section className="sum-section" aria-labelledby="sum-task">
          <h3 id="sum-task" className="sum-heading">
            Task
          </h3>
          <Disclosure
            label={started.task.name}
            meta={`${formatInt(started.task.text.length)} chars · ${started.task.docs.length} documents`}
            preview={started.task.text.split("\n").find((line) => line.trim() !== "")}
          >
            <ProseText text={started.task.text} className="sum-task-text" />
          </Disclosure>
        </section>

        <section className="sum-section" aria-labelledby="sum-config">
          <h3 id="sum-config" className="sum-heading">
            Configuration
          </h3>
          <div className="sum-config">
            <div>
              <h4 className="sum-subheading">Run</h4>
              <DefinitionList
                rows={[
                  ["Run id", <span className="sum-mono">{state.run_id}</span>],
                  ["Seed", <span className="sum-mono">{started.seed}</span>],
                  ["Agents", `${state.agents.length}: ${state.agents.map((agent) => agent.info.name).join(", ")}`],
                  ...Object.entries(config.run).map(
                    ([key, value]): [string, ReactNode] => [key, <span className="sum-mono">{settingValue(value)}</span>],
                  ),
                ]}
              />
            </div>
            <div>
              <h4 className="sum-subheading">Model</h4>
              <DefinitionList
                rows={[
                  ["Model id", <span className="sum-mono">{config.agents.model.id}</span>],
                  ...endpoint.map(([label, value]): [string, ReactNode] => [label, <span className="sum-mono">{value}</span>]),
                  ...(started.model_info === null ? [["Endpoint", "not recorded (scripted runs, offline runs, and re-runs make no catalog lookup)"] as [string, ReactNode]] : []),
                ]}
              />
              <pre className="pre-block sum-params" aria-label="Model params">
                {JSON.stringify(config.agents.model.params, null, 2)}
              </pre>
            </div>
            <div>
              <h4 className="sum-subheading">Environment</h4>
              <DefinitionList
                rows={Object.entries(config.environment).map(([key, value]): [string, ReactNode] => [
                  key,
                  <span className="sum-mono">{settingValue(value)}</span>,
                ])}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
