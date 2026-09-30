import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { firstDifference } from "../shared/compare.ts";
import type { RunConfig } from "../shared/config.ts";
import type { ModelInfo, RunEvent, RunMode } from "../shared/events.ts";
import { ConfigError, loadConfig, withSeed } from "./config.ts";
import { runSwarm } from "./engine.ts";
import { createEventLog, readEvents } from "./eventlog.ts";
import {
  fetchEndpoints,
  fetchModel,
  formatEndpointTable,
  resolveEndpoint,
  type EndpointResolution,
} from "./openrouter/catalog.ts";
import { createOpenRouterModelClient, isSendableApiKey } from "./openrouter/client.ts";
import { renderSystemPrompts } from "./prompts.ts";
import { assignAgents } from "./rng.ts";
import { createRunDir, makeRunId, writeResolvedConfig } from "./runs.ts";
import { createScriptedModelClient } from "./scripted.ts";
import { loadTask, snapshotTask, taskWarnings } from "./task.ts";
import { buildTools } from "./tools.ts";
import type { ModelClient, RunOutcome, TickSummary } from "./types.ts";

const USAGE = `Usage: npm run swarm -- <config.yaml> [options]

Options:
  --seed N           override run.seed
  --dry-run          validate, pin the endpoint, and render prompts; no model calls, nothing written
  --offline          no network: every response must come from the cache
  --scripted         use the scripted fake model (no network, no API key)
  --runs-dir DIR     where run folders go (default: runs)
  --cache-dir DIR    response cache (default: cache)

Re-running a run's own runs/<run-id>/run.yaml compares the new event log with the
original one afterwards (up to where the original stopped, if it was cut short).

Exit codes: 0 finished; 1 an error, including a run that ended with api_error;
2 bad arguments; 3 a re-run's log differs from the original's; 130 interrupted (Ctrl-C).`;

const ENDPOINT_TABLE_ROWS = 10;
const DIFFERENCE_EXCERPT_CHARS = 300;

/** A run folder's resolved config, and the snapshots it points at, relative to the folder. */
const RUN_CONFIG_FILE = "run.yaml";
const TASK_SNAPSHOT = "task";
const PROMPT_SNAPSHOT = "prompt.md";

/** An expected failure: printed as one message, without a stack trace. */
class CliError extends Error {}

/** Bad command-line arguments: printed with the usage text. */
class UsageError extends Error {}

interface CliArgs {
  configPath: string;
  seed: number | null;
  dryRun: boolean;
  mode: RunMode;
  runsDir: string;
  cacheDir: string;
}

/** The run whose run.yaml is being re-run. */
interface OriginalRun {
  id: string;
  eventsPath: string;
}

interface ModelResolution {
  params: Record<string, unknown>;
  /** Null when nothing was resolved over the network (--scripted, --offline, and re-runs of a run.yaml). */
  modelInfo: ModelInfo | null;
  contextLength: number | null;
}

