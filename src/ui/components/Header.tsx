import type { RefObject } from "react";
import { formatTokens, formatUsd } from "../../shared/derive.ts";
import type { RunEvent } from "../../shared/events.ts";
import type { RunState } from "../../shared/runstate.ts";
import type { SearchHit } from "../contract.ts";
import { IconBack } from "../icons.tsx";
import { pinnedEndpoint } from "../useRun.ts";
import { Pill } from "./primitives.tsx";
import { ModePill, RunCost, StatusPill } from "./RunsList.tsx";
import { SearchBox } from "./SearchBox.tsx";
import "./Header.css";

export interface HeaderProps {
  runId: string;
  events: readonly RunEvent[];
  state: RunState;
  stale: boolean;
  streamError: string | null;
  /** The live stream dropped and the browser is reconnecting; new events may be late. */
  reconnecting: boolean;
  onRetryStream(): void;
  onPick(hit: SearchHit): void;
  searchRef: RefObject<HTMLInputElement | null>;
}

export function Header({
  runId,
  events,
  state,
  stale,
  streamError,
  reconnecting,
  onRetryStream,
  onPick,
  searchRef,
}: HeaderProps) {
  const { started, usage } = state;
  const model = started.config.agents.model.id;
  const endpoint = pinnedEndpoint(started.config);
  const status = state.ended ? "ended" : stale ? "stale" : "running";
  const runCost = state.activity.reduce((sum, bucket) => sum + bucket.cost_usd, 0);

  return (
    <header className="run-header">
      <a className="btn run-header-back" href="#/" title="Back to the runs list">
        <IconBack size={13} />
        Runs
      </a>

      <div className="run-header-ident">
        <span className="run-header-id mono" title="Run id">
          {runId}
        </span>
        <span className="run-header-task" title="Task">
          {started.task.name}
        </span>
      </div>

      <div className="run-header-meta">
        <span className="mono" title="Model">
          {model}
        </span>
        {endpoint && (
          <span className="run-header-endpoint mono" title="Pinned endpoint (provider.order[0])">
            {endpoint}
          </span>
        )}
        <span className="num" title="Seed">
          seed {started.seed}
        </span>
      </div>

      {/* The end reason is a fact about the run's last step, so it shows only once that step is reached. */}
      <StatusPill
        status={status}
        endReason={state.ended && state.tick >= state.ended.tick ? state.ended.reason : null}
      />
      <ModePill mode={started.mode} />
      {reconnecting && !streamError && (
        <span role="status">
          <Pill tone="warning" title="The connection to the observer server dropped; the browser keeps retrying">
            reconnecting…
          </Pill>
        </span>
      )}
      {streamError && (
        <span className="run-header-stream" role="alert">
          <Pill tone="danger" title={streamError}>
            live updates lost
          </Pill>
          <button type="button" className="link-btn" onClick={onRetryStream}>
            Reconnect
          </button>
        </span>
      )}

      <div className="run-header-search">
        <SearchBox events={events} state={state} onPick={onPick} inputRef={searchRef} />
      </div>

      <div
        className="run-header-totals num"
        title={`Up to step ${state.tick}: ${usage.prompt_tokens.toLocaleString()} prompt tokens (${usage.cached_tokens.toLocaleString()} cached), ${usage.completion_tokens.toLocaleString()} completion tokens (${usage.reasoning_tokens.toLocaleString()} reasoning). Whole run so far: ${formatUsd(runCost)}${started.mode === "scripted" ? ", simulated" : ""}.`}
      >
        <span>
          <span className="faint">in </span>
          {formatTokens(usage.prompt_tokens)}
        </span>
        <span>
          <span className="faint">out </span>
          {formatTokens(usage.completion_tokens)}
        </span>
        <span className="run-header-cost">
          <RunCost usd={usage.cost_usd} mode={started.mode} />
        </span>
      </div>
    </header>
  );
}
