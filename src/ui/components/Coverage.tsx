import { useMemo, type MouseEvent } from "react";
import type { ViewProps } from "../contract.ts";
import { stepKey } from "../../shared/derive.ts";
import { formatInt, unreadSummary } from "../transcript.ts";
import { AgentDot, Pill, agentColor, agentInk } from "./primitives.tsx";
import "./Coverage.css";

export function Coverage({ state, selection, select }: ViewProps) {
  const docs = state.started.task.docs;
  const agents = state.agents;
  const budget = state.started.config.environment.doc_read_budget;
  const { opened, total, never_opened, duplicate_opens } = state.metrics.coverage;

  /** First-open tick by `${doc}\n${agent}`, and openers per document. */
  const { firstOpen, openers } = useMemo(() => {
    const firstOpen = new Map<string, number>();
    const openers = new Map<string, number>();
    for (const cell of state.coverage) {
      firstOpen.set(`${cell.doc_id}\n${cell.agent}`, cell.tick);
      openers.set(cell.doc_id, (openers.get(cell.doc_id) ?? 0) + 1);
    }
    return { firstOpen, openers };
  }, [state.coverage]);

  // The selected step's opens are highlighted, as is the selected document's row.
  const stepDocs = useMemo(() => {
    if (selection.kind !== "step") return new Set<string>();
    const step = state.step_by_key[stepKey(selection.agent, selection.tick)];
    return new Set(step?.docs_opened.map((opened) => opened.doc_id) ?? []);
  }, [selection, state.step_by_key]);

  const selectRow = (docId: string) => (event: MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    select({ kind: "doc", id: docId });
  };

  return (
    <div className="view">
      <header className="panel-header">
        <h2 className="panel-title">Coverage</h2>
        <span className="panel-count">
          {opened} of {total} documents opened · {formatInt(duplicate_opens)} duplicate{" "}
          {duplicate_opens === 1 ? "open" : "opens"} · {unreadSummary(never_opened)}
        </span>
        <span className="spacer" />
        <span className="panel-count">as of step {state.tick}</span>
      </header>
      {docs.length === 0 ? (
        <p className="state-message">This task has no documents.</p>
      ) : (
        <div className="panel-body">
          <table className="cov-table">
            <thead>
              <tr>
                <th scope="col" className="cov-doc-col">
                  Document
                </th>
                <th scope="col" className="cov-num">
                  Words
                </th>
                {agents.map((agent) => (
                  <th
                    scope="col"
                    key={agent.info.name}
                    className={`cov-agent-col${selection.kind === "agent" && selection.agent === agent.info.name ? " is-selected" : ""}`}
                  >
                    <span className="cov-agent-head">
                      <AgentDot index={agent.info.index} />
                      {agent.info.name}
                    </span>
                  </th>
                ))}
                <th scope="col" className="cov-summary-col">
                  Opened by
                </th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => {
                const count = openers.get(doc.id) ?? 0;
                const rowClass = [
                  "cov-row",
                  selection.kind === "doc" && selection.id === doc.id ? "is-selected" : "",
                  stepDocs.has(doc.id) ? "is-related" : "",
                  count === 0 ? "is-unread" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr key={doc.id} className={rowClass} onClick={selectRow(doc.id)}>
                    <th scope="row" className="cov-doc-col">
                      <button
                        type="button"
                        className="cov-doc"
                        aria-current={selection.kind === "doc" && selection.id === doc.id ? "true" : undefined}
                        onClick={() => select({ kind: "doc", id: doc.id })}
                      >
                        <span className="cov-doc-id">{doc.id}</span>
                        <span className="cov-doc-title">{doc.title}</span>
                      </button>
                    </th>
                    <td className="cov-num">{formatInt(doc.words)}</td>
                    {agents.map((agent) => {
                      const name = agent.info.name;
                      const tick = firstOpen.get(`${doc.id}\n${name}`);
                      const isSelected =
                        selection.kind === "step" && selection.agent === name && selection.tick === tick;
                      return (
                        <td key={name} className="cov-cell">
                          {tick === undefined ? (
                            <span className="cov-none" aria-label={`${name} hasn't opened ${doc.id}`}>
                              ·
                            </span>
                          ) : (
                            <button
                              type="button"
                              className={`cov-fill${isSelected ? " is-selected" : ""}`}
                              style={{ background: agentColor(agent.info.index), color: agentInk(agent.info.index) }}
                              aria-label={`${name} opened ${doc.id} at step ${tick}`}
                              title={`${name} opened ${doc.id} at step ${tick}`}
                              onClick={() => select({ kind: "step", agent: name, tick })}
                            >
                              {tick}
                            </button>
                          )}
                        </td>
                      );
                    })}
                    <td className="cov-summary-col">
                      {count === 0 ? (
                        <Pill tone="danger">unread</Pill>
                      ) : (
                        <span className="cov-summary">
                          {count} {count === 1 ? "agent" : "agents"}
                          {count > 1 && (
                            <span className="cov-dup" title="Opens beyond the first">
                              +{count - 1} duplicate
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2} className="cov-foot-label">
                  Reads used
                </th>
                {agents.map((agent) => {
                  const used = budget - agent.reads_left;
                  return (
                    <td key={agent.info.name} className={`cov-foot${used >= budget ? " is-full" : ""}`}>
                      {used} / {budget}
                    </td>
                  );
                })}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