/** Runs the CLI with the arguments after the script name and returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  let args: CliArgs | "help";
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }

  try {
    return await run(args);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CliError) {
      console.error(`Error: ${error.message}`);
      return 1;
    }
    console.error(error);
    return 1;
  }
}

async function run(args: CliArgs): Promise<number> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  let config = loadConfig(args.configPath);
  if (basename(args.configPath) === RUN_CONFIG_FILE) config = withPathsFrom(config, dirname(args.configPath));
  const original = args.seed === null || args.seed === config.run.seed ? originalRun(args.configPath) : null;
  if (args.seed !== null) config = withSeed(config, args.seed);
  const seed = config.run.seed;

  const sourceTask = loadTask(config.task, config.task_name);
  const words = sourceTask.docs.reduce((sum, doc) => sum + doc.meta.words, 0);
  console.log(
    `Task ${sourceTask.name}: ${plural(sourceTask.docs.length, "document")}, ${formatCount(words)} words`,
  );
  const baseWarnings = taskWarnings(sourceTask, config, null);
  printWarnings(baseWarnings);

  const model = args.mode !== "live" || original !== null ? configuredModel(config) : await resolveModel(config);
  if (model.contextLength !== null) {
    const sizeWarnings = taskWarnings(sourceTask, config, model.contextLength);
    printWarnings(sizeWarnings.filter((warning) => !baseWarnings.includes(warning)));
  }
  config = withParams(config, model.params);

  const agents = config.agents.names
    ? config.agents.names.map((name, index) => ({ name, index, model: config.agents.model.id }))
    : assignAgents(seed, config.agents.count, config.agents.model.id);
  config = {
    ...config,
    agents: { count: config.agents.count, names: agents.map((agent) => agent.name), model: config.agents.model },
  };
  const templatePath = config.environment.prompt_template;
  const systemPrompts = renderSystemPrompts(readTemplate(templatePath), agents, sourceTask, config);
  const tools = buildTools(config.environment);

  if (args.dryRun) {
    const first = agents[0]!;
    console.log(`\n--- Resolved config ---\n${stringify(config).trimEnd()}`);
    console.log(`\n--- System prompt (${first.name}) ---\n${systemPrompts[first.name]}`);
    console.log(`\n--- Kickoff ---\n${config.environment.kickoff}`);
    console.log(`\n--- Tools ---\n${tools.map((tool) => tool.function.name).join(", ")}`);
    console.log("\nDry run: no model calls made, nothing written.");
    return 0;
  }

  const apiKey = apiKeyFrom(process.env.OPENROUTER_API_KEY, args.mode === "live");

  const { dir, runId } = createRunDir(args.runsDir, makeRunId(sourceTask.name, seed, new Date()));
  const taskDir = join(dir, TASK_SNAPSHOT);
  const promptPath = join(dir, PROMPT_SNAPSHOT);
  snapshotTask(sourceTask, taskDir);
  copyFileSync(templatePath, promptPath);
  const resolved: RunConfig = {
    task: TASK_SNAPSHOT,
    task_name: sourceTask.name,
    agents: config.agents,
    environment: { ...config.environment, prompt_template: PROMPT_SNAPSHOT },
    run: config.run,
  };
  writeResolvedConfig(join(dir, RUN_CONFIG_FILE), resolved, runId, args.mode === "scripted" ? "--scripted" : "--offline");

  const task = loadTask(taskDir, resolved.task_name);
  const runPrompts = renderSystemPrompts(readTemplate(promptPath), agents, task, resolved);
  const client: ModelClient =
    args.mode === "scripted"
      ? createScriptedModelClient()
      : createOpenRouterModelClient({
          apiKey,
          cacheDir: args.cacheDir,
          offline: args.mode === "offline",
          timeoutMs: resolved.run.call_timeout_s * 1000,
          maxRetries: resolved.run.max_retries,
          onRetry: (info) =>
            console.log(
              `  retry ${info.attempt} for ${info.agent} at tick ${info.tick} in ${(info.delayMs / 1000).toFixed(1)}s: ${info.reason}`,
            ),
        });

  console.log(`\nRun ${runId} in ${dir} with ${agents.map((agent) => agent.name).join(", ")}`);
  if (original !== null) console.log(`Re-run of ${original.id}: the event logs are compared at the end.`);
  const controller = new AbortController();
  const onSigint = (): void => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
    console.log("\nStopping: aborting the model calls in flight...");
  };
  process.on("SIGINT", onSigint);
  const log = createEventLog(join(dir, "events.jsonl"));
  let outcome: RunOutcome;
  try {
    outcome = await runSwarm({
      runId,
      config: resolved,
      task,
      agents,
      systemPrompts: runPrompts,
      kickoff: resolved.environment.kickoff,
      tools,
      model: client,
      log,
      mode: args.mode,
      modelInfo: model.modelInfo,
      onTick: (summary) => console.log(formatTick(summary, resolved.run.tick_cap)),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    log.close();
  }

  writeFileSync(join(dir, "deliverable.md"), outcome.finalDeliverable);
  printOutcome(outcome, args.mode, dir);
  if (outcome.reason === "interrupted") return 130;
  const matches = original === null || compareWithOriginal(original, join(dir, "events.jsonl"));
  if (outcome.reason === "api_error") return 1;
  return matches ? 0 : 3;
}

/**
 * OPENROUTER_API_KEY, trimmed; null when unset. When the run needs it, a missing key or one that can't
 * be sent in a header is an error (whose message never quotes the key).
 */
export function apiKeyFrom(value: string | undefined, needed: boolean): string | null {
  const key = value?.trim() || null;
  if (!needed) return key;
  if (key === null) {
    throw new CliError(
      "OPENROUTER_API_KEY is not set. Add it to .env (see .env.example) or the environment, or run with --scripted or --offline.",
    );
  }
  if (!isSendableApiKey(key)) {
    throw new CliError(
      "OPENROUTER_API_KEY contains a space, line break, or other character that can't be sent in an HTTP header. " +
        "Check .env for a stray quote or line break.",
    );
  }
  return key;
}

