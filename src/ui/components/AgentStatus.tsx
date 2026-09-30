import type { AgentStatus } from "../../shared/types.ts";
import { IconDone, IconSleep, IconStop } from "../icons.tsx";
import { Pill, type PillTone } from "./primitives.tsx";

const STATUS_TONES: Record<AgentStatus, PillTone> = {
  awake: "neutral",
  asleep: "neutral",
  done: "success",
  stopped: "warning",
};

/** An agent's status as a pill: "awake", "asleep", "done", or "stopped" (with its reason when given). */
export function AgentStatusPill({ status, reason = null }: { status: AgentStatus; reason?: string | null }) {
  return <Pill tone={STATUS_TONES[status]}>{status === "stopped" && reason ? `stopped: ${reason}` : status}</Pill>;
}

/** An icon for every status but awake, labelled with the status. */
export function AgentStatusIcon({ status, size = 12 }: { status: AgentStatus; size?: number }) {
  switch (status) {
    case "asleep":
      return <IconSleep size={size} title="asleep" />;
    case "done":
      return <IconDone size={size} title="done" />;
    case "stopped":
      return <IconStop size={size} title="stopped" />;
    case "awake":
      return null;
  }
}
