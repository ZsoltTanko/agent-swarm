import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, withSeed } from "../src/harness/config.ts";

const tmp = mkdtempSync(join(tmpdir(), "swarm-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let fileCount = 0;
function configFile(yaml: string): string {
  const path = join(tmp, `config-${++fileCount}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

function loadError(path: string): string {
  try {
    loadConfig(path);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected loadConfig to throw");
}

const MINIMAL = `
task: tasks/example
agents:
  count: 3
  model:
    id: deepseek/deepseek-v4-flash
`;

describe("loadConfig: agent names", () => {
  const withNames = (names: string) => `${MINIMAL}`.replace("  count: 3\n", `  count: 3\n  names: ${names}\n`);

  it("accepts one distinct capitalized name per agent", () => {
    expect(loadConfig(configFile(withNames("[Ada, Basil, Clover]"))).agents.names).toEqual(["Ada", "Basil", "Clover"]);
  });

  it("rejects a wrong number of names, duplicates, and names that aren't one capitalized word", () => {
    expect(loadError(configFile(withNames("[Ada, Basil]")))).toContain("agents.names: names must list exactly count names");
    expect(loadError(configFile(withNames("[Ada, Ada, Basil]")))).toContain("agents.names: names must be distinct");
    expect(loadError(configFile(withNames("[Ada, basil, Clover]")))).toContain("must be one capitalized word");
    expect(loadError(configFile(withNames("[Ada, Mary Ann, Clover]")))).toContain("must be one capitalized word");
  });
});

describe("loadConfig", () => {
  it("fills in defaults for a minimal config", () => {
    const config = loadConfig(configFile(MINIMAL));
    expect(config.agents).toEqual({ count: 3, model: { id: "deepseek/deepseek-v4-flash", params: {} } });
    expect(config.environment.doc_read_budget).toBe(4);
    expect(config.environment.prompt_template).toBe("prompts/swarm.md");
    expect(config.run.seed).toBe(1);
    expect(config.run.tick_cap).toBe(40);
    expect(config).not.toHaveProperty("task_name");
  });

  it("accepts an optional task_name", () => {
    expect(loadConfig(configFile(`${MINIMAL}task_name: example\n`)).task_name).toBe("example");
    expect(loadError(configFile(`${MINIMAL}task_name: ""\n`))).toContain("task_name:");
  });

  it("loads the shipped configs", () => {
    const baseline = loadConfig("configs/baseline.yaml");
    expect(baseline.agents.model.params).toEqual({
      reasoning: { effort: "high" },
      temperature: 0.7,
      max_tokens: 16000,
      provider: { order: ["streamlake/fp8"] },
    });
    expect(baseline.environment.doc_read_budget).toBe(3);
    expect(loadConfig("configs/smoke.yaml").run.tick_cap).toBe(8);
  });

  it("names the file and suggests the intended key for a typo", () => {
    const path = configFile(`${MINIMAL}run:\n  tik_cap: 10\n`);
    const message = loadError(path);
    expect(message).toContain(path);
    expect(message).toContain(`run.tik_cap: unknown key (did you mean "tick_cap"?)`);
  });

  it("lists the allowed keys when an unknown key resembles none of them", () => {
    const message = loadError(configFile(`${MINIMAL}environment:\n  zzzzzzzzzzzz: true\n`));
    expect(message).toMatch(/environment\.zzzzzzzzzzzz: unknown key \(expected one of: doc_read_budget, .*prompt_template\)/);
  });

  it("reports missing fields by key path", () => {
    const message = loadError(configFile("agents:\n  model:\n    id: some/model\n"));
    expect(message).toContain("task: missing (expected string)");
    expect(message).toContain("agents.count: missing (expected number)");
  });

  it("reports every problem at once", () => {
    const message = loadError(
      configFile(`${MINIMAL}run:\n  seed: -1\n  tick_cap: "forty"\nextra: 1\n`),
    );
    expect(message).toContain("run.seed:");
    expect(message).toContain("run.tick_cap:");
    expect(message).toContain("extra: unknown key");
    expect(message.split("\n  - ")).toHaveLength(4);
  });

  it("rejects params the harness owns", () => {
    const message = loadError(
      configFile(`${MINIMAL}    params:\n      model: other/model\n      stream: true\n      temperature: 0.5\n`),
    );
    expect(message).toContain("agents.model.params.model: set by the harness");
    expect(message).toContain("agents.model.params.stream: set by the harness");
    expect(message).not.toContain("temperature");
  });

  it("reports owned params alongside schema problems", () => {
    const message = loadError(configFile(`task: x\nagents:\n  model:\n    id: m\n    params:\n      tools: []\n`));
    expect(message).toContain("agents.count: missing");
    expect(message).toContain("agents.model.params.tools: set by the harness");
  });

  it("passes other params through verbatim", () => {
    const config = loadConfig(
      configFile(`${MINIMAL}    params:\n      provider: { order: [baidu/fp8], sort: price }\n      top_k: 40\n`),
    );
    expect(config.agents.model.params).toEqual({ provider: { order: ["baidu/fp8"], sort: "price" }, top_k: 40 });
  });

  it("rejects a file that isn't a mapping", () => {
    expect(loadError(configFile(""))).toContain("must be a YAML mapping");
    expect(loadError(configFile("- a\n- b\n"))).toContain("must be a YAML mapping");
  });

  it("rejects invalid YAML and missing files with the path", () => {
    const bad = configFile("task: [unclosed\n");
    expect(loadError(bad)).toContain(`Config ${bad} is not valid YAML`);
    const missing = join(tmp, "nope.yaml");
    expect(loadError(missing)).toContain(`Cannot read config ${missing}`);
  });
});

describe("withSeed", () => {
  it("returns a copy with the seed replaced", () => {
    const config = loadConfig(configFile(MINIMAL));
    const seeded = withSeed(config, 7);
    expect(seeded.run.seed).toBe(7);
    expect(seeded.run.tick_cap).toBe(config.run.tick_cap);
    expect(config.run.seed).toBe(1);
  });

  it("rejects seeds the schema wouldn't accept", () => {
    const config = loadConfig(configFile(MINIMAL));
    expect(() => withSeed(config, -1)).toThrow(ConfigError);
    expect(() => withSeed(config, 1.5)).toThrow(ConfigError);
  });
});
