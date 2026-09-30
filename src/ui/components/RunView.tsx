import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { deriveRunState } from "../../shared/derive.ts";
import type { RunState } from "../../shared/runstate.ts";
import { CENTER_TABS, NO_SELECTION, type CenterTab, type SearchHit, type Selection, type ViewProps } from "../contract.ts";
import { IconBack } from "../icons.tsx";
import { commandForKey, cycleIndex, isTextEntry, targetHandlesKey, type KeyCommand } from "../keyboard.ts";
import { pickHitPatch } from "../search.ts";
import {
  selectionPatch,
  transcriptAgentOf,
  type DeliverableMode,
  type ParamsUpdate,
  type RunViewParams,
} from "../url.ts";
import {
  endedEventOf,
  indexLog,
  isStale,
  latestTickOf,
  neighborStepTick,
  resolveTick,
  useNow,
  useRun,
  type RunData,
} from "../useRun.ts";
import { Board } from "./Board.tsx";
import { Coverage } from "./Coverage.tsx";
import { DeliverableView } from "./DeliverableView.tsx";
import { Documents } from "./Documents.tsx";
import { Header } from "./Header.tsx";
import { Inspector } from "./Inspector.tsx";
import { Summary } from "./Summary.tsx";
import { Timeline } from "./Timeline.tsx";
import { Transcript } from "./Transcript.tsx";
import { Transport, type PlaybackSpeed } from "./Transport.tsx";
import "./RunView.css";

export interface RunViewProps {
  runId: string;
  params: RunViewParams;
  setParams(update: ParamsUpdate): void;
}

