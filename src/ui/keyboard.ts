/**
 * Run view keyboard shortcuts, as a pure mapping from key events to commands.
 *
 *   ← / →          previous / next tick; with Shift, 5 ticks
 *   Home / End     first / last tick
 *   Space          play / pause
 *   L              follow live
 *   [ / ]          previous / next center tab
 *   1–9            open that agent's transcript
 *   j / k          next / previous step of the selected agent
 *   Esc            clear the selection
 *   /              focus search
 */

export type KeyCommand =
  | { kind: "tick-delta"; delta: number }
  | { kind: "tick-start" }
  | { kind: "tick-end" }
  | { kind: "toggle-play" }
  | { kind: "follow-live" }
  | { kind: "cycle-tab"; delta: 1 | -1 }
  | { kind: "agent"; index: number }
  | { kind: "step"; delta: 1 | -1 }
  | { kind: "escape" }
  | { kind: "focus-search" };

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The parts of an event target the handlers look at (an Element, or a stand-in in tests). */
export interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

export const SHIFT_TICKS = 5;

/** The command a key press maps to, or null. Keys with Ctrl, Alt, or Meta are left to the browser. */
export function commandForKey(input: KeyInput): KeyCommand | null {
  if (input.ctrlKey || input.altKey || input.metaKey) return null;
  switch (input.key) {
    case "ArrowLeft":
      return { kind: "tick-delta", delta: input.shiftKey ? -SHIFT_TICKS : -1 };
    case "ArrowRight":
      return { kind: "tick-delta", delta: input.shiftKey ? SHIFT_TICKS : 1 };
    case "Home":
      return { kind: "tick-start" };
    case "End":
      return { kind: "tick-end" };
    case " ":
      return { kind: "toggle-play" };
    case "l":
    case "L":
      return { kind: "follow-live" };
    case "[":
      return { kind: "cycle-tab", delta: -1 };
    case "]":
      return { kind: "cycle-tab", delta: 1 };
    case "j":
      return { kind: "step", delta: 1 };
    case "k":
      return { kind: "step", delta: -1 };
    case "Escape":
      return { kind: "escape" };
    case "/":
      return { kind: "focus-search" };
    default:
      if (/^[1-9]$/.test(input.key)) return { kind: "agent", index: Number(input.key) - 1 };
      return null;
  }
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "color", "file", "image", "reset", "submit"]);

/** Input types that Space and Enter activate (a range slider isn't one). */
const ACTIVATED_INPUTS = new Set(["button", "checkbox", "radio", "color", "file", "image", "reset", "submit"]);

/** True while the user is typing: text inputs, textareas, selects, and contenteditable elements. */
export function isTextEntry(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
  return false;
}

/**
 * True when the focused control handles this key itself: Space and Enter activate buttons and
 * summaries (Enter also links) that were focused from the keyboard; a focused range slider moves with
 * the arrow keys, Home, and End. A control that got focus from a click keeps Space for the page, so
 * clicking a timeline cell and then pressing Space plays rather than clicking the cell again.
 */
export function targetHandlesKey(target: TargetLike | null | undefined, key: string, keyboardFocused = true): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  const type = (target.type ?? "").toLowerCase();
  if (key === " " || key === "Enter") {
    if (!keyboardFocused) return false;
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    if (tag === "A") return key === "Enter";
    if (tag === "INPUT" && ACTIVATED_INPUTS.has(type)) return true;
  }
  if (tag === "INPUT" && type === "range") {
    return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End" || key === "ArrowUp" || key === "ArrowDown";
  }
  return false;
}

/** The index of the tab `delta` away, wrapping around. */
export function cycleIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}
