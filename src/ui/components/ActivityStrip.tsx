import type { MouseEvent } from "react";
import { formatUsd } from "../../shared/derive.ts";
import type { RunState, TickActivity } from "../../shared/runstate.ts";
import "./ActivityStrip.css";

const SEGMENTS = [
  { key: "posts", label: "posts", one: "post" },
  { key: "doc_opens", label: "first opens", one: "first open" },
  { key: "writes", label: "writes", one: "write" },
] as const;

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describe(bucket: TickActivity): string {
  return [
    `Step ${bucket.tick}`,
    count(bucket.posts, "post", "posts"),
    count(bucket.doc_opens, "first document open", "first document opens"),
    count(bucket.writes, "deliverable write", "deliverable writes"),
    `${count(bucket.calls, "call", "calls")} of ${bucket.active} active`,
    formatUsd(bucket.cost_usd),
  ].join(" · ");
}

/**
 * One stacked bar per tick (posts, first document opens, deliverable writes), aligned under the
 * scrubber: the strip is inset by half the range thumb, so tick t sits at t / latest_tick of the width.
 * Bars after the selected tick are dimmed. Clicking sets the tick. The range input above it is the
 * accessible control, so the strip is hidden from assistive technology.
 */
export function ActivityStrip({ state, onTick }: { state: RunState; onTick(tick: number): void }) {
  const max = state.latest_tick;
  const peak = Math.max(1, ...state.activity.map((bucket) => bucket.posts + bucket.doc_opens + bucket.writes));

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (max === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
    onTick(Math.min(Math.max(Math.round(ratio * max), 0), max));
  };

  return (
    <div className="strip" aria-hidden="true">
      <div className="strip-inner" onClick={onClick}>
        <div className="strip-baseline" />
        {max > 0 &&
          state.activity.map((bucket) => {
            const total = bucket.posts + bucket.doc_opens + bucket.writes;
            const classes = ["strip-slot"];
            if (bucket.tick > state.tick) classes.push("future");
            if (bucket.tick === state.tick) classes.push("selected");
            return (
              <div
                key={bucket.tick}
                className={classes.join(" ")}
                style={{ left: `${(bucket.tick / max) * 100}%`, width: `min(${100 / max}%, 16px)` }}
                title={describe(bucket)}
              >
                <div className="strip-bar" style={{ height: `${(total / peak) * 100}%` }}>
                  {SEGMENTS.map(({ key }) =>
                    bucket[key] > 0 ? (
                      <span key={key} className={`strip-seg strip-seg-${key}`} style={{ flexGrow: bucket[key] }} />
                    ) : null,
                  )}
                </div>
              </div>
            );
          })}
        {max > 0 && <div className="strip-marker" style={{ left: `${(state.tick / max) * 100}%` }} />}
      </div>
    </div>
  );
}

/** The strip's legend, with each series' count at the selected tick. */
export function ActivityLegend({ state }: { state: RunState }) {
  const bucket = state.activity[state.tick - 1];
  return (
    <div className="strip-legend" title={`Activity at step ${state.tick}`}>
      {SEGMENTS.map(({ key, label, one }) => {
        const n = bucket ? bucket[key] : 0;
        return (
          <span key={key} className="strip-legend-item">
            <span className={`strip-swatch strip-seg-${key}`} aria-hidden="true" />
            <span className="num">{n}</span> {n === 1 ? one : label}
          </span>
        );
      })}
    </div>
  );
}
