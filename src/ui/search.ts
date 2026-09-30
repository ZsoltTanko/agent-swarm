import type { RunEvent } from "../shared/events.ts";
import type { RunState } from "../shared/runstate.ts";
import type { SearchHit } from "./contract.ts";
import { reasoningOf, splitStatusLine } from "./transcript.ts";
import type { RunViewParams } from "./url.ts";

export type SearchKind = SearchHit["kind"];

/** Group order in results, and the order in which the hit cap cuts: tool results go first. */
export const SEARCH_KINDS: readonly SearchKind[] = ["post", "deliverable", "agent_text", "reasoning", "tool_result"];

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  post: "Posts",
  deliverable: "Deliverable versions",
  agent_text: "Agent text",
  reasoning: "Reasoning",
  tool_result: "Tool results",
};

export const SEARCH_LIMIT = 60;

/**
 * Tools whose successful results only repeat text that is indexed elsewhere, or document bodies, or (wait)
 * are one fixed acknowledgment that would match every search for its words.
 */
const UNINDEXED_TOOLS = new Set(["read_document", "read_board", "read_deliverable", "wait"]);

/** One searchable text. */
export interface SearchEntry {
  kind: SearchKind;
  label: string;
  /** The agent it belongs to (post author, step agent, version author). */
  agent: string;
  text: string;
  tick: number;
  selection: SearchHit["selection"];
}

export interface SearchResult extends SearchHit {
  /** Offsets of the match within `snippet`. */
  match: { start: number; end: number };
}

export interface SearchOutcome {
  hits: SearchResult[];
  /** Matching entries before the cap. */
  total: number;
}

/**
 * Everything searchable as of state.tick: posts, assistant content and reasoning, tool results (not
 * the bodies that reads return or wait's acknowledgment, and without the status line), and deliverable versions. Entries are grouped by kind
 * in SEARCH_KINDS order, chronological within a kind.
 */
export function buildSearchIndex(
  events: readonly RunEvent[],
  state: Pick<RunState, "tick" | "posts" | "deliverable">,
): SearchEntry[] {
  const byKind: Record<SearchKind, SearchEntry[]> = {
    post: [],
    deliverable: [],
    agent_text: [],
    reasoning: [],
    tool_result: [],
  };

  for (const post of state.posts) {
    byKind.post.push({
      kind: "post",
      label: `Post #${post.id} · ${post.author} · step ${post.tick}`,
      agent: post.author,
      text: post.text,
      tick: post.tick,
      selection: { kind: "post", id: post.id },
    });
  }

  for (const version of state.deliverable) {
    byKind.deliverable.push({
      kind: "deliverable",
      label: `v${version.version} · ${version.author} · step ${version.tick}`,
      agent: version.author,
      text: version.text,
      tick: version.tick,
      selection: { kind: "version", version: version.version },
    });
  }

  for (const event of events) {
    if (event.tick > state.tick) break;
    if (event.type === "model_call") {
      const selection = { kind: "step", agent: event.agent, tick: event.tick } as const;
      const content = event.message.content;
      if (typeof content === "string" && content.trim() !== "") {
        byKind.agent_text.push({
          kind: "agent_text",
          label: `${event.agent} · step ${event.tick}`,
          agent: event.agent,
          text: content,
          tick: event.tick,
          selection,
        });
      }
      const reasoning = reasoningOf(event.message).text;
      if (reasoning !== null && reasoning.trim() !== "") {
        byKind.reasoning.push({
          kind: "reasoning",
          label: `${event.agent} · step ${event.tick} · reasoning`,
          agent: event.agent,
          text: reasoning,
          tick: event.tick,
          selection,
        });
      }
    } else if (event.type === "tool_call") {
      // Successful reads echo documents, posts, and deliverable versions; posts and versions are
      // indexed on their own, so their echoes would only repeat those hits.
      if (event.error === null && UNINDEXED_TOOLS.has(event.name)) continue;
      const body = splitStatusLine(event.result).body;
      if (body.trim() === "") continue;
      byKind.tool_result.push({
        kind: "tool_result",
        label: `${event.agent} · step ${event.tick} · ${event.name} result`,
        agent: event.agent,
        text: body,
        tick: event.tick,
        selection: { kind: "step", agent: event.agent, tick: event.tick },
      });
    }
  }

  return SEARCH_KINDS.flatMap((kind) => byKind[kind]);
}

/**
 * The run view's params patch for picking a hit at the selected tick: select the hit and open the view it
 * belongs to. The scrubber moves forward to a later hit; an earlier hit keeps the selected tick, so what
 * happened since stays in view. Either way the tick is pinned, so a view following live stops following.
 * A post whose author the board's filter (`authors`) hides clears the filter, so the picked post shows.
 */
export function pickHitPatch(hit: SearchHit, tick: number, authors: readonly string[]): Partial<RunViewParams> {
  const patch: Partial<RunViewParams> = { tick: Math.max(hit.tick, tick), selection: hit.selection };
  if (hit.kind === "post" && authors.length > 0 && !authors.includes(hit.agent)) patch.authors = [];
  if (hit.kind === "deliverable") patch.tab = "deliverable";
  if (hit.kind === "agent_text" || hit.kind === "reasoning" || hit.kind === "tool_result") {
    patch.tab = "transcript";
    if (hit.selection.kind === "step" || hit.selection.kind === "agent") patch.agent = hit.selection.agent;
  }
  return patch;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive substring search, one hit per entry (at its first match), at most `limit` hits. */
export function searchIndex(index: readonly SearchEntry[], query: string, limit = SEARCH_LIMIT): SearchOutcome {
  const needle = query.trim();
  if (needle === "") return { hits: [], total: 0 };
  // A case-insensitive regex keeps offsets in the original text, which toLowerCase() may not.
  const pattern = new RegExp(escapeRegExp(needle), "iu");
  const hits: SearchResult[] = [];
  let total = 0;
  for (const entry of index) {
    const match = pattern.exec(entry.text);
    if (!match) continue;
    total++;
    if (hits.length >= limit) continue;
    const { snippet, start, end } = makeSnippet(entry.text, match.index, match.index + match[0].length);
    hits.push({
      kind: entry.kind,
      label: entry.label,
      agent: entry.agent,
      snippet,
      tick: entry.tick,
      selection: entry.selection,
      match: { start, end },
    });
  }
  return { hits, total };
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * A one-line excerpt around text[start, end), whitespace collapsed, with "…" where it was cut.
 * Returns the match's offsets within the excerpt.
 */
export function makeSnippet(
  text: string,
  start: number,
  end: number,
  before = 48,
  after = 110,
): { snippet: string; start: number; end: number } {
  // Cut at word boundaries where the window allows it.
  let from = Math.max(0, start - before);
  if (from > 0) {
    const space = text.slice(from, start).search(/\s/);
    if (space >= 0) from += space + 1;
  }
  let to = Math.min(text.length, end + after);
  if (to < text.length) {
    const space = text.slice(end, to).search(/\s\S*$/);
    if (space > 0) to = end + space;
  }
  const head = (from > 0 ? "…" : "") + collapseWhitespace(text.slice(from, start)).trimStart();
  const match = collapseWhitespace(text.slice(start, end));
  const tail = collapseWhitespace(text.slice(end, to)).trimEnd() + (to < text.length ? "…" : "");
  return { snippet: head + match + tail, start: head.length, end: head.length + match.length };
}