/** A run folder's run.yaml names its snapshots relative to the folder, so the folder can be moved or copied. */
function withPathsFrom(config: RunConfig, dir: string): RunConfig {
  const from = (path: string): string => (isAbsolute(path) ? path : join(dir, path));
  return {
    ...config,
    task: from(config.task),
    environment: { ...config.environment, prompt_template: from(config.environment.prompt_template) },
  };
}

/** The run a config path belongs to when it is <dir>/run.yaml and <dir>/events.jsonl exists; otherwise null. */
function originalRun(configPath: string): OriginalRun | null {
  if (basename(configPath) !== RUN_CONFIG_FILE) return null;
  const eventsPath = join(dirname(configPath), "events.jsonl");
  return existsSync(eventsPath) ? { id: basename(dirname(configPath)), eventsPath } : null;
}

/**
 * Prints whether a re-run's log matches the original's, apart from what legitimately differs. An
 * original cut short (interrupted, api_error) is compared up to where it stopped, since re-running it
 * resumes it: the re-run goes on past the original's run_ended.
 */
function compareWithOriginal(original: OriginalRun, rerunEventsPath: string): boolean {
  let before: RunEvent[];
  try {
    before = readEvents(original.eventsPath);
  } catch (error) {
    throw new CliError(`Cannot read the log of ${original.id}: ${describeError(error)}`);
  }
  const after = readEvents(rerunEventsPath);
  const last = before.at(-1);
  const cut = last?.type === "run_ended" && (last.reason === "interrupted" || last.reason === "api_error") ? last : null;
  const expected = cut ? before.slice(0, -1) : before;
  const actual = cut ? after.slice(0, expected.length) : after;
  const difference = firstDifference(expected, actual);
  if (difference === null) {
    const upTo = cut ? ` up to its ${cut.reason} at tick ${cut.tick}` : "";
    console.log(`Re-run matches ${original.id}${upTo}: ${plural(expected.length, "event")} identical`);
    return true;
  }
  const type = expected[difference.seq]?.type ?? actual[difference.seq]?.type;
  const where = difference.path === "" ? "" : `, ${difference.path}`;
  console.log(`Re-run differs from ${original.id} at seq ${difference.seq} (${type})${where}:`);
  console.log(`  original: ${excerptValue(difference.a)}`);
  console.log(`  re-run:   ${excerptValue(difference.b)}`);
  return false;
}

function excerptValue(value: unknown): string {
  if (value === undefined) return "(missing)";
  const json = JSON.stringify(value);
  return json.length > DIFFERENCE_EXCERPT_CHARS ? `${json.slice(0, DIFFERENCE_EXCERPT_CHARS)}…` : json;
}

function parseCliArgs(argv: string[]): CliArgs | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        seed: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        offline: { type: "boolean", default: false },
        scripted: { type: "boolean", default: false },
        "runs-dir": { type: "string", default: "runs" },
        "cache-dir": { type: "string", default: "cache" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  if (positionals.length !== 1) {
    throw new UsageError(
      positionals.length === 0 ? "Missing the config file." : `Expected one config file, got ${positionals.join(" ")}.`,
    );
  }
  let seed: number | null = null;
  if (values.seed !== undefined) {
    if (!/^\d+$/.test(values.seed) || !Number.isSafeInteger(Number(values.seed))) {
      throw new UsageError(`--seed must be a non-negative integer (got "${values.seed}").`);
    }
    seed = Number(values.seed);
  }
  return {
    configPath: positionals[0]!,
    seed,
    dryRun: values["dry-run"],
    mode: values.scripted ? "scripted" : values.offline ? "offline" : "live",
    runsDir: values["runs-dir"],
    cacheDir: values["cache-dir"],
  };
}

/**
 * --scripted and --offline make no network calls, and a re-run keeps the endpoint its run pinned: params
 * are used as configured (a run.yaml is already resolved).
 */
function configuredModel(config: RunConfig): ModelResolution {
  return { params: config.agents.model.params, modelInfo: null, contextLength: null };
}

