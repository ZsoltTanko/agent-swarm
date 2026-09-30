import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { RunEvent } from "../../shared/events.ts";
import type { RunState } from "../../shared/runstate.ts";
import type { SearchHit } from "../contract.ts";
import { IconSearch } from "../icons.tsx";
import {
  buildSearchIndex,
  SEARCH_KIND_LABELS,
  SEARCH_KINDS,
  SEARCH_LIMIT,
  searchIndex,
  type SearchResult,
} from "../search.ts";
import { formatInt } from "../transcript.ts";
import { AgentDot } from "./primitives.tsx";
import "./SearchBox.css";

const DEBOUNCE_MS = 150;

export interface SearchBoxProps {
  events: readonly RunEvent[];
  state: RunState;
  onPick(hit: SearchHit): void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function SearchBox({ events, state, onPick, inputRef }: SearchBoxProps) {
  const ownRef = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownRef;
  const baseId = useId();
  const listId = `${baseId}-results`;
  const optionId = (i: number) => `${baseId}-hit-${i}`;

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searching = open && debounced.trim() !== "";
  // Built only while a search is showing; rebuilt when the tick or the log changes.
  const index = useMemo(() => (searching ? buildSearchIndex(events, state) : null), [searching, events, state]);
  const outcome = useMemo(() => (index ? searchIndex(index, debounced) : null), [index, debounced]);
  const hits = outcome?.hits ?? [];

  useEffect(() => setActive(0), [debounced]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const agentIndex = useMemo(() => new Map(state.agents.map((agent) => [agent.info.name, agent.info.index])), [state.agents]);

  const pick = (hit: SearchResult) => {
    setOpen(false);
    onPick(hit);
    input.current?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        if (hits.length > 0) setActive((i) => Math.min(i + 1, hits.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (hits.length > 0) setActive((i) => Math.max(i - 1, 0));
        break;
      case "Enter": {
        const hit = hits[active];
        if (open && hit) {
          event.preventDefault();
          pick(hit);
        }
        break;
      }
      case "Escape":
        // First Esc closes the results (handled here); the next one is left to the page, which blurs.
        if (open && query.trim() !== "") {
          event.preventDefault();
          setOpen(false);
        }
        break;
    }
  };

  const showPopover = open && query.trim() !== "";
  const pending = query !== debounced || (searching && outcome === null);
  let offset = 0;
  const groups = SEARCH_KINDS.map((kind) => {
    const groupHits = hits.filter((hit) => hit.kind === kind);
    const start = offset;
    offset += groupHits.length;
    return { kind, hits: groupHits, start };
  }).filter((group) => group.hits.length > 0);

  return (
    <div
      className="sb-root"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label className="sb-field">
        <IconSearch size={13} />
        <input
          ref={input}
          type="search"
          className="sb-input"
          placeholder="Search posts, text, reasoning, versions"
          aria-label="Search the run up to the selected step"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showPopover}
          aria-controls={listId}
          aria-activedescendant={showPopover && hits[active] ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query === "" && <kbd className="sb-kbd" aria-hidden="true">/</kbd>}
      </label>
      {showPopover && (
        <div className="sb-popover">
          <div className="sb-status" role="status">
            {pending && hits.length === 0
              ? "Searching…"
              : outcome && outcome.total === 0
                ? `No matches up to step ${state.tick}.`
                : outcome && outcome.total > hits.length
                  ? `First ${SEARCH_LIMIT} of ${formatInt(outcome.total)} matches up to step ${state.tick}`
                  : `${formatInt(hits.length)} ${hits.length === 1 ? "match" : "matches"} up to step ${state.tick}`}
          </div>
          <div id={listId} role="listbox" aria-label="Search results" className="sb-list">
            {groups.map((group) => (
              <div key={group.kind} role="group" aria-labelledby={`${listId}-${group.kind}`} className="sb-group">
                <div id={`${listId}-${group.kind}`} className="sb-group-label">
                  {SEARCH_KIND_LABELS[group.kind]} · {group.hits.length}
                </div>
                {group.hits.map((hit, i) => {
                  const position = group.start + i;
                  return (
                    <div
                      key={position}
                      id={optionId(position)}
                      role="option"
                      aria-selected={position === active}
                      className={`sb-hit${position === active ? " is-active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActive(position)}
                      onClick={() => pick(hit)}
                    >
                      <div className="sb-hit-label">
                        <AgentDot index={agentIndex.get(hit.agent) ?? 0} />
                        {hit.label}
                      </div>
                      <div className="sb-snippet">
                        {hit.snippet.slice(0, hit.match.start)}
                        <mark>{hit.snippet.slice(hit.match.start, hit.match.end)}</mark>
                        {hit.snippet.slice(hit.match.end)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
