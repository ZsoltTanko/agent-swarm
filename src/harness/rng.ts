import { createHash } from "node:crypto";
import { NAME_POOL } from "../shared/config.ts";
import type { AgentInfo } from "../shared/types.ts";

/** A 32-bit seed derived from the run seed and a label, e.g. ("tick", 7) or ("names"). */
export function deriveSeed(seed: number, ...label: (string | number)[]): number {
  const digest = createHash("sha256").update(JSON.stringify([seed, ...label])).digest();
  return digest.readUInt32LE(0);
}

/** mulberry32: small, fast, good enough for shuffling. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle into a new array. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The order in which a tick's effects are applied. */
export function tickOrder<T>(items: readonly T[], seed: number, tick: number): T[] {
  return shuffle(items, mulberry32(deriveSeed(seed, "tick", tick)));
}

/** Names for a run's agents: a seeded draw from the unordered pool. */
export function assignAgents(seed: number, count: number, model: string): AgentInfo[] {
  if (count > NAME_POOL.length) {
    throw new Error(`At most ${NAME_POOL.length} agents are supported (got ${count}).`);
  }
  const names = shuffle(NAME_POOL, mulberry32(deriveSeed(seed, "names"))).slice(0, count);
  return names.map((name, index) => ({ name, index, model }));
}
