import { Fragment, useEffect, useMemo, useState } from "react";
import type { DocumentResponse } from "../../shared/api.ts";
import { agentByName } from "../../shared/derive.ts";
import { errorMessage, loadDocument } from "../api.ts";
import type { ViewProps } from "../contract.ts";
import { formatInt } from "../transcript.ts";
import { ProseText } from "./DeliverableView.tsx";
import { AgentDot, Pill } from "./primitives.tsx";
import "./Documents.css";

type Loaded =
  | { kind: "loading"; key: string }
  | { kind: "error"; key: string; message: string }
  | { kind: "loaded"; key: string; doc: DocumentResponse };

function useDocument(runId: string, docId: string | null): { loaded: Loaded | null; retry(): void } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (docId === null) return;
    const key = `${runId}\n${docId}`;
    let alive = true;
    setLoaded({ kind: "loading", key });
    loadDocument(runId, docId).then(
      (doc) => alive && setLoaded({ kind: "loaded", key, doc }),
      (error: unknown) => alive && setLoaded({ kind: "error", key, message: errorMessage(error) }),
    );
    return () => {
      alive = false;
    };
  }, [runId, docId, attempt]);
  const current = docId !== null && loaded?.key === `${runId}\n${docId}` ? loaded : null;
  return { loaded: current, retry: () => setAttempt((n) => n + 1) };
}

export function Documents({ runId, state, selection, select }: ViewProps) {
  const docs = state.started.task.docs;
  const selectedDoc = selection.kind === "doc" && docs.some((doc) => doc.id === selection.id) ? selection.id : null;
  // The reader keeps showing the last document selected here while the selection moves elsewhere.
  const [shownId, setShownId] = useState<string | null>(selectedDoc ?? docs[0]?.id ?? null);
  if (selectedDoc !== null && selectedDoc !== shownId) setShownId(selectedDoc);
  const shown = docs.find((doc) => doc.id === shownId) ?? null;
  const { loaded, retry } = useDocument(runId, shown?.id ?? null);

  const openers = useMemo(() => {
    const byDoc = new Map<string, { agent: string; tick: number }[]>();
    for (const cell of state.coverage) {
      const list = byDoc.get(cell.doc_id) ?? [];
      list.push({ agent: cell.agent, tick: cell.tick });
      byDoc.set(cell.doc_id, list);
    }
    return byDoc;
  }, [state.coverage]);

  const agentIndex = (name: string) => agentByName(state, name)?.info.index ?? 0;
  const shownOpeners = shown ? (openers.get(shown.id) ?? []) : [];

  return (
    <div className="view docs-root">
      <div className="docs-grid">
      <section className="docs-list-pane" aria-label="Documents">
        <header className="panel-header">
          <h2 className="panel-title">Documents</h2>
          <span className="panel-count">
            {docs.length} · {state.metrics.coverage.opened} opened as of step {state.tick}
          </span>
        </header>
        {docs.length === 0 ? (
          <p className="state-message">This task has no documents.</p>
        ) : (
          <ul className="panel-body docs-list">
            {docs.map((doc) => {
              const docOpeners = openers.get(doc.id) ?? [];
              const isShown = doc.id === shownId;
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    className={`docs-item${isShown ? " is-selected" : ""}`}
                    aria-current={isShown ? "true" : undefined}
                    onClick={() => select({ kind: "doc", id: doc.id })}
                  >
                    <span className="docs-item-id">{doc.id}</span>
                    <span className="docs-item-row">
                      <span className="docs-item-title">{doc.title}</span>
                      <span className="docs-item-words">{formatInt(doc.words)} words</span>
                    </span>
                    <span className="docs-item-openers">
                      {docOpeners.length === 0 ? (
                        <span className="docs-unread">unread</span>
                      ) : (
                        docOpeners.map((opener) => (
                          <span key={opener.agent} className="docs-opener" title={`${opener.agent} opened it at step ${opener.tick}`}>
                            <AgentDot index={agentIndex(opener.agent)} />
                            {opener.agent} <span className="docs-opener-step">{opener.tick}</span>
                          </span>
                        ))
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="docs-reader-pane" aria-label={shown ? `Document ${shown.id}` : "Document"}>
        <header className="panel-header">
          <h2 className="panel-title docs-reader-title">{shown ? shown.title : "Document"}</h2>
          {shown && (
            <span className="panel-count">
              {shown.id} · {formatInt(shown.words)} words
            </span>
          )}
        </header>
        <div className="panel-body docs-reader-body">
          {shown === null ? (
            <p className="state-message">Select a document to read it.</p>
          ) : (
            <>
              <p className="docs-reader-openers">
                {shownOpeners.length === 0 ? (
                  <Pill tone="danger">Not opened by anyone as of step {state.tick}</Pill>
                ) : (
                  <>
                    Opened by{" "}
                    {shownOpeners.map((opener, i) => (
                      <Fragment key={opener.agent}>
                        {i > 0 && ", "}
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => select({ kind: "step", agent: opener.agent, tick: opener.tick })}
                        >
                          {opener.agent} at step {opener.tick}
                        </button>
                      </Fragment>
                    ))}
                  </>
                )}
              </p>
              {loaded === null || loaded.kind === "loading" ? (
                <p className="empty-note" role="status">
                  Loading the document…
                </p>
              ) : loaded.kind === "error" ? (
                <p className="error-text" role="alert">
                  Couldn't load {shown.id}: {loaded.message}.{" "}
                  <button type="button" className="link-btn" onClick={retry}>
                    Try again
                  </button>
                </p>
              ) : (
                <ProseText text={loaded.doc.text} />
              )}
            </>
          )}
        </div>
      </section>
      </div>
    </div>
  );
}
