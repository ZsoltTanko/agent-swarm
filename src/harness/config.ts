import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { HARNESS_OWNED_PARAMS, RunConfigSchema, type RunConfig } from "../shared/config.ts";

/** A problem with the run's inputs (config, task folder, prompt template) that the user has to fix. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Reads and validates a run config. Every problem in the file is reported in one ConfigError. */
export function loadConfig(path: string): RunConfig {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read config ${path}: ${errorMessage(error)}`);
  }

  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new ConfigError(`Config ${path} is not valid YAML: ${errorMessage(error)}`);
  }

  const problems: string[] = [];
  const result = RunConfigSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) problems.push(...describeIssue(issue, raw));
  }
  problems.push(...ownedParamProblems(raw));

  if (problems.length > 0 || !result.success) {
    throw new ConfigError(`Invalid config ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return result.data;
}

export function withSeed(config: RunConfig, seed: number): RunConfig {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new ConfigError(`The seed must be a non-negative integer (got ${seed}).`);
  }
  return { ...config, run: { ...config.run, seed } };
}

function describeIssue(issue: z.core.$ZodIssue, raw: unknown): string[] {
  if (issue.code === "unrecognized_keys") {
    const known = knownKeysAt(issue.path);
    return issue.keys.map((key) => {
      const suggestion = closestKey(key, known);
      const hint = suggestion
        ? ` (did you mean "${suggestion}"?)`
        : known.length > 0
          ? ` (expected one of: ${known.join(", ")})`
          : "";
      return `${formatPath([...issue.path, key])}: unknown key${hint}`;
    });
  }
  if (issue.code === "invalid_type" && issue.path.length === 0) {
    return ["the file must be a YAML mapping with the keys task, agents, environment, and run"];
  }
  if (issue.code === "invalid_type" && valueAt(raw, issue.path) === undefined) {
    return [`${formatPath(issue.path)}: missing (expected ${issue.expected})`];
  }
  return [`${formatPath(issue.path)}: ${issue.message}`];
}

function ownedParamProblems(raw: unknown): string[] {
  const params = valueAt(raw, ["agents", "model", "params"]);
  if (!isRecord(params)) return [];
  return HARNESS_OWNED_PARAMS.filter((key) => Object.hasOwn(params, key)).map(
    (key) => `agents.model.params.${key}: set by the harness; remove it from params`,
  );
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(top level)";
  return path
    .map((segment, i) => (typeof segment === "number" ? `[${segment}]` : `${i > 0 ? "." : ""}${String(segment)}`))
    .join("");
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The keys the config schema allows at a path (empty when the path isn't an object in the schema). */
function knownKeysAt(path: readonly PropertyKey[]): string[] {
  let schema: unknown = RunConfigSchema;
  for (const segment of path) {
    const shape = objectShape(schema);
    if (!shape || typeof segment !== "string") return [];
    schema = shape[segment];
  }
  return Object.keys(objectShape(schema) ?? {});
}

/** Unwraps default/prefault/optional wrappers down to an object schema's shape. */
function objectShape(schema: unknown): Record<string, unknown> | null {
  let current = schema;
  while (current instanceof z.ZodType) {
    if (current instanceof z.ZodObject) return current.shape;
    current = (current.def as { innerType?: unknown }).innerType;
  }
  return null;
}

function closestKey(key: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(key.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
