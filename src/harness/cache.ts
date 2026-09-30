import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * JSON with object keys sorted recursively (by UTF-16 code unit) and no whitespace.
 * Otherwise follows JSON.stringify: toJSON is honored, undefined/function/symbol values are
 * dropped from objects and become null in arrays, and non-finite numbers become null.
 */
export function canonicalJson(value: unknown): string {
  const json = writeCanonical(value);
  if (json === undefined) throw new TypeError("canonicalJson: value is not JSON-serializable");
  return json;
}

function writeCanonical(input: unknown): string | undefined {
  let value = input;
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      throw new TypeError("canonicalJson: BigInt is not JSON-serializable");
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => writeCanonical(item) ?? "null").join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const member = writeCanonical(record[key]);
        if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      return undefined;
  }
}

/**
 * The response-cache key of a request: sha256 hex of the canonical JSON of body, seed, tick, and agent.
 * The agent is part of the key because two agents can send identical bodies in the same tick (a prompt
 * template without {name}), and each must get its own sample.
 */
export function cacheKey(body: unknown, seed: number, tick: number, agent: string): string {
  return createHash("sha256").update(canonicalJson({ agent, body, seed, tick })).digest("hex");
}

/** A request that failed because it didn't fit the context window: its outcome is this error, not a response. */
export interface CachedContextLengthError {
  kind: "context_length";
  status: number | null;
  /** The ModelCallError message the call failed with. */
  message: string;
}

/** One cache file: cache/<hh>/<key>.json. */
export interface CachedResponse {
  key: string;
  /** The request body exactly as sent. */
  request: unknown;
  /** The raw JSON response body; for a cached error, the error body. */
  response: unknown;
  /** Response headers, lowercased names (x-generation-id among them). */
  headers: Record<string, string>;
  latency_ms: number;
  /** Requests it took to get the response (1 = no retry). */
  attempts: number;
  created_at: string;
  /** Set when the call failed with a context-length error, which is cached because it is final. */
  error?: CachedContextLengthError;
}

/** Where the entry for `key` lives: <cacheDir>/<first two hex chars of key>/<key>.json. */
export function cachePath(cacheDir: string, key: string): string {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`Invalid cache key: ${JSON.stringify(key)}`);
  return join(cacheDir, key.slice(0, 2), `${key}.json`);
}

export class ResponseCache {
  constructor(readonly dir: string) {}

  /** The cached entry, or null when there is none. A corrupt or mismatched file throws. */
  get(key: string): CachedResponse | null {
    const path = cachePath(this.dir, key);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let entry: CachedResponse;
    try {
      entry = JSON.parse(text) as CachedResponse;
    } catch {
      throw new Error(`Corrupt response-cache file (invalid JSON): ${path}`);
    }
    if (entry === null || typeof entry !== "object" || entry.key !== key) {
      throw new Error(`Corrupt response-cache file (key mismatch): ${path}`);
    }
    return entry;
  }

  /** Writes atomically: a temp file in the same directory, then a rename over the target. */
  put(entry: CachedResponse): void {
    const path = cachePath(this.dir, entry.key);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`);
      renameSync(temp, path);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
