import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { RunConfigSchema } from "../../src/shared/config.ts";
import type { EnvironmentConfig, RunConfig, RunSettings } from "../../src/shared/config.ts";
import { rebuildContext } from "../../src/shared/context.ts";
import type { RunEvent, RunMode } from "../../src/shared/events.ts";
import type { AgentInfo } from "../../src/shared/types.ts";
import { runSwarm } from "../../src/harness/engine.ts";
import { createEventLog, readEvents } from "../../src/harness/eventlog.ts";
import { buildTools } from "../../src/harness/tools.ts";
import type { LoadedTask, ModelClient, RunOutcome, TickSummary } from "../../src/harness/types.ts";
import type { CapturedRequest } from "./fake-model.ts";

export const TEST_MODEL = "test/model";

export interface DocSpec {
  id: string;
  title?: string;
  text: string;
}

/** An in-memory task. Titles default to the id; word counts are computed from the text. */
export function makeTask(docs: DocSpec[], text = "Summarize the documents."): LoadedTask {
  return {
    name: "tiny",
    dir: "/nonexistent/tiny",
    text,
    docs: docs.map((doc) => ({
      meta: {
        id: doc.id,
        filename: `${doc.id}.md`,
        title: doc.title ?? doc.id,
        words: doc.text.split(/\s+/).filter(Boolean).length,
        chars: doc.text.length,
        sha256: createHash("sha256").update(doc.text).digest("hex"),
      },
      text: doc.text,
    })),
  };
}

export const THREE_DOCS: DocSpec[] = [
  { id: "d1", title: "First", text: "Alpha one. The first document says the river floods in spring." },
  { id: "d2", title: "Second", text: "Beta two. The second document says the bridge was built in 1911." },
  { id: "d3", title: "Third", text: "Gamma three. The third document says the mill closed in 1968." },
];

export interface ConfigOverrides {
  count?: number;
  environment?: Partial<EnvironmentConfig>;
  run?: Partial<RunSettings>;
}

export function makeConfig(overrides: ConfigOverrides = {}): RunConfig {
  return RunConfigSchema.parse({
    task: "tasks/tiny",
    agents: { count: overrides.count ?? 3, model: { id: TEST_MODEL, params: { max_tokens: 1000 } } },
    environment: { doc_read_budget: 2, ...overrides.environment },
    run: { seed: 1, tick_cap: 10, max_cost_usd: 100, ...overrides.run },
  });
}

export function makeAgents(names: string[]): AgentInfo[] {
  return names.map((name, index) => ({ name, index, model: TEST_MODEL }));
}

export function systemPromptsFor(agents: AgentInfo[], task: LoadedTask, config: RunConfig): Record<string, string> {
  return Object.fromEntries(
    agents.map((agent) => [
      agent.name,
      `You are ${agent.name}. You are one of several agents who have all been given the same task and the same tools.\n\n` +
        `The task involves ${task.docs.length} documents. You can open at most ${config.environment.doc_read_budget} of them yourself.\n\n` +
        `<task>\n${task.text}\n</task>`,
    ]),
  );
}

export function tempLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "swarm-test-")), "events.jsonl");
}

export interface ScenarioOptions {
  names: string[];
  docs?: DocSpec[];
  config?: ConfigOverrides;
  model: ModelClient;
  /** Defaults to "scripted": test models are fakes. */
  mode?: RunMode;
  signal?: AbortSignal;
  kickoff?: string;
  /** Defaults to systemPromptsFor(...), which names each agent. */
  systemPrompts?: Record<string, string>;
}

export interface ScenarioResult {
  outcome: RunOutcome;
  events: RunEvent[];
  summaries: TickSummary[];
  config: RunConfig;
  logPath: string;
}

/** Runs the engine over an in-memory task, logging to a temp file, and reads the log back. */
export async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const task = makeTask(options.docs ?? THREE_DOCS);
  const config = makeConfig({ count: options.names.length, ...options.config });
  const agents = makeAgents(options.names);
  const logPath = tempLogPath();
  const log = createEventLog(logPath);
  const summaries: TickSummary[] = [];
  const outcome = await runSwarm({
    runId: "test-run",
    config,
    task,
    agents,
    systemPrompts: options.systemPrompts ?? systemPromptsFor(agents, task, config),
    kickoff: options.kickoff ?? "Go.",
    tools: buildTools(config.environment),
    model: options.model,
    log,
    mode: options.mode ?? "scripted",
    modelInfo: null,
    onTick: (summary) => summaries.push(summary),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  log.close();
  return { outcome, events: readEvents(logPath), summaries, config, logPath };
}

/**
 * Every request the model received equals the context rebuilt from the log just before its model_call.
 * Returns the number of model_call events checked.
 */
export function expectContextsMatchLog(events: RunEvent[], requests: CapturedRequest[]): number {
  let checked = 0;
  for (const event of events) {
    if (event.type !== "model_call") continue;
    const matching = requests.filter((request) => request.agent === event.agent && request.tick === event.tick);
    expect(matching, `one request for ${event.agent} at tick ${event.tick}`).toHaveLength(1);
    expect(matching[0]!.request.messages).toEqual(rebuildContext(events, event.agent, event.seq - 1));
    expect(event.request_messages).toBe(matching[0]!.request.messages.length);
    checked += 1;
  }
  return checked;
}

export function eventsOfType<T extends RunEvent["type"]>(
  events: RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}
