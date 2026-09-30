import { describe, expect, it } from "vitest";
import { commandForKey, cycleIndex, isTextEntry, targetHandlesKey, type KeyInput } from "../src/ui/keyboard.ts";

const key = (k: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...modifiers,
});

describe("commandForKey", () => {
  it("steps ticks with the arrows, by five with Shift", () => {
    expect(commandForKey(key("ArrowLeft"))).toEqual({ kind: "tick-delta", delta: -1 });
    expect(commandForKey(key("ArrowRight"))).toEqual({ kind: "tick-delta", delta: 1 });
    expect(commandForKey(key("ArrowLeft", { shiftKey: true }))).toEqual({ kind: "tick-delta", delta: -5 });
    expect(commandForKey(key("ArrowRight", { shiftKey: true }))).toEqual({ kind: "tick-delta", delta: 5 });
  });

  it("maps the other shortcuts", () => {
    expect(commandForKey(key("Home"))).toEqual({ kind: "tick-start" });
    expect(commandForKey(key("End"))).toEqual({ kind: "tick-end" });
    expect(commandForKey(key(" "))).toEqual({ kind: "toggle-play" });
    expect(commandForKey(key("l"))).toEqual({ kind: "follow-live" });
    expect(commandForKey(key("L", { shiftKey: true }))).toEqual({ kind: "follow-live" });
    expect(commandForKey(key("["))).toEqual({ kind: "cycle-tab", delta: -1 });
    expect(commandForKey(key("]"))).toEqual({ kind: "cycle-tab", delta: 1 });
    expect(commandForKey(key("j"))).toEqual({ kind: "step", delta: 1 });
    expect(commandForKey(key("k"))).toEqual({ kind: "step", delta: -1 });
    expect(commandForKey(key("Escape"))).toEqual({ kind: "escape" });
    expect(commandForKey(key("/"))).toEqual({ kind: "focus-search" });
  });

  it("maps 1–9 to agent indexes 0–8, and ignores 0", () => {
    expect(commandForKey(key("1"))).toEqual({ kind: "agent", index: 0 });
    expect(commandForKey(key("9"))).toEqual({ kind: "agent", index: 8 });
    expect(commandForKey(key("0"))).toBeNull();
  });

  it("leaves keys with Ctrl, Alt, or Meta to the browser", () => {
    expect(commandForKey(key("ArrowLeft", { metaKey: true }))).toBeNull();
    expect(commandForKey(key("l", { ctrlKey: true }))).toBeNull();
    expect(commandForKey(key("1", { altKey: true }))).toBeNull();
  });

  it("ignores unmapped keys", () => {
    expect(commandForKey(key("x"))).toBeNull();
    expect(commandForKey(key("Tab"))).toBeNull();
    expect(commandForKey(key("J", { shiftKey: true }))).toBeNull();
  });
});

describe("isTextEntry", () => {
  it("treats text-like inputs, textareas, selects, and contenteditable as typing", () => {
    expect(isTextEntry({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntry({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntry({ tagName: "SELECT" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("doesn't treat buttons, ranges, and plain elements as typing", () => {
    expect(isTextEntry({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntry({ tagName: "BODY" })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("targetHandlesKey", () => {
  it("leaves Space and Enter to buttons, links, and summaries", () => {
    expect(targetHandlesKey({ tagName: "BUTTON" }, " ")).toBe(true);
    expect(targetHandlesKey({ tagName: "A" }, "Enter")).toBe(true);
    expect(targetHandlesKey({ tagName: "SUMMARY" }, " ")).toBe(true);
    expect(targetHandlesKey({ tagName: "DIV" }, " ")).toBe(false);
  });

  it("keeps Space for the page when a control was focused by a click, or is a range slider", () => {
    expect(targetHandlesKey({ tagName: "BUTTON" }, " ", false)).toBe(false);
    expect(targetHandlesKey({ tagName: "INPUT", type: "checkbox" }, " ", false)).toBe(false);
    expect(targetHandlesKey({ tagName: "INPUT", type: "checkbox" }, " ")).toBe(true);
    expect(targetHandlesKey({ tagName: "INPUT", type: "range" }, " ")).toBe(false);
    expect(targetHandlesKey({ tagName: "A" }, " ")).toBe(false);
  });

  it("leaves arrows, Home, and End to a focused range slider", () => {
    for (const k of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(targetHandlesKey({ tagName: "INPUT", type: "range" }, k)).toBe(true);
    }
    expect(targetHandlesKey({ tagName: "INPUT", type: "range" }, "l")).toBe(false);
    expect(targetHandlesKey({ tagName: "BUTTON" }, "ArrowLeft")).toBe(false);
  });
});

describe("cycleIndex", () => {
  it("wraps in both directions", () => {
    expect(cycleIndex(0, -1, 6)).toBe(5);
    expect(cycleIndex(5, 1, 6)).toBe(0);
    expect(cycleIndex(2, 1, 6)).toBe(3);
    expect(cycleIndex(-1, 1, 6)).toBe(0);
    expect(cycleIndex(0, 1, 0)).toBe(0);
  });
});
