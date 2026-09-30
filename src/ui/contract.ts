import type { RunEvent } from "../shared/events.ts";
import type { RunState } from "../shared/runstate.ts";

/** What the inspector shows and what views highlight. Encoded in the URL so reloads keep it. */
export type Selection =
  | { kind: "none" }
  | { kind: "step"; agent: string; tick: number }
  | { kind: "post"; id: number }
  | { kind: "doc"; id: string }
  | { kind: "version"; version: number }
  | { kind: "agent"; agent: string };

export const NO_SELECTION: Selection = { kind: "none" };

export const CENTER_TABS = [
  "timeline",
  "transcript",
  "deliverable",
  "coverage",
  "documents",
  "summary",
] as const;
export type CenterTab = (typeof CENTER_TABS)[number];

/** Props every run-view panel receives. */
export interface ViewProps {
  runId: string;
  /** The full event log loaded so far (not cut at the selected tick). */
  events: readonly RunEvent[];
  /** Derived state as of the selected tick. */
  state: RunState;
  selection: Selection;
  select(selection: Selection): void;
  setTick(tick: number): void;
  openTab(tab: CenterTab): void;
  /** The agent whose transcript is shown (transcript tab); null means the first agent. */
  transcriptAgent: string | null;
  setTranscriptAgent(agent: string): void;
}

/** A search hit; picking it selects `selection`, moving the scrubber to `tick` when that is later (pickHitPatch). */
export interface SearchHit {
  kind: "post" | "agent_text" | "reasoning" | "tool_result" | "deliverable";
  label: string;
  /** The agent it belongs to (post author, step agent, version author). */
  agent: string;
  snippet: string;
  tick: number;
  selection: Selection;
}