/** A run: loading and error states, then the full observer layout. */
export function RunView(props: RunViewProps) {
  const run = useRun(props.runId);
  if (run.phase === "ready") return <LoadedRun {...props} run={run} />;

  return (
    <div className="run-view">
      <div className="run-pending-bar">
        <a className="btn" href="#/">
          <IconBack size={13} />
          Runs
        </a>
        <span className="mono">{props.runId}</span>
      </div>
      {run.phase === "loading" && (
        <div className="page-state" role="status">
          Loading the event log…
        </div>
      )}
      {run.phase === "waiting" && (
        <div className="page-state" role="status">
          This run hasn't logged its start yet; waiting for events.
        </div>
      )}
      {run.phase === "error" && (
        <div className="page-state error" role="alert">
          <div>Couldn't load this run: {run.error}</div>
          <button type="button" className="btn" onClick={run.retry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

const TAB_LABELS: Record<CenterTab, string> = {
  timeline: "Timeline",
  transcript: "Transcript",
  deliverable: "Deliverable",
  coverage: "Coverage",
  documents: "Documents",
  summary: "Summary",
};

function tabDetail(tab: CenterTab, state: RunState, transcriptAgent: string | null): string | null {
  switch (tab) {
    case "timeline":
      return null;
    case "transcript":
      return transcriptAgent ?? state.agents[0]?.info.name ?? null;
    case "deliverable":
      return state.deliverable.length > 0 ? `v${state.deliverable.length}` : null;
    case "coverage":
      return `${state.metrics.coverage.opened}/${state.metrics.coverage.total}`;
    case "documents":
      return null;
    case "summary":
      return null;
  }
}

const TAB_TITLES: Record<CenterTab, (detail: string | null) => string> = {
  timeline: () => "Agents × steps",
  transcript: (detail) => `Transcript of ${detail}`,
  deliverable: (detail) => (detail === null ? "Deliverable: no versions yet" : `Deliverable: latest ${detail}`),
  coverage: (detail) => `Coverage: ${detail} documents opened`,
  documents: () => "The task's documents",
  summary: () => "Summary metrics",
};

function LoadedRun({ runId, params, setParams, run }: RunViewProps & { run: RunData }) {
  const { events } = run;
  const latestTick = latestTickOf(events);
  const running = endedEventOf(events) === null;
  const { tick, following } = resolveTick(params.tick, latestTick, running);

  // deriveRunState is one pass over the log; memoized on (events, tick) so it runs once per scrub or batch.
  const state = useMemo(() => deriveRunState(events, tick), [events, tick]);
  const logIndex = useMemo(() => indexLog(events), [events]);
  // Only a run that hasn't ended can go stale.
  const now = useNow(running ? 30_000 : null);
  const stale = running && isStale(events, now);

  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(2);
  const searchRef = useRef<HTMLInputElement>(null);

  const latestRef = useRef(latestTick);
  latestRef.current = latestTick;

  const setTick = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(Math.round(next), 0), latestRef.current);
      setParams({ tick: clamped });
    },
    [setParams],
  );
  const followLive = useCallback(() => {
    setPlaying(false);
    setParams({ tick: "live" });
  }, [setParams]);
  const select = useCallback((selection: Selection) => setParams(selectionPatch(selection)), [setParams]);
  const openTab = useCallback((tab: CenterTab) => setParams({ tab }), [setParams]);
  const setTranscriptAgent = useCallback((agent: string) => setParams({ agent }), [setParams]);
  const setAuthors = useCallback((authors: readonly string[]) => setParams({ authors }), [setParams]);
  const setDeliverableMode = useCallback(
    (deliverableMode: DeliverableMode) => setParams({ deliverableMode }),
    [setParams],
  );

  const transcriptAgent = transcriptAgentOf(params);

  const viewProps: ViewProps = useMemo(
    () => ({
      runId,
      events,
      state,
      selection: params.selection,
      select,
      setTick,
      openTab,
      transcriptAgent,
      setTranscriptAgent,
    }),
    [runId, events, state, params.selection, transcriptAgent, select, setTick, openTab, setTranscriptAgent],
  );

  // Playback: one tick per 1/speed seconds. Reaching the newest tick stops, or follows live while running.
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      const next = tick + 1;
      if (next >= latestTick) {
        setPlaying(false);
        setParams({ tick: running ? "live" : latestTick });
      } else {
        setParams({ tick: next });
      }
    }, 1000 / speed);
    return () => clearTimeout(timer);
  }, [playing, tick, speed, latestTick, running, setParams]);

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (tick >= latestTick) setParams({ tick: 0 });
    setPlaying(true);
  }, [playing, tick, latestTick, setParams]);

  const onPick = useCallback(
    (hit: SearchHit) => {
      setPlaying(false);
      setParams(pickHitPatch(hit, tick, params.authors));
    },
    [tick, params.authors, setParams],
  );

  /** j / k: the selected agent's next or previous step, moving the tick forward when that step is later. */
  const moveStep = (delta: 1 | -1) => {
    const selection = params.selection;
    const agent =
      selection.kind === "step" || selection.kind === "agent"
        ? selection.agent
        : (transcriptAgent ?? state.agents[0]?.info.name ?? null);
    if (agent === null) return;
    // Without a selected step, start at the agent's latest step up to the selected tick (or its first step).
    const target =
      selection.kind === "step"
        ? neighborStepTick(logIndex, agent, selection.tick, delta)
        : (neighborStepTick(logIndex, agent, tick + 1, -1) ?? neighborStepTick(logIndex, agent, tick, 1));
    if (target === null) return;
    const patch: Partial<RunViewParams> = { selection: { kind: "step", agent, tick: target }, agent };
    if (target > tick) patch.tick = target;
    setParams(patch);
  };

  const runCommand = (command: KeyCommand) => {
    switch (command.kind) {
      case "tick-delta":
        setTick(tick + command.delta);
        break;
      case "tick-start":
        setTick(0);
        break;
      case "tick-end":
        setTick(latestTick);
        break;
      case "toggle-play":
        togglePlay();
        break;
      case "follow-live":
        if (running) followLive();
        else setTick(latestTick);
        break;
      case "cycle-tab": {
        const index = CENTER_TABS.indexOf(params.tab);
        openTab(CENTER_TABS[cycleIndex(index, command.delta, CENTER_TABS.length)] ?? "timeline");
        break;
      }
      case "agent": {
        const agent = state.agents[command.index]?.info.name;
        if (agent) setParams({ agent, tab: "transcript", selection: { kind: "agent", agent } });
        break;
      }
      case "step":
        moveStep(command.delta);
        break;
      case "escape":
        if (params.selection.kind !== "none") select(NO_SELECTION);
        break;
      case "focus-search":
        searchRef.current?.focus();
        searchRef.current?.select();
        break;
    }
  };
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;

  useEffect(() => {
    // Whether the focused element got focus from a pointer (a click) rather than the keyboard.
    let lastInput: "pointer" | "keyboard" = "keyboard";
    let focusedByPointer = false;
    const onPointerDown = () => {
      lastInput = "pointer";
    };
    // Capture phase, so it runs before any handler that moves focus in response to the key.
    const onKeyInput = () => {
      lastInput = "keyboard";
    };
    const onFocusIn = () => {
      focusedByPointer = lastInput === "pointer";
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? (event.target as HTMLElement) : null;
      if (target && isTextEntry(target)) {
        // Esc in the search box closes it, unless the search box handled Esc itself.
        if (event.key === "Escape" && !event.defaultPrevented && target === searchRef.current) target.blur();
        return;
      }
      if (event.defaultPrevented) return;
      const command = commandForKey(event);
      if (!command || targetHandlesKey(target, event.key, !focusedByPointer)) return;
      event.preventDefault();
      runCommandRef.current(command);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyInput, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyInput, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // The tab list's own keys (the ARIA tabs pattern): arrows move between tabs, Home and End to the ends.
  const onTabsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = CENTER_TABS.indexOf(params.tab);
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = cycleIndex(index, -1, CENTER_TABS.length);
    else if (event.key === "ArrowRight") next = cycleIndex(index, 1, CENTER_TABS.length);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = CENTER_TABS.length - 1;
    const tab = next === null ? undefined : CENTER_TABS[next];
    if (tab === undefined) return;
    event.preventDefault();
    openTab(tab);
    document.getElementById(`run-tab-${tab}`)?.focus();
  };

  useEffect(() => {
    document.getElementById(`run-tab-${params.tab}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [params.tab]);

  const tabContent = (() => {
    switch (params.tab) {
      case "timeline":
        return <Timeline {...viewProps} logIndex={logIndex} following={following} />;
      case "transcript":
        return <Transcript {...viewProps} />;
      case "deliverable":
        return <DeliverableView {...viewProps} mode={params.deliverableMode} setMode={setDeliverableMode} />;
      case "coverage":
        return <Coverage {...viewProps} />;
      case "documents":
        return <Documents {...viewProps} />;
      case "summary":
        return <Summary {...viewProps} />;
    }
  })();

  return (
    <div className="run-view">
      <Header
        runId={runId}
        events={events}
        state={state}
        stale={stale}
        streamError={run.streamError}
        reconnecting={run.reconnecting}
        onRetryStream={run.retry}
        onPick={onPick}
        searchRef={searchRef}
      />
      <Transport
        state={state}
        running={running}
        following={following}
        playing={playing}
        speed={speed}
        onTogglePlay={togglePlay}
        onSpeed={setSpeed}
        onTick={setTick}
        onLive={followLive}
      />
      <div className="run-body">
        <section className="panel run-board" aria-label="Board">
          <PanelBoundary name="board">
            <Board {...viewProps} following={following} authors={params.authors} setAuthors={setAuthors} />
          </PanelBoundary>
        </section>

        <section className="panel run-center" aria-label="Views">
          <div className="run-tabs" role="tablist" aria-label="Center views" onKeyDown={onTabsKeyDown}>
            {CENTER_TABS.map((tab) => {
              const detail = tabDetail(tab, state, transcriptAgent);
              const selected = tab === params.tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`run-tab-${tab}`}
                  aria-selected={selected}
                  aria-controls="run-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  className="run-tab"
                  title={`${TAB_TITLES[tab](detail)} ([ and ] switch tabs)`}
                  onClick={() => openTab(tab)}
                >
                  {TAB_LABELS[tab]}
                  {detail !== null && <span className="run-tab-detail">{detail}</span>}
                </button>
              );
            })}
          </div>
          <div className="run-tabpanel" id="run-tabpanel" role="tabpanel" aria-labelledby={`run-tab-${params.tab}`}>
            <PanelBoundary name={TAB_LABELS[params.tab].toLowerCase()} resetKey={params.tab}>
              {tabContent}
            </PanelBoundary>
          </div>
        </section>

        <aside className="panel run-inspector" aria-label="Inspector">
          <PanelBoundary name="inspector" resetKey={params.selection}>
            <Inspector {...viewProps} logIndex={logIndex} />
          </PanelBoundary>
        </aside>
      </div>
    </div>
  );
}

interface BoundaryProps {
  name: string;
  /** A change of this value clears a caught error. */
  resetKey?: unknown;
  children: ReactNode;
}

/** Keeps one failing panel from taking the whole run view down. */
class PanelBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidUpdate(previous: BoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="state-message error" role="alert">
        <p>
          The {this.props.name} view failed: {this.state.error.message}
        </p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
