import type { RunState } from "../../shared/runstate.ts";
import { IconLive, IconPause, IconPlay, IconStepBack, IconStepForward } from "../icons.tsx";
import { ActivityStrip, ActivityLegend } from "./ActivityStrip.tsx";
import "./Transport.css";

export type PlaybackSpeed = 1 | 2 | 4 | 8;
export const PLAYBACK_SPEEDS: readonly PlaybackSpeed[] = [1, 2, 4, 8];

export interface TransportProps {
  state: RunState;
  running: boolean;
  following: boolean;
  playing: boolean;
  speed: PlaybackSpeed;
  onTogglePlay(): void;
  onSpeed(speed: PlaybackSpeed): void;
  onTick(tick: number): void;
  onLive(): void;
}

/** Play/pause, speed, stepping, the scrubber with its activity strip, and the live toggle. */
export function Transport({
  state,
  running,
  following,
  playing,
  speed,
  onTogglePlay,
  onSpeed,
  onTick,
  onLive,
}: TransportProps) {
  const { tick, latest_tick: latest, tick_cap: cap } = state;
  const inProgress = running && tick === latest && latest > 0;

  return (
    <div className="transport">
      <div className="transport-controls">
        <button
          type="button"
          className="icon-btn"
          aria-label="Previous step"
          title="Previous step (←, Shift+← for 5)"
          disabled={tick <= 0}
          onClick={() => onTick(tick - 1)}
        >
          <IconStepBack size={13} />
        </button>
        <button
          type="button"
          className="icon-btn transport-play"
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          disabled={latest === 0}
          onClick={onTogglePlay}
        >
          {playing ? <IconPause size={13} /> : <IconPlay size={13} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Next step"
          title="Next step (→, Shift+→ for 5)"
          disabled={tick >= latest}
          onClick={() => onTick(tick + 1)}
        >
          <IconStepForward size={13} />
        </button>
        <div className="transport-speed" role="group" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === speed}
              title={`${option} step${option === 1 ? "" : "s"} per second`}
              onClick={() => onSpeed(option)}
            >
              {option}×
            </button>
          ))}
        </div>
      </div>

      <div className="transport-track">
        <input
          type="range"
          className="transport-range"
          min={0}
          max={latest}
          step={1}
          value={tick}
          disabled={latest === 0}
          aria-label="Selected step"
          aria-valuetext={`step ${tick} of ${latest}`}
          onChange={(event) => onTick(Number(event.currentTarget.value))}
        />
        <ActivityStrip state={state} onTick={onTick} />
      </div>

      <div className="transport-position">
        <span className="transport-step num" title={latest < cap ? `Latest step logged: ${latest}` : undefined}>
          step <strong>{tick}</strong>
          <span className="faint"> / {cap}</span>
        </span>
        {inProgress ? (
          <span className="transport-note" title="The newest step is still being logged">
            in progress
          </span>
        ) : tick < latest ? (
          <span className="transport-note faint">latest {latest}</span>
        ) : null}
      </div>

      <ActivityLegend state={state} />

      {running && (
        <button
          type="button"
          className="btn transport-live"
          aria-pressed={following}
          title={following ? "Following the newest step" : "Jump to the newest step and follow it (L)"}
          onClick={onLive}
        >
          <IconLive size={13} />
          Live
        </button>
      )}
    </div>
  );
}
