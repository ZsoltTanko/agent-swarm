/**
 * Hash routes and the run view's URL state. Pure, so reloads and shared links restore a view exactly.
 *
 *   #/                                          the runs list
 *   #/run/<id>?t=<tick|live>&tab=<tab>&sel=<selection>&agent=<name>&authors=<name>,<name>&dv=changes
 *
 * Selections are encoded as step:<agent>@<tick>, post:<id>, doc:<docId>, version:<n>, agent:<name>.
 * `authors` is the board's author filter; `dv` is what the deliverable view shows (its text, or its changes).
 * Parameters at their default (no t, the timeline tab, no selection, no agent, every author, the text) are
 * left out.
 */
import { CENTER_TABS, NO_SELECTION, type CenterTab, type Selection } from "./contract.ts";

/** A fixed tick, following live ("live"), or unspecified (null: live while running, else the last tick). */
export type TickParam = number | "live" | null;

/** What the deliverable view shows for a version: its text, or its changes from the version it replaced. */
export type DeliverableMode = "text" | "changes";

export interface RunViewParams {
  tick: TickParam;
  tab: CenterTab;
  selection: Selection;
  /** The agent whose transcript is shown; null means the first agent. */
  agent: string | null;
  /** The authors whose posts the board shows; empty means every author. */
  authors: readonly string[];
  deliverableMode: DeliverableMode;
}

export type Route = { page: "runs" } | { page: "run"; runId: string; params: RunViewParams };

/** A change to the run view's parameters: a patch, or a function of the current ones returning one. */
export type ParamsUpdate = Partial<RunViewParams> | ((current: RunViewParams) => Partial<RunViewParams>);

export const DEFAULT_TAB: CenterTab = "timeline";

export const DEFAULT_RUN_PARAMS: RunViewParams = {
  tick: null,
  tab: DEFAULT_TAB,
  selection: NO_SELECTION,
  agent: null,
  authors: [],
  deliverableMode: "text",
};

const DIGITS = /^\d+$/;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** encodeURIComponent, keeping ":" and "@" (both legal in a fragment) readable. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%40/g, "@");
}

export function encodeSelection(selection: Selection): string | null {
  switch (selection.kind) {
    case "none":
      return null;
    case "step":
      return `step:${selection.agent}@${selection.tick}`;
    case "post":
      return `post:${selection.id}`;
    case "doc":
      return `doc:${selection.id}`;
    case "version":
      return `version:${selection.version}`;
    case "agent":
      return `agent:${selection.agent}`;
  }
}

/** The selection a `sel` value encodes; NO_SELECTION for anything malformed. */
export function decodeSelection(value: string | null | undefined): Selection {
  if (!value) return NO_SELECTION;
  const colon = value.indexOf(":");
  if (colon < 0) return NO_SELECTION;
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  switch (kind) {
    case "step": {
      const at = rest.lastIndexOf("@");
      if (at <= 0) return NO_SELECTION;
      const tick = rest.slice(at + 1);
      if (!DIGITS.test(tick)) return NO_SELECTION;
      return { kind: "step", agent: rest.slice(0, at), tick: Number(tick) };
    }
    case "post":
      return DIGITS.test(rest) && Number(rest) > 0 ? { kind: "post", id: Number(rest) } : NO_SELECTION;
    case "doc":
      return rest ? { kind: "doc", id: rest } : NO_SELECTION;
    case "version":
      return DIGITS.test(rest) && Number(rest) > 0 ? { kind: "version", version: Number(rest) } : NO_SELECTION;
    case "agent":
      return rest ? { kind: "agent", agent: rest } : NO_SELECTION;
    default:
      return NO_SELECTION;
  }
}

/** Query values by name, still percent-encoded (a list splits before decoding); the first occurrence wins. */
function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = safeDecode(eq < 0 ? part : part.slice(0, eq));
    if (key !== null && !params.has(key)) params.set(key, eq < 0 ? "" : part.slice(eq + 1));
  }
  return params;
}

function parseTick(value: string | undefined): TickParam {
  if (value === "live") return "live";
  if (value !== undefined && DIGITS.test(value)) return Number(value);
  return null;
}

function parseTab(value: string | undefined): CenterTab {
  return (CENTER_TABS as readonly string[]).includes(value ?? "") ? (value as CenterTab) : DEFAULT_TAB;
}

/** A comma-separated list of names, each percent-encoded; empty and malformed names are dropped, repeats merged. */
function parseNames(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const names = raw.split(",").map(safeDecode);
  return [...new Set(names.filter((name): name is string => name !== null && name !== ""))];
}

/** The route a location hash (with or without the leading "#") points at. Unknown paths go to the runs list. */
export function parseHash(hash: string): Route {
  const trimmed = hash.replace(/^#/, "").replace(/^\/+/, "");
  const q = trimmed.indexOf("?");
  const path = (q < 0 ? trimmed : trimmed.slice(0, q)).replace(/\/+$/, "");
  const query = q < 0 ? "" : trimmed.slice(q + 1);

  if (!path.startsWith("run/")) return { page: "runs" };
  const runId = safeDecode(path.slice("run/".length));
  if (!runId || runId.includes("/")) return { page: "runs" };

  const params = parseQuery(query);
  const get = (key: string): string | undefined => {
    const raw = params.get(key);
    return raw === undefined ? undefined : (safeDecode(raw) ?? undefined);
  };
  const agent = get("agent");
  return {
    page: "run",
    runId,
    params: {
      tick: parseTick(get("t")),
      tab: parseTab(get("tab")),
      selection: decodeSelection(get("sel")),
      agent: agent ? agent : null,
      authors: parseNames(params.get("authors")),
      deliverableMode: get("dv") === "changes" ? "changes" : "text",
    },
  };
}

/** The hash (with "#") for a route; parseHash(formatHash(r)) gives r back. */
export function formatHash(route: Route): string {
  if (route.page === "runs") return "#/";
  const { tick, tab, selection, agent, authors, deliverableMode } = route.params;
  const query: string[] = [];
  if (tick !== null) query.push(`t=${tick}`);
  if (tab !== DEFAULT_TAB) query.push(`tab=${tab}`);
  const sel = encodeSelection(selection);
  if (sel !== null) query.push(`sel=${encode(sel)}`);
  if (agent !== null) query.push(`agent=${encode(agent)}`);
  if (authors.length > 0) query.push(`authors=${authors.map(encode).join(",")}`);
  if (deliverableMode !== "text") query.push(`dv=${deliverableMode}`);
  return `#/run/${encodeURIComponent(route.runId)}${query.length > 0 ? `?${query.join("&")}` : ""}`;
}

/** The hash that opens a run with default parameters. */
export function runHref(runId: string, params: Partial<RunViewParams> = {}): string {
  return formatHash({ page: "run", runId, params: { ...DEFAULT_RUN_PARAMS, ...params } });
}

export function sameSelection(a: Selection, b: Selection): boolean {
  return encodeSelection(a) === encodeSelection(b);
}

/** The params patch that selects `selection`. Selecting a step or an agent also points the transcript at that agent. */
export function selectionPatch(selection: Selection): Partial<RunViewParams> {
  return selection.kind === "step" || selection.kind === "agent" ? { selection, agent: selection.agent } : { selection };
}

/**
 * The agent whose transcript is shown: the one picked for it, else (for a shared link without one) the
 * selected step's or agent's; null means the first agent.
 */
export function transcriptAgentOf(params: RunViewParams): string | null {
  const { agent, selection } = params;
  return agent ?? (selection.kind === "step" || selection.kind === "agent" ? selection.agent : null);
}
