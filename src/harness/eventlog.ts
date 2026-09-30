import { appendFileSync, readFileSync } from "node:fs";
import type { RunEvent, RunEventPayload } from "../shared/events.ts";
import type { EventLogWriter } from "./types.ts";

/**
 * An append-only JSONL writer. Each event is appended synchronously as one line, so a tailing reader
 * sees whole events as soon as they happen. The caller creates the directory.
 */
export function createEventLog(path: string): EventLogWriter {
  let seq = 0;
  let closed = false;
  return {
    emit(tick: number, payload: RunEventPayload): RunEvent {
      if (closed) throw new Error(`The event log ${path} is closed.`);
      const event = { seq, tick, at: new Date().toISOString(), ...payload } as RunEvent;
      appendFileSync(path, `${JSON.stringify(event)}\n`);
      seq += 1;
      return event;
    },
    close() {
      closed = true;
    },
  };
}

function parseEvent(line: string, lineNumber: number): RunEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Corrupt event log line ${lineNumber}: ${(error as Error).message}`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { seq?: unknown }).seq !== "number" ||
    typeof (value as { type?: unknown }).type !== "string"
  ) {
    throw new Error(`Corrupt event log line ${lineNumber}: not an event.`);
  }
  return value as RunEvent;
}

/**
 * Parses the complete lines of a chunk of JSONL. `rest` is the trailing partial line (text after the last
 * newline), to be prepended to the next chunk when tailing. Blank lines are skipped; a corrupt complete
 * line throws, with its line number within `text`.
 */
export function parseEventLines(text: string): { events: RunEvent[]; rest: string } {
  const end = text.lastIndexOf("\n");
  const rest = text.slice(end + 1);
  const events: RunEvent[] = [];
  if (end === -1) return { events, rest };
  text
    .slice(0, end)
    .split("\n")
    .forEach((line, index) => {
      if (line.trim() !== "") events.push(parseEvent(line, index + 1));
    });
  return { events, rest };
}

/**
 * Reads a whole event log. A trailing line without its newline (a write in progress) is included if it
 * parses and ignored otherwise; a corrupt line anywhere before it throws.
 */
export function readEvents(path: string): RunEvent[] {
  const { events, rest } = parseEventLines(readFileSync(path, "utf8"));
  if (rest.trim() !== "") {
    try {
      events.push(parseEvent(rest, 0));
    } catch {
      // A partial line: the writer hasn't finished it yet.
    }
  }
  return events;
}
