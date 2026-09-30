/** Comparing a run's event log with the log of its exact re-run. Browser-safe: no Node imports. */
import type { RunEvent } from "./events.ts";

/** Top-level fields of any event that legitimately differ between a run and its exact re-run. */
const RUN_SPECIFIC_FIELDS = ["at", "latency_ms", "cache_hit", "run_id"];

/**
 * Nested paths, by event type, that legitimately differ: cache-hit counts, the catalog lookup (skipped
 * by offline re-runs), the mode (a live run re-runs offline), and the resolved config's paths into the
 * run's own folder.
 */
const RUN_SPECIFIC_PATHS: Partial<Record<RunEvent["type"], string[][]>> = {
  run_started: [["mode"], ["model_info"], ["config", "task"], ["config", "environment", "prompt_template"]],
  run_ended: [["totals", "cache_hits"]],
};

export interface EventDifference {
  /** Seq of the first event that differs (or that only one log has). */
  seq: number;
  /** Where in that event, e.g. "message.tool_calls[0].function.arguments"; "" for the whole event. */
  path: string;
  a: unknown;
  b: unknown;
}

/** Deep copies of the events with everything that legitimately differs between a run and its exact re-run removed. */
export function normalizeForComparison(events: readonly RunEvent[]): Record<string, unknown>[] {
  return events.map((event) => {
    const copy = structuredClone(event) as unknown as Record<string, unknown>;
    for (const field of RUN_SPECIFIC_FIELDS) delete copy[field];
    for (const path of RUN_SPECIFIC_PATHS[event.type] ?? []) deleteAt(copy, path);
    return copy;
  });
}

/** The first difference between two event logs after normalizeForComparison, or null when they match. */
export function firstDifference(a: readonly RunEvent[], b: readonly RunEvent[]): EventDifference | null {
  const left = normalizeForComparison(a);
  const right = normalizeForComparison(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const seq = a[index]?.seq ?? b[index]?.seq ?? index;
    const difference = differenceAt(left[index], right[index], "");
    if (difference !== null) return { seq, ...difference };
  }
  return null;
}

function differenceAt(a: unknown, b: unknown, path: string): { path: string; a: unknown; b: unknown } | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = differenceAt(a[index], b[index], `${path}[${index}]`);
      if (difference !== null) return difference;
    }
    return null;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = [...Object.keys(a), ...Object.keys(b).filter((key) => !Object.hasOwn(a, key))];
    for (const key of keys) {
      const difference = differenceAt(a[key], b[key], path === "" ? key : `${path}.${key}`);
      if (difference !== null) return difference;
    }
    return null;
  }
  return { path, a, b };
}

function deleteAt(value: Record<string, unknown>, path: string[]): void {
  let current: unknown = value;
  for (const key of path.slice(0, -1)) {
    if (!isRecord(current)) return;
    current = current[key];
  }
  if (isRecord(current)) delete current[path.at(-1)!];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
