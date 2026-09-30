/** Client for the observer server's HTTP API (src/server/app.ts). */
import {
  STREAM_EVENTS,
  type CachedCall,
  type DocumentResponse,
  type RunDetail,
  type RunSummary,
} from "../shared/api.ts";
import type { RunEvent } from "../shared/events.ts";

/** A non-2xx response. `message` is the server's error text when it sent one. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}

/** A readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Not JSON: keep the status line.
    }
    throw new HttpError(response.status, message);
  }
  return (await response.json()) as T;
}

const runPath = (id: string) => `/api/runs/${encodeURIComponent(id)}`;

/** All runs, newest first. */
export function listRuns(): Promise<RunSummary[]> {
  return getJson<RunSummary[]>("/api/runs");
}

export function fetchRun(id: string): Promise<RunDetail> {
  return getJson<RunDetail>(runPath(id));
}

/** Every complete event logged so far. Empty when the run hasn't logged run_started yet. */
export function fetchEvents(id: string): Promise<RunEvent[]> {
  return getJson<RunEvent[]>(`${runPath(id)}/events`);
}

export function fetchDocument(runId: string, docId: string): Promise<DocumentResponse> {
  return getJson<DocumentResponse>(`${runPath(runId)}/docs/${encodeURIComponent(docId)}`);
}

/** A response-cache entry. Rejects with a 404 HttpError when it isn't cached (normal for scripted runs). */
export function fetchCachedCall(key: string): Promise<CachedCall> {
  return getJson<CachedCall>(`/api/cache/${encodeURIComponent(key)}`);
}

/**
 * `fetch` memoized by `key` for the session, for resources that never change once they exist. A 404
 * is kept too (it stays missing); any other failure is dropped so the next call tries again.
 */
function memoized<T>(cache: Map<string, Promise<T>>, key: string, fetch: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = fetch();
    cache.set(key, pending);
    pending.catch((error: unknown) => {
      if (!isNotFound(error)) cache.delete(key);
    });
  }
  return pending;
}

const documents = new Map<string, Promise<DocumentResponse>>();
const cachedCalls = new Map<string, Promise<CachedCall>>();

/** fetchDocument, fetched once per session: a run's task snapshot never changes. */
export function loadDocument(runId: string, docId: string): Promise<DocumentResponse> {
  return memoized(documents, `${runId}\n${docId}`, () => fetchDocument(runId, docId));
}

/** fetchCachedCall, fetched once per session: a response-cache entry never changes. */
export function loadCachedCall(key: string): Promise<CachedCall> {
  return memoized(cachedCalls, key, () => fetchCachedCall(key));
}

/**
 * Streams a run's events from seq `fromSeq` on. `onEvents` gets each batch (seq ascending); `onEnd` is
 * called once the batch holding run_ended has arrived, and the stream is then closed. The browser
 * reconnects on its own after network errors (resuming via Last-Event-ID), reported through
 * `onConnected(false)` and then `onConnected(true)`; `onError` is called only when it gives up.
 * Returns a function that closes the stream.
 */
export function streamEvents(
  runId: string,
  fromSeq: number,
  onEvents: (events: RunEvent[]) => void,
  onEnd: () => void,
  onError?: (error: unknown) => void,
  onConnected?: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`${runPath(runId)}/stream?from=${Math.max(0, Math.floor(fromSeq))}`);
  let closed = false;
  const close = () => {
    closed = true;
    source.close();
  };

  source.addEventListener(STREAM_EVENTS.events, (message) => {
    const data = (message as { data?: unknown }).data;
    if (closed || typeof data !== "string") return;
    try {
      const events = JSON.parse(data) as RunEvent[];
      if (Array.isArray(events) && events.length > 0) onEvents(events);
    } catch (error) {
      onError?.(error);
    }
  });
  source.addEventListener(STREAM_EVENTS.end, () => {
    if (closed) return;
    close();
    onEnd();
  });
  source.onopen = () => {
    if (!closed) onConnected?.(true);
  };
  source.onerror = (event) => {
    if (closed) return;
    if (source.readyState === EventSource.CLOSED) {
      closed = true;
      onError?.(event);
    } else {
      onConnected?.(false);
    }
  };

  return close;
}
