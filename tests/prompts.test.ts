import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunConfigSchema } from "../src/shared/config.ts";
import type { AgentInfo } from "../src/shared/types.ts";
import { ConfigError } from "../src/harness/config.ts";
import { renderSystemPrompts, renderTemplate } from "../src/harness/prompts.ts";
import type { LoadedTask } from "../src/harness/types.ts";

describe("renderTemplate", () => {
  it("substitutes placeholders and ignores unused vars", () => {
    expect(renderTemplate("Hi {name}, {doc_count} docs.", { name: "Wren", doc_count: 6, unused: "x" })).toBe(
      "Hi Wren, 6 docs.",
    );
  });

  it("throws on a placeholder without a value", () => {
    expect(() => renderTemplate("You are {name} on {team}.", { name: "Wren" })).toThrow(ConfigError);
    expect(() => renderTemplate("You are {name} on {team}.", { name: "Wren" })).toThrow(/\{team\}, which has no value/);
  });

  it("never re-scans substituted text, so braces in the task survive", () => {
    const task = "Fill in {name} and {team}; keep {{double}}, {Upper}, { spaced }, and $& $1 as written.";
    expect(renderTemplate("{name}: <task>{task}</task>", { name: "Moth", task })).toBe(`Moth: <task>${task}</task>`);
  });

  it("leaves brace text that isn't a lowercase identifier alone", () => {
    expect(renderTemplate("{Name} {x1} {} {a-b} {name}", { name: "Ibis" })).toBe("{Name} {x1} {} {a-b} Ibis");
  });
});

describe("renderSystemPrompts", () => {
  const template = readFileSync("prompts/swarm.md", "utf8");
  const task: LoadedTask = {
    name: "example",
    dir: "/tmp/example",
    text: "\n  Write a memo about {the topic}.\n\n",
    docs: ["a", "b", "c", "d", "e", "f"].map((id) => ({
      meta: { id, filename: `${id}.md`, title: id, words: 1, chars: 1, sha256: "" },
      text: id,
    })),
  };
  const agents: AgentInfo[] = ["Heron", "Otter", "Wren", "Lynx", "Moth"].map((name, index) => ({
    name,
    index,
    model: "some/model",
  }));

  function configWith(rosterKnown: boolean) {
    return RunConfigSchema.parse({
      task: "tasks/example",
      agents: { count: 5, model: { id: "some/model" } },
      environment: { doc_read_budget: 3, roster_known: rosterKnown },
      run: { tick_cap: 25 },
    });
  }

  it("renders one prompt per agent with the environment facts", () => {
    const prompts = renderSystemPrompts(template, agents, task, configWith(false));
    expect(Object.keys(prompts)).toEqual(["Heron", "Otter", "Wren", "Lynx", "Moth"]);
    const otter = prompts.Otter!;
    expect(otter).toMatch(/^You are Otter\. You are one of several agents who have all been given/);
    expect(otter).toContain("The task involves 6 documents. You can open at most 3 of them yourself.");
    expect(otter).toContain("The session lasts at most 25 steps.");
    expect(otter).toContain("<task>\nWrite a memo about {the topic}.\n</task>");
    expect(otter).not.toMatch(/\{[a-z_]+\}/);
  });

  it("names the team when the roster is known", () => {
    const prompts = renderSystemPrompts(template, agents, task, configWith(true));
    expect(prompts.Heron).toContain("You are one of 5 agents (Heron, Otter, Wren, Lynx, Moth) who have all been given");
  });

  it("uses the singular for a single document", () => {
    const single = { ...task, docs: task.docs.slice(0, 1) };
    const prompts = renderSystemPrompts(template, agents.slice(0, 1), single, configWith(false));
    expect(prompts.Heron).toContain("The task involves 1 document. You can open at most 3 of them yourself.");
  });

  it("uses the singular for a team of one", () => {
    const prompts = renderSystemPrompts("{team}", agents.slice(0, 1), task, configWith(true));
    expect(prompts).toEqual({ Heron: "1 agent (Heron)" });
  });
});
