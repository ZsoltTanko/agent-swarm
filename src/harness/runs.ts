import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { RunConfig } from "../shared/config.ts";

/** "<task>-<YYYYMMDD-HHMMSS in UTC>-s<seed>". Characters that don't belong in a folder name or URL become "-". */
export function makeRunId(taskName: string, seed: number, now: Date): string {
  const safeName = taskName.replace(/[^A-Za-z0-9._-]+/g, "-") || "task";
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replaceAll("-", "");
  const time = iso.slice(11, 19).replaceAll(":", "");
  return `${safeName}-${date}-${time}-s${seed}`;
}

/** Creates runsDir/<runId>, or runsDir/<runId>-2, -3, ... if that already exists. */
export function createRunDir(runsDir: string, runId: string): { dir: string; runId: string } {
  mkdirSync(runsDir, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const id = attempt === 1 ? runId : `${runId}-${attempt}`;
    const dir = join(runsDir, id);
    try {
      mkdirSync(dir);
      return { dir, runId: id };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Writes the resolved config as YAML that the CLI accepts as-is. `rerunFlag` is how to re-run it exactly:
 * --offline replays the response cache, which scripted runs don't use, so they re-run with --scripted.
 */
export function writeResolvedConfig(
  path: string,
  config: RunConfig,
  runId: string,
  rerunFlag: "--offline" | "--scripted",
): void {
  const header =
    `# Resolved config for run ${runId}. Re-run it exactly with: npm run swarm -- ${path} ${rerunFlag}\n` +
    "# task and prompt_template are relative to this file's folder.\n";
  writeFileSync(path, header + stringify(config));
}