/** Pins an endpoint from the OpenRouter catalog and prints how it was chosen. */
async function resolveModel(config: RunConfig): Promise<ModelResolution> {
  const { id, params } = config.agents.model;
  let resolution: EndpointResolution;
  try {
    const [catalog, endpoints] = await Promise.all([fetchModel(id), fetchEndpoints(id)]);
    resolution = resolveEndpoint(catalog, endpoints, params);
  } catch (error) {
    throw new CliError(`Cannot use model ${id}: ${describeError(error)}`);
  }

  const chosen = resolution.endpoint.tag;
  const shown = resolution.ranked.slice(0, ENDPOINT_TABLE_ROWS);
  const chosenRow = resolution.ranked.find((row) => row.endpoint.tag === chosen);
  if (chosenRow && !shown.includes(chosenRow)) shown.push(chosenRow);
  console.log(`\nEndpoints for ${id}:`);
  console.log(formatEndpointTable(shown, chosen));
  const hidden = resolution.ranked.length - shown.length;
  if (hidden > 0) console.log(`(${hidden} more not shown)`);
  printWarnings(resolution.warnings);
  console.log(`Pinned ${chosen} (${resolution.endpoint.provider_name}). Request params:`);
  console.log(indent(stringify(resolution.params).trimEnd()));

  return {
    params: resolution.params,
    modelInfo: { id, catalog: resolution.model, endpoint: resolution.endpoint },
    contextLength: resolution.endpoint.context_length,
  };
}

function withParams(config: RunConfig, params: Record<string, unknown>): RunConfig {
  return { ...config, agents: { ...config.agents, model: { ...config.agents.model, params } } };
}

function readTemplate(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read the prompt template ${path}: ${describeError(error)}`);
  }
}

/** "tick  3/40 · 5 active · 2 posts · 1 doc · 0 writes · 1 asleep · 0 finished · $0.0123 (2 cached)" */
export function formatTick(summary: TickSummary, tickCap: number): string {
  const tick = String(summary.tick).padStart(String(tickCap).length);
  const cost = `$${summary.cost_usd.toFixed(4)}${summary.cache_hits > 0 ? ` (${summary.cache_hits} cached)` : ""}`;
  return [
    `tick ${tick}/${tickCap}`,
    `${summary.active} active`,
    plural(summary.posts, "post"),
    plural(summary.doc_opens, "doc"),
    plural(summary.writes, "write"),
    `${summary.asleep} asleep`,
    `${summary.finished} finished`,
    cost,
  ].join(" · ");
}

/**
 * "$0.1234 (3 of 10 calls from the cache)": the cost of every response, the unapplied ones of an
 * aborted tick included, and how much of it this run spent. A cache hit carries the cost of the call
 * that was cached, and a scripted run's costs are simulated.
 */
export function formatCost(outcome: Pick<RunOutcome, "totals" | "unapplied">, mode: RunMode): string {
  const { totals, unapplied } = outcome;
  const calls = totals.model_calls + unapplied.length;
  const cached = totals.cache_hits + unapplied.filter((call) => call.cache_hit).length;
  let note = "";
  if (mode === "scripted") note = " (simulated)";
  else if (calls > 0 && cached === calls) note = " (from the cache: nothing new was spent)";
  else if (cached > 0) note = ` (${formatCount(cached)} of ${formatCount(calls)} calls from the cache)`;
  const unappliedCost = unapplied.reduce((sum, call) => sum + call.usage.cost_usd, 0);
  const aborted =
    unapplied.length > 0
      ? `, including $${unappliedCost.toFixed(4)} for ${plural(unapplied.length, "response")} of the aborted tick`
      : "";
  return `$${totals.usage.cost_usd.toFixed(4)}${note}${aborted}`;
}

function printOutcome(outcome: RunOutcome, mode: RunMode, dir: string): void {
  const { totals } = outcome;
  const usage = totals.usage;
  console.log(`\nRun ended: ${outcome.reason} after ${plural(totals.ticks, "tick")}`);
  if (outcome.error !== null) console.error(`Error: ${outcome.error}`);
  console.log(`Calls:  ${formatCount(totals.model_calls)} (${formatCount(totals.cache_hits)} from cache)`);
  console.log(
    `Tokens: ${formatCount(usage.prompt_tokens)} prompt (${formatCount(usage.cached_tokens)} cached), ` +
      `${formatCount(usage.completion_tokens)} completion (${formatCount(usage.reasoning_tokens)} reasoning)`,
  );
  console.log(`Cost:   ${formatCost(outcome, mode)}`);
  console.log(`Output: ${plural(totals.posts, "post")}, ${plural(totals.deliverable_versions, "deliverable version")}`);
  console.log(`Run folder: ${dir}`);
  console.log("View it: npm run ui");
}

function printWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) console.log(`Warning: ${warning}`);
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

/**
 * Exits explicitly, so undici's keep-alive sockets don't hold the process open, but only after stdout
 * and stderr have flushed: writes to a pipe are asynchronous on macOS.
 */
function exitWith(code: number): void {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(exitWith, (error: unknown) => {
    console.error(error);
    exitWith(1);
  });
}
