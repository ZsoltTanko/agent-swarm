import { stat, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  STREAM_EVENTS,
  type ApiError,
  type CachedCall,
  type RunDetail,
  type StreamEndData,
} from "../shared/api.ts";
import { cachePath } from "../harness/cache.ts";
import {
  isPlainFilename,
  isValidRunId,
  listRuns,
  readDocument,
  readRunEvents,
  summarizeRun,
  tailEvents,
} from "./runs.ts";

export interface AppOptions {
  runsDir: string;
  cacheDir: string;
  /** Built UI to serve statically, with index.html as the fallback for client-side routes. */
  uiDir?: string;
}

export const HEARTBEAT_MS = 15_000;

const CACHE_KEY_PATTERN = /^[0-9a-f]{64}$/;

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function notFound(c: Context, error: string) {
  return c.json<ApiError>({ error }, 404);
}

/**
 * The seq a stream starts at: `from` (default 0), or just past Last-Event-ID when an EventSource
 * reconnects. Null when `from` isn't a non-negative integer.
 */
function streamStart(from: string | undefined, lastEventId: string | undefined): number | null {
  if (from !== undefined && !/^\d+$/.test(from)) return null;
  const start = from === undefined ? 0 : Number(from);
  if (lastEventId !== undefined && /^\d+$/.test(lastEventId)) return Math.max(start, Number(lastEventId) + 1);
  return start;
}

export function createApp(options: AppOptions): Hono {
  const runsDir = resolve(options.runsDir);
  const cacheDir = resolve(options.cacheDir);
  const app = new Hono();

  /** The run's folder, or null when the id is invalid or no such folder exists. */
  const runDir = async (id: string): Promise<string | null> => {
    if (!isValidRunId(id)) return null;
    const dir = join(runsDir, id);
    return (await isDirectory(dir)) ? dir : null;
  };

  app.get("/api/runs", async (c) => c.json(await listRuns(runsDir)));

  app.get("/api/runs/:id", async (c) => {
    const dir = await runDir(c.req.param("id"));
    if (!dir) return notFound(c, "Unknown run");
    const summary = await summarizeRun(dir);
    if (!summary) return notFound(c, "The run has not started yet");
    const detail: RunDetail = { summary, run_yaml: (await readTextIfExists(join(dir, "run.yaml"))) ?? "" };
    return c.json(detail);
  });

  app.get("/api/runs/:id/events", async (c) => {
    const dir = await runDir(c.req.param("id"));
    if (!dir) return notFound(c, "Unknown run");
    return c.json(await readRunEvents(dir));
  });

  app.get("/api/runs/:id/stream", async (c) => {
    const dir = await runDir(c.req.param("id"));
    if (!dir) return notFound(c, "Unknown run");
    const start = streamStart(c.req.query("from"), c.req.header("Last-Event-ID"));
    if (start === null) return c.json<ApiError>({ error: "from must be a non-negative integer" }, 400);

    return streamSSE(c, async (stream) => {
      await new Promise<void>((finished) => {
        const heartbeat = setInterval(() => void stream.write(": heartbeat\n\n"), HEARTBEAT_MS);
        const stopTail = tailEvents(
          dir,
          start,
          async (events) => {
            await stream.writeSSE({
              event: STREAM_EVENTS.events,
              data: JSON.stringify(events),
              id: String(events.at(-1)?.seq ?? start),
            });
          },
          async (ended) => {
            const data: StreamEndData = { last_seq: ended.seq };
            await stream.writeSSE({ event: STREAM_EVENTS.end, data: JSON.stringify(data) });
            finish();
          },
        );
        const finish = () => {
          clearInterval(heartbeat);
          stopTail();
          finished();
        };
        stream.onAbort(finish);
        c.req.raw.signal.addEventListener("abort", finish, { once: true });
        if (stream.aborted || c.req.raw.signal.aborted) finish();
      });
    });
  });

  app.get("/api/runs/:id/docs/:docId", async (c) => {
    const dir = await runDir(c.req.param("id"));
    if (!dir) return notFound(c, "Unknown run");
    const docId = c.req.param("docId");
    const doc = isPlainFilename(docId) ? await readDocument(dir, docId) : null;
    if (!doc) return notFound(c, "Unknown document");
    return c.json(doc);
  });

  app.get("/api/runs/:id/deliverable", async (c) => {
    const dir = await runDir(c.req.param("id"));
    if (!dir) return notFound(c, "Unknown run");
    const text = await readTextIfExists(join(dir, "deliverable.md"));
    if (text === null) return notFound(c, "The run has no final deliverable yet");
    return c.body(text, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  app.get("/api/cache/:key", async (c) => {
    const key = c.req.param("key");
    if (!CACHE_KEY_PATTERN.test(key)) return notFound(c, "Invalid cache key");
    const text = await readTextIfExists(cachePath(cacheDir, key));
    if (text === null) return notFound(c, "Not in the cache");
    return c.json(JSON.parse(text) as CachedCall);
  });

  if (options.uiDir) {
    const root = resolve(options.uiDir);
    const assets = serveStatic({ root });
    const index = serveStatic({ path: join(root, "index.html") });
    app.get("*", (c, next) => (isApiPath(c.req.path) ? next() : assets(c, next)));
    app.get("*", (c, next) => (isApiPath(c.req.path) ? next() : index(c, next)));
  }

  app.notFound((c) => notFound(c, "Not found"));
  app.onError((error, c) => {
    console.error(error);
    return c.json<ApiError>({ error: error.message }, 500);
  });

  return app;
}

export interface ServerOptions extends AppOptions {
  port: number;
  hostname: string;
}

/** Starts the app on hostname:port. Rejects if the port can't be bound. */
export function startServer(options: ServerOptions): Promise<{ url: string; server: ServerType }> {
  const app = createApp(options);
  return new Promise((resolveStarted, reject) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: options.hostname }, (info: AddressInfo) => {
      resolveStarted({ url: `http://${options.hostname}:${info.port}`, server });
    });
    server.once("error", reject);
  });
}
