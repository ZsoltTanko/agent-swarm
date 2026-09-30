import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEventLog, parseEventLines, readEvents } from "../src/harness/eventlog.ts";
import { tempLogPath } from "./helpers/fixtures.ts";

describe("createEventLog", () => {
  it("appends one JSON line per event with seq from 0, the tick, and an ISO timestamp", () => {
    const path = tempLogPath();
    const log = createEventLog(path);
    const first = log.emit(1, { type: "agent_slept", agent: "Heron", reason: "no_tool_calls" });
    const second = log.emit(2, { type: "agent_woke", agent: "Heron", message: "[step 2/10]" });

    expect(first).toMatchObject({ seq: 0, tick: 1, type: "agent_slept", agent: "Heron" });
    expect(second).toMatchObject({ seq: 1, tick: 2, type: "agent_woke", message: "[step 2/10]" });
    expect(new Date(first.at).toISOString()).toBe(first.at);

    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0]!)).toEqual(first);
    expect(JSON.parse(lines[1]!)).toEqual(second);
  });

  it("writes each event before emit returns, so a tailing reader sees it immediately", () => {
    const path = tempLogPath();
    const log = createEventLog(path);
    log.emit(0, { type: "agent_slept", agent: "Otter", reason: "no_tool_calls" });
    expect(readEvents(path)).toHaveLength(1);
    log.emit(0, { type: "agent_slept", agent: "Wren", reason: "no_tool_calls" });
    expect(readEvents(path).map((event) => event.seq)).toEqual([0, 1]);
  });

  it("refuses to emit after close", () => {
    const log = createEventLog(tempLogPath());
    log.close();
    expect(() => log.emit(0, { type: "agent_slept", agent: "Otter", reason: "no_tool_calls" })).toThrow(/closed/);
  });
});

describe("parseEventLines", () => {
  const line = (seq: number): string => JSON.stringify({ seq, tick: 0, at: "x", type: "agent_slept", agent: "A" });

  it("returns complete lines as events and the trailing partial line as rest", () => {
    const text = `${line(0)}\n${line(1)}\n${line(2).slice(0, 10)}`;
    const { events, rest } = parseEventLines(text);
    expect(events.map((event) => event.seq)).toEqual([0, 1]);
    expect(rest).toBe(line(2).slice(0, 10));
  });

  it("supports incremental tailing by carrying rest into the next chunk", () => {
    const full = `${line(0)}\n${line(1)}\n${line(2)}\n`;
    const first = parseEventLines(full.slice(0, 50));
    const second = parseEventLines(first.rest + full.slice(50));
    expect([...first.events, ...second.events].map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(second.rest).toBe("");
  });

  it("returns everything as rest when there is no newline, and skips blank lines", () => {
    expect(parseEventLines(line(0))).toEqual({ events: [], rest: line(0) });
    expect(parseEventLines(`\n${line(0)}\n\n`).events).toHaveLength(1);
    expect(parseEventLines("")).toEqual({ events: [], rest: "" });
  });

  it("throws on a corrupt complete line, naming the line", () => {
    expect(() => parseEventLines(`${line(0)}\n{"seq": 1, bad\n${line(2)}\n`)).toThrow(/line 2/);
    expect(() => parseEventLines(`${line(0)}\n[1, 2]\n`)).toThrow(/not an event/);
  });
});

describe("readEvents", () => {
  it("reads a whole log and tolerates a trailing partial line", () => {
    const path = tempLogPath();
    const log = createEventLog(path);
    log.emit(0, { type: "agent_slept", agent: "Heron", reason: "no_tool_calls" });
    log.emit(1, { type: "agent_slept", agent: "Otter", reason: "no_tool_calls" });
    appendFileSync(path, '{"seq": 2, "tick": 1, "at": "2026-');
    expect(readEvents(path).map((event) => event.seq)).toEqual([0, 1]);
  });

  it("includes a complete final event that lacks its newline", () => {
    const path = tempLogPath();
    writeFileSync(path, '{"seq":0,"tick":0,"at":"x","type":"agent_slept","agent":"A"}');
    expect(readEvents(path)).toHaveLength(1);
  });

  it("throws on a corrupt line in the middle", () => {
    const path = tempLogPath();
    const log = createEventLog(path);
    log.emit(0, { type: "agent_slept", agent: "Heron", reason: "no_tool_calls" });
    appendFileSync(path, "not json\n");
    log.emit(1, { type: "agent_slept", agent: "Otter", reason: "no_tool_calls" });
    expect(() => readEvents(path)).toThrow(/Corrupt event log line 2/);
  });
});
