import { useEffect, useState } from "react";
import type { RunStatus, RunSummary } from "../../shared/api.ts";
import { formatUsd } from "../../shared/derive.ts";
import type { RunMode } from "../../shared/events.ts";
import type { RunEndReason } from "../../shared/types.ts";
import { errorMessage, listRuns } from "../api.ts";
import { runHref } from "../url.ts";
import { useNow } from "../useRun.ts";
import { Pill, type PillTone } from "./primitives.tsx";
import "./RunsList.css";

const REFRESH_MS = 3000;

const END_REASON_LABELS: Record<RunEndReason, string> = {
  all_done: "all done",
  all_stopped: "all stopped",
  quiescent: "quiescent",
  tick_cap: "step cap",
  cost_cap: "cost cap",
  api_error: "API error",
  interrupted: "interrupted",
};

export function endReasonLabel(reason: RunEndReason): string {
  return END_REASON_LABELS[reason] ?? reason;
}

function endReasonTone(reason: RunEndReason | null): PillTone {
  if (reason === "api_error") return "danger";
  if (reason === "interrupted" || reason === "cost_cap") return "warning";
  return "neutral";
}

/** A run's status: live (with a pulsing dot), ended with its reason, or stale. */
export function StatusPill({ status, endReason }: { status: RunStatus; endReason: RunEndReason | null }) {
  if (status === "running") {
    return (
      <Pill tone="success" title="The run is still logging events">
        <span className="live-dot" aria-hidden="true" />
        live
      </Pill>
    );
  }
  if (status === "stale") {
    return (
      <Pill tone="warning" title="No new events for longer than any healthy step takes; the harness was probably stopped">
        stale
      </Pill>
    );
  }
  return (
    <Pill tone={endReasonTone(endReason)} title={endReason ? `Ended: ${endReason}` : "Ended"}>
      ended{endReason ? ` · ${endReasonLabel(endReason)}` : ""}
    </Pill>
  );
}

/** Marks a run whose model calls cost nothing: scripted, or re-run offline. Nothing for a live run. */
export function ModePill({ mode }: { mode: RunMode }) {
  if (mode === "scripted") {
    return (
      <Pill tone="accent" title="Scripted fake model: no model was called, and its costs are simulated">
        scripted
      </Pill>
    );
  }
  if (mode === "offline") {
    return (
      <Pill
        tone="accent"
        title="Every response came from the response cache: the costs are those of the original calls, and nothing new was spent"
      >
        offline re-run
      </Pill>
    );
  }
  return null;
}

/** A cost in USD. A scripted run's is muted, so it never reads as real spend. */
export function RunCost({ usd, mode }: { usd: number; mode: RunMode }) {
  if (mode !== "scripted") return <>{formatUsd(usd)}</>;
  return (
    <span className="cost-simulated" title="simulated cost (scripted model)">
      {formatUsd(usd)}
    </span>
  );
}

/** "just now", "42 s ago", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function formatRelative(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.round((nowMs - at) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(at).toLocaleDateString();
}

function newestFirst(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id));
}

export function RunsList() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(5000);

  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Refreshes pause while the page is hidden; the first load always happens.
    const load = async () => {
      if (!loaded || !document.hidden) {
        loaded = true;
        try {
          const list = await listRuns();
          if (cancelled) return;
          setRuns(newestFirst(list));
          setError(null);
        } catch (failure) {
          if (cancelled) return;
          setError(errorMessage(failure));
        }
      }
      if (!cancelled) timer = setTimeout(load, REFRESH_MS);
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const open = (id: string) => {
    window.location.hash = runHref(id);
  };

  return (
    <div className="runs-page">
      <header className="runs-header">
        <h1 className="runs-title">Runs</h1>
        {runs && <span className="panel-count">{runs.length}</span>}
        <span className="runs-refresh faint">Refreshes every 3 s</span>
      </header>

      {error && (
        <div className="runs-error" role="alert">
          {runs ? "Couldn't refresh the list: " : "Couldn't load runs: "}
          {error}
        </div>
      )}

      <div className="runs-body">
        {runs === null && !error && <div className="state-message">Loading runs…</div>}
        {runs !== null && runs.length === 0 && (
          <div className="state-message">
            No runs yet. Start one with <code className="runs-code">npm run swarm -- configs/smoke.yaml</code>
          </div>
        )}
        {runs !== null && runs.length > 0 && (
          <table className="runs-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Run</th>
                <th scope="col">Task</th>
                <th scope="col">Model</th>
                <th scope="col" className="num-col">
                  Seed
                </th>
                <th scope="col" className="num-col">
                  Agents
                </th>
                <th scope="col" className="num-col">
                  Steps
                </th>
                <th scope="col" className="num-col">
                  Posts
                </th>
                <th scope="col" className="num-col">
                  Versions
                </th>
                <th scope="col" className="num-col">
                  Cost
                </th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="runs-row" onClick={() => open(run.id)}>
                  <td>
                    <StatusPill status={run.status} endReason={run.end_reason} />
                  </td>
                  <td>
                    <span className="runs-run">
                      <a className="runs-id mono" href={runHref(run.id)} onClick={(event) => event.stopPropagation()}>
                        {run.id}
                      </a>
                      <ModePill mode={run.mode} />
                    </span>
                  </td>
                  <td>{run.task}</td>
                  <td className="mono runs-model">{run.model}</td>
                  <td className="num-col">{run.seed}</td>
                  <td className="num-col">{run.agents}</td>
                  <td className="num-col">
                    {run.latest_tick}
                    <span className="faint"> / {run.tick_cap}</span>
                  </td>
                  <td className="num-col">{run.posts}</td>
                  <td className="num-col">{run.deliverable_versions}</td>
                  <td className="num-col">
                    <RunCost usd={run.cost_usd} mode={run.mode} />
                  </td>
                  <td className="runs-started" title={new Date(run.started_at).toLocaleString()}>
                    {formatRelative(run.started_at, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
