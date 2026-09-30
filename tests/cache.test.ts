import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResponseCache, cacheKey, cachePath, canonicalJson, type CachedResponse } from "../src/harness/cache.ts";

describe("canonicalJson", () => {
  it("sorts keys recursively, keeps array order, and has no whitespace", () => {
    const value = { b: 1, a: { d: [3, { z: true, y: null }], c: "x" } };
    expect(canonicalJson(value)).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ x: 1, y: { p: 1, q: 2 } })).toBe(canonicalJson({ y: { q: 2, p: 1 }, x: 1 }));
  });

  it("drops undefined-valued keys and nulls undefined array items, like JSON.stringify", () => {
    const value = { a: undefined, b: [undefined, 1], c: 2 };
    expect(canonicalJson(value)).toBe('{"b":[null,1],"c":2}');
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it("escapes strings and keys the way JSON does", () => {
    expect(canonicalJson({ 'k"ey': 'line\nbreak "quoted" ü' })).toBe(JSON.stringify({ 'k"ey': 'line\nbreak "quoted" ü' }));
  });

  it("sorts integer-like keys as strings", () => {
    expect(canonicalJson({ 10: "a", 9: "b", 1: "c" })).toBe('{"1":"c","10":"a","9":"b"}');
  });
});

describe("cacheKey", () => {
  const body = { model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.7 };

  it("is a sha256 hex digest", () => {
    expect(cacheKey(body, 1, 3, "Heron")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores key order but not content, seed, tick, or agent", () => {
    const reordered = { temperature: 0.7, messages: [{ content: "hi", role: "user" }], model: "m" };
    const key = cacheKey(body, 1, 3, "Heron");
    expect(cacheKey(reordered, 1, 3, "Heron")).toBe(key);
    expect(cacheKey(body, 2, 3, "Heron")).not.toBe(key);
    expect(cacheKey(body, 1, 4, "Heron")).not.toBe(key);
    expect(cacheKey({ ...body, temperature: 0.8 }, 1, 3, "Heron")).not.toBe(key);
    // Two agents can send identical bodies in one tick (a template without {name}); each gets its own entry.
    expect(cacheKey(body, 1, 3, "Otter")).not.toBe(key);
  });
});

describe("cachePath", () => {
  it("shards by the first two hex characters", () => {
    const key = "ab" + "0".repeat(62);
    expect(cachePath("/c", key)).toBe(join("/c", "ab", `${key}.json`));
  });

  it("rejects anything that isn't a key, so it can't escape the cache directory", () => {
    expect(() => cachePath("/c", "../../etc/passwd")).toThrow(/Invalid cache key/);
  });
});

describe("ResponseCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function entry(key: string): CachedResponse {
    return {
      key,
      request: { model: "m", messages: [] },
      response: { id: "gen-1", choices: [] },
      headers: { "x-generation-id": "gen-1" },
      latency_ms: 1234,
      attempts: 2,
      created_at: "2026-09-28T00:00:00.000Z",
    };
  }

  it("returns null on a miss", () => {
    expect(new ResponseCache(dir).get(cacheKey({}, 1, 1, "Heron"))).toBeNull();
  });

  it("round-trips an entry through <dir>/<hh>/<key>.json, creating directories", () => {
    const cache = new ResponseCache(join(dir, "nested", "cache"));
    const key = cacheKey({ a: 1 }, 1, 1, "Heron");
    cache.put(entry(key));
    expect(cache.get(key)).toEqual(entry(key));
    const path = cachePath(join(dir, "nested", "cache"), key);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entry(key));
  });

  it("leaves no temp files behind and overwrites in place", () => {
    const cache = new ResponseCache(dir);
    const key = cacheKey({ a: 2 }, 1, 1, "Heron");
    cache.put(entry(key));
    cache.put({ ...entry(key), latency_ms: 5 });
    expect(readdirSync(join(dir, key.slice(0, 2)))).toEqual([`${key}.json`]);
    expect(cache.get(key)?.latency_ms).toBe(5);
  });

  it("throws on a corrupt file instead of treating it as a miss", () => {
    const cache = new ResponseCache(dir);
    const key = cacheKey({ a: 3 }, 1, 1, "Heron");
    cache.put(entry(key));
    writeFileSync(cachePath(dir, key), "{not json");
    expect(() => cache.get(key)).toThrow(/Corrupt response-cache file/);
  });

  it("throws when a file holds a different key", () => {
    const cache = new ResponseCache(dir);
    const key = cacheKey({ a: 4 }, 1, 1, "Heron");
    const other = cacheKey({ a: 5 }, 1, 1, "Heron");
    cache.put(entry(key));
    writeFileSync(cachePath(dir, key), JSON.stringify(entry(other)));
    expect(() => cache.get(key)).toThrow(/key mismatch/);
  });
});
