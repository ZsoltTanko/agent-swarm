import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { readEvents } from "../src/harness/eventlog.ts";
import type { ModelRequest } from "../src/harness/types.ts";

/**
 * The scripted model, except that its fifth call sends the CLI a Ctrl-C (by calling the SIGINT listener
 * the CLI registered last, so the test runner's own listeners aren't triggered).
 */
vi.mock("../src/harness/scripted.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/harness/scripted.ts")>();
  let calls = 0;
  return {
    ...original,
    createScriptedModelClient: () => ({
      async call(request: ModelRequest) {
        calls += 1;
        if (calls === 5) process.listeners("SIGINT").at(-1)?.("SIGINT");
        return original.scriptedResult(request);
      },
    }),
  };
});

const { main } = await import("../src/harness/cli.ts");

const tmp = mkdtempSync(join(tmpdir(), "swarm-cli-interrupt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

it("exits 130 when a run is interrupted, so shell chains stop", async () => {
  const task = join(tmp, "task");
  mkdirSync(join(task, "docs"), { recursive: true });
  writeFileSync(join(task, "task.md"), "Summarize the documents.\n");
  writeFileSync(join(task, "docs", "a.md"), "# A\n\nThe alpha site opened in 2019 after a long delay.\n");
  writeFileSync(join(task, "docs", "b.md"), "# B\n\nThe beta site closed in 2021 after a long decline.\n");
  const config = join(tmp, "config.yaml");
  writeFileSync(
    config,
    `task: ${task}\nagents:\n  count: 2\n  model:\n    id: scripted/model\n` +
      `environment:\n  doc_read_budget: 1\n  prompt_template: ${resolve("prompts/swarm.md")}\nrun:\n  tick_cap: 20\n`,
  );
  const output: string[] = [];
  const capture = (...args: unknown[]) => void output.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);

  const runsDir = join(tmp, "runs");
  const code = await main([config, "--scripted", "--runs-dir", runsDir]);
  vi.restoreAllMocks();

  expect(code).toBe(130);
  const [runId] = readdirSync(runsDir);
  const events = readEvents(join(runsDir, runId!, "events.jsonl"));
  expect(events.at(-1)).toMatchObject({ type: "run_ended", reason: "interrupted", tick: 3 });
  expect(output).toContain("\nRun ended: interrupted after 3 ticks");
  expect(process.listeners("SIGINT").some((listener) => listener.name === "onSigint")).toBe(false);
});
