import { diffWords } from "diff";
import { Fragment, useLayoutEffect, useMemo, useRef } from "react";
import { agentByName, stepKey } from "../../shared/derive.ts";
import type { RunState } from "../../shared/runstate.ts";
import type { DeliverableVersion } from "../../shared/types.ts";
import type { ViewProps } from "../contract.ts";
import { IconWarning } from "../icons.tsx";
import { formatDelta, formatInt } from "../transcript.ts";
import type { DeliverableMode } from "../url.ts";
import { AgentName } from "./primitives.tsx";
import "./DeliverableView.css";

/**
 * Plain text shown exactly as written (whitespace kept), with Markdown heading lines set in bold so long
 * documents are easier to scan. Shared by the deliverable, documents, and summary views.
 */
export function ProseText({ text, className }: { text: string; className?: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <div className={className ? `prose ${className}` : "prose"}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {/^#{1,6}\s/.test(line) ? <span className="prose-heading">{line}</span> : line}
          {i < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </div>
  );
}

/** Word-level diff of two texts: insertions and struck-through deletions, unchanged text as is. */
export function VersionDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffWords(before, after), [before, after]);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.added) added += part.value.length;
    else if (part.removed) removed += part.value.length;
  }
  return (
    <div className="dv-diff">
      <div className="dv-diff-stats">
        <span className="dv-stat-add">+{formatInt(added)} chars added</span>
        <span className="dv-stat-del">−{formatInt(removed)} chars removed</span>
      </div>
      {parts.length === 0 || (added === 0 && removed === 0) ? (
        <p className="empty-note">No changes.</p>
      ) : (
        <div className="prose">
          {parts.map((part, i) =>
            part.added ? (
              <ins key={i} className="dv-add">
                {part.value}
              </ins>
            ) : part.removed ? (
              <del key={i} className="dv-del">
                {part.value}
              </del>
            ) : (
              <span key={i}>{part.value}</span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function agentIndex(state: RunState, name: string): number {
  return agentByName(state, name)?.info.index ?? 0;
}

/** First read of each version by each agent, up to the selected tick. */
function readersByVersion(state: RunState): Map<number, { agent: string; tick: number }[]> {
  const readers = new Map<number, { agent: string; tick: number }[]>();
  for (const step of state.steps) {
    for (const version of step.deliverable_reads) {
      if (version === 0) continue;
      const list = readers.get(version) ?? [];
      if (!list.some((reader) => reader.agent === step.agent)) list.push({ agent: step.agent, tick: step.tick });
      readers.set(version, list);
    }
  }
  return readers;
}

function unseenFlag(version: DeliverableVersion): string | null {
  if (version.writer_had_seen_replaced || version.replaced_version === 0) return null;
  return `Overwrote v${version.replaced_version} by ${version.replaced_author ?? "unknown"} without reading it`;
}

export interface DeliverableViewProps extends ViewProps {
  mode: DeliverableMode;
  setMode(mode: DeliverableMode): void;
}

export function DeliverableView({ state, selection, select, mode, setMode }: DeliverableViewProps) {
  const versions = state.deliverable;
  const latest = versions.at(-1) ?? null;
  const picked = selection.kind === "version" ? (versions.find((v) => v.version === selection.version) ?? null) : null;
  const shown = picked ?? latest;
  const listRef = useRef<HTMLOListElement>(null);
  const shownVersion = shown?.version ?? null;
  // Keep the shown version's row in view (it may be selected from another view).
  useLayoutEffect(() => {
    if (shownVersion === null) return;
    listRef.current?.querySelector(`[data-version="${shownVersion}"]`)?.scrollIntoView({ block: "nearest" });
  }, [shownVersion]);
  const readers = useMemo(() => readersByVersion(state), [state]);
  const selectedStep = selection.kind === "step" ? state.step_by_key[stepKey(selection.agent, selection.tick)] : undefined;

  if (latest === null || shown === null) {
    return (
      <div className="view">
        <header className="panel-header">
          <h2 className="panel-title">Deliverable</h2>
          <span className="panel-count">as of step {state.tick}</span>
        </header>
        <p className="state-message">No one has written the deliverable yet.</p>
      </div>
    );
  }

  const previous = versions.find((v) => v.version === shown.replaced_version) ?? null;
  const overwrittenBy = versions.find((v) => v.replaced_version === shown.version) ?? null;
  const shownReaders = (readers.get(shown.version) ?? []).filter((reader) => reader.agent !== shown.author);
  const flag = unseenFlag(shown);

  return (
    <div className="view dv-root">
      <div className="dv-grid">
      <section className="dv-list-pane" aria-label="Deliverable versions">
        <header className="panel-header">
          <h2 className="panel-title">Versions</h2>
          <span className="panel-count">{versions.length}</span>
        </header>
        <ol className="panel-body dv-list" reversed ref={listRef}>
          {[...versions].reverse().map((version) => {
            const before = versions.find((v) => v.version === version.replaced_version)?.text.length ?? 0;
            const versionFlag = unseenFlag(version);
            const isShown = version.version === shown.version;
            const relation = selectedStep?.deliverable_writes.includes(version.version)
              ? "written by the selected step"
              : selectedStep?.deliverable_reads.includes(version.version)
                ? "read by the selected step"
                : null;
            return (
              <li key={version.version} data-version={version.version}>
                <button
                  type="button"
                  className={`dv-version${isShown ? " is-selected" : ""}${relation ? " is-related" : ""}`}
                  aria-current={isShown ? "true" : undefined}
                  onClick={() => select({ kind: "version", version: version.version })}
                >
                  <span className="dv-version-row">
                    <span className="dv-version-number">v{version.version}</span>
                    <AgentName name={version.author} index={agentIndex(state, version.author)} />
                    <span className="dv-version-step">step {version.tick}</span>
                    <span
                      className="dv-version-delta"
                      title={`${formatInt(version.text.length)} characters, ${formatDelta(version.text.length - before)} from the version it replaced`}
                    >
                      {formatDelta(version.text.length - before)}
                    </span>
                  </span>
                  {relation && <span className="dv-relation">{relation}</span>}
                  {versionFlag && (
                    <span className="dv-flag">
                      <IconWarning size={12} />
                      {versionFlag}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="dv-view-pane" aria-label={`Version ${shown.version}`}>
        <header className="panel-header dv-view-head">
          <h2 className="panel-title">
            v{shown.version} by {shown.author}
          </h2>
          <span className="panel-count">
            step {shown.tick} · {formatInt(shown.text.length)} chars
          </span>
          <div className="segmented" role="group" aria-label="Show">
            <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
              Text
            </button>
            <button type="button" aria-pressed={mode === "changes"} onClick={() => setMode("changes")}>
              Changes
            </button>
          </div>
        </header>
        <div className="panel-body dv-view-body">
          <div className="dv-facts">
            <p>
              Current as of step {state.tick}: v{latest.version} by {latest.author}
              {shown.version !== latest.version && (
                <>
                  {" · "}
                  <button type="button" className="link-btn" onClick={() => select({ kind: "version", version: latest.version })}>
                    show current
                  </button>
                </>
              )}
            </p>
            {flag && (
              <p className="dv-flag">
                <IconWarning size={12} />
                {flag}
              </p>
            )}
            <p className="dv-fact-muted">
              {shown.replaced_version === 0 ? "Replaced the empty deliverable" : `Replaced v${shown.replaced_version} by ${shown.replaced_author ?? "unknown"}`}
              {" · "}
              {overwrittenBy ? (
                <>
                  overwritten by{" "}
                  <button type="button" className="link-btn" onClick={() => select({ kind: "version", version: overwrittenBy.version })}>
                    v{overwrittenBy.version}
                  </button>{" "}
                  ({overwrittenBy.author}, step {overwrittenBy.tick})
                </>
              ) : (
                "not overwritten yet"
              )}
            </p>
            <p className="dv-fact-muted">
              {shownReaders.length === 0 ? (
                "Not read by anyone yet."
              ) : (
                <>
                  Read by{" "}
                  {shownReaders.map((reader, i) => (
                    <Fragment key={reader.agent}>
                      {i > 0 && ", "}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => select({ kind: "step", agent: reader.agent, tick: reader.tick })}
                      >
                        {reader.agent} at step {reader.tick}
                      </button>
                    </Fragment>
                  ))}
                </>
              )}
            </p>
          </div>
          {mode === "text" ? (
            <ProseText text={shown.text} className="dv-text" />
          ) : (
            <>
              <p className="dv-fact-muted">
                {previous ? `Changes from v${previous.version} by ${previous.author}` : "Changes from the empty deliverable"}
              </p>
              <VersionDiff before={previous?.text ?? ""} after={shown.text} />
            </>
          )}
        </div>
      </section>
      </div>
    </div>
  );
}
