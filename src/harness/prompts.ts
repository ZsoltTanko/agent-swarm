import type { RunConfig } from "../shared/config.ts";
import type { AgentInfo } from "../shared/types.ts";
import { ConfigError } from "./config.ts";
import { countOf } from "./tools.ts";
import type { LoadedTask } from "./types.ts";

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * Replaces {identifier} placeholders in one pass, so substituted text (the task, say) is never re-scanned
 * and braces in it survive. A placeholder without a value is an error; unused vars are fine.
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (match, key: string) => {
    if (!Object.hasOwn(vars, key)) {
      throw new ConfigError(
        `The prompt template uses ${match}, which has no value. Available: ${Object.keys(vars)
          .map((name) => `{${name}}`)
          .join(", ")}.`,
      );
    }
    return String(vars[key]);
  });
}

/** The system prompt for each agent, keyed by agent name. */
export function renderSystemPrompts(
  template: string,
  agents: AgentInfo[],
  task: LoadedTask,
  config: RunConfig,
): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const agent of agents) {
    prompts[agent.name] = renderTemplate(template, {
      name: agent.name,
      team: teamPhrase(agents, config.environment.roster_known),
      doc_count: task.docs.length,
      documents: countOf(task.docs.length, "document"),
      doc_read_budget: config.environment.doc_read_budget,
      tick_cap: config.run.tick_cap,
      task: task.text.trim(),
    });
  }
  return prompts;
}

/** "several agents", or with a known roster "5 agents (Heron, Otter, Wren, Lynx, Moth)". */
function teamPhrase(agents: AgentInfo[], rosterKnown: boolean): string {
  if (!rosterKnown) return "several agents";
  const noun = agents.length === 1 ? "agent" : "agents";
  return `${agents.length} ${noun} (${agents.map((agent) => agent.name).join(", ")})`;
}
