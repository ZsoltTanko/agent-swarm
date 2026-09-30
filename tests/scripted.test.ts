import { describe, expect, it } from "vitest";
import { firstDifference } from "../src/shared/compare.ts";
import { EnvironmentConfigSchema } from "../src/shared/config.ts";
import type { RunEvent } from "../src/shared/events.ts";
import type { ChatMessage } from "../src/shared/types.ts";
import { createScriptedModelClient, scriptedResult } from "../src/harness/scripted.ts";
import { buildTools } from "../src/harness/tools.ts";
import type { ModelRequest } from "../src/harness/types.ts";
import { eventsOfType, expectContextsMatchLog } from "./helpers/fixtures.ts";
import { runScripted, SMALL_CORPUS } from "./helpers/scripted-run.ts";

function firstRequest(name: string): ModelRequest {
  const messages: ChatMessage[] = [
    { role: "system", content: `You are ${name}. You are one of several agents.\n\nYou can open at most 2 of them yourself.` },
    { role: "user", content: "Check the board and introduce yourself before you start." },
  ];
  return {
    model: "deepseek/deepseek-v4-flash",
    params: { max_tokens: 1000, temperature: 0.7 },
    messages,
    tools: buildTools(EnvironmentConfigSchema.parse({ doc_read_budget: 2 })),
  };
}

const toolsCalled = (events: RunEvent[], agent: string): string[] =>
  eventsOfType(events, "tool_call")
    .filter((event) => event.agent === agent)
    .map((event) => event.name);

describe("scriptedResult", () => {
  it("is a pure function of the request, not of the call context", async () => {
    const client = createScriptedModelClient();
    const request = firstRequest("Heron");
    const a = await client.call(request, { agent: "Heron", tick: 1, seed: 1 });
    const b = await client.call(structuredClone(request), { agent: "Heron", tick: 9, seed: 42 });
    expect(b).toEqual(a);

    // Key order doesn't matter; content does.
    const reordered: ModelRequest = { tools: request.tools, messages: request.messages, params: { temperature: 0.7, max_tokens: 1000 }, model: request.model };
    expect(scriptedResult(reordered).cache_key).toBe(a.cache_key);
    expect(scriptedResult(firstRequest("Otter")).cache_key).not.toBe(a.cache_key);
  });

  it("starts by reading the board and listing documents, with a realistic result record", () => {
    const request = firstRequest("Heron");
    const result = scriptedResult(request);
    const calls = result.message.tool_calls ?? [];
    expect(calls.map((call) => [call.function.name, call.function.arguments])).toEqual([
      ["read_board", "{}"],
      ["list_documents", "{}"],
    ]);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    for (const call of calls) expect(call).toMatchObject({ type: "function", id: expect.stringMatching(/^call_[0-9a-f]{24}$/) });

    const reasoning = result.message.reasoning;
    expect(typeof reasoning).toBe("string");
    expect(result.message.reasoning_details).toEqual([{ type: "reasoning.text", text: reasoning, format: "unknown", index: 0 }]);
    expect(result).toMatchObject({
      finish_reason: "tool_calls",
      native_finish_reason: "tool_calls",
      truncated: false,
      provider: "Scripted",
      cache_hit: false,
      openrouter_metadata: null,
    });

    expect(result.cache_key).toMatch(/^[0-9a-f]{64}$/);
    expect(result.generation_id).toBe(`gen-scripted-${result.cache_key.slice(0, 24)}`);
    expect(result.latency_ms).toBeGreaterThanOrEqual(600);
    expect(result.latency_ms).toBeLessThanOrEqual(1000);
    expect(result.attempts).toBe(1);

    const promptChars = JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
    const { usage } = result;
    expect(usage.prompt_tokens).toBe(Math.ceil(promptChars / 4));
    expect(usage.reasoning_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(usage.reasoning_tokens);
    expect(usage.cached_tokens).toBe(0);
    expect(usage.cost_usd).toBeCloseTo((usage.prompt_tokens * 0.06 + usage.completion_tokens * 0.12) / 1e6, 12);
  });
});

describe("a scripted run", () => {
  it("drives three agents through a complete, realistic run to all_done", async () => {
    const names = ["Heron", "Otter", "Wren"];
    const { events, outcome, requests } = await runScripted(names);
    expect(outcome.reason).toBe("all_done");
    expect(expectContextsMatchLog(events, requests)).toBe(outcome.totals.model_calls);

    const posts = eventsOfType(events, "post_created").map((event) => event.post);
    // Everyone introduces themselves and claims a range of documents; some claims overlap.
    const intros = posts.filter((post) => post.text.startsWith(`Hi, I'm ${post.author}.`));
    expect(intros.map((post) => post.author).sort()).toEqual([...names].sort());
    const claimed = intros.flatMap((post) => [...post.text.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
    expect(new Set(claimed).size).toBeLessThan(claimed.length);

    // Documents are read within budget, and each agent tries one more.
    const opens = eventsOfType(events, "document_opened");
    for (const name of names) {
      expect(opens.filter((event) => event.agent === name && event.first_open)).toHaveLength(2);
    }
    const overBudget = eventsOfType(events, "tool_call").filter((event) => event.error === "You've used all 2 of your document reads.");
    expect(overBudget.map((event) => event.agent).sort()).toEqual([...names].sort());

    // Notes quote a sentence from each document the author read.
    const notes = posts.filter((post) => post.text.startsWith("Notes on "));
    expect(notes).toHaveLength(3);
    for (const note of notes) {
      const quoted = [...note.text.matchAll(/^- `([^`]+)` \(".*?"\): "(.*)"$/gm)];
      expect(quoted.length).toBeGreaterThan(0);
      for (const [, id, quote] of quoted) {
        expect(SMALL_CORPUS.find((doc) => doc.id === id)!.text).toContain(quote);
      }
    }
    expect(posts.some((post) => post.reply_to !== null)).toBe(true);

    // One agent drafts; the others extend it, at least once overwriting a version they hadn't seen.
    const versions = eventsOfType(events, "deliverable_written").map((event) => event.version);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0]!.text.startsWith("# Working draft")).toBe(true);
    expect(versions.some((version) => !version.writer_had_seen_replaced)).toBe(true);
    expect(new Set(versions.map((version) => version.author)).size).toBe(3);
    for (const name of names.filter((name) => name !== versions[0]!.author)) {
      expect(outcome.finalDeliverable).toContain(`## Notes from ${name}`);
    }

    // Sleeping and waking, the occasional malformed call, and done for everyone.
    expect(eventsOfType(events, "agent_slept").length).toBeGreaterThan(0);
    expect(eventsOfType(events, "agent_woke").length).toBeGreaterThan(0);
    expect(eventsOfType(events, "tool_call").some((event) => event.error === "Arguments aren't valid JSON.")).toBe(true);
    expect(eventsOfType(events, "agent_done").map((event) => event.agent).sort()).toEqual([...names].sort());
    for (const name of names) expect(toolsCalled(events, name).at(-1)).toBe("done");

    const calls = eventsOfType(events, "model_call");
    expect(calls.some((call) => (call.message.content ?? "") !== "")).toBe(true);
    expect(calls.some((call) => call.finish_reason === "stop")).toBe(true);
    expect(outcome.totals.usage.cost_usd).toBeGreaterThan(0);
  });

  it("is deterministic across runs", async () => {
    const [a, b] = [await runScripted(["Heron", "Otter", "Wren"]), await runScripted(["Heron", "Otter", "Wren"])];
    expect(firstDifference(a.events, b.events)).toBeNull();
    expect(b.outcome).toEqual(a.outcome);
  });

  it("handles a larger team, unknown tools included", async () => {
    const names = ["Lynx", "Moth", "Finch", "Marten", "Ibis"];
    const { events, outcome, requests } = await runScripted(names, { environment: { doc_read_budget: 3 } });
    expect(outcome.reason).toBe("all_done");
    expectContextsMatchLog(events, requests);
    const errors = eventsOfType(events, "tool_call").map((event) => event.error);
    expect(errors).toContain('Unknown tool "search_documents".');
    expect(errors).toContain("Arguments aren't valid JSON.");
    expect(eventsOfType(events, "deliverable_written").length).toBeGreaterThanOrEqual(names.length);
  });

  it("works alone, without a status line, and under a tight tick cap", async () => {
    const solo = await runScripted(["Heron"]);
    expect(solo.outcome.reason).toBe("all_done");
    expect(solo.outcome.totals.deliverable_versions).toBe(1);

    const quiet = await runScripted(["Heron", "Otter", "Wren"], { environment: { status_line: false } });
    expect(quiet.outcome.reason).toBe("all_done");
    expectContextsMatchLog(quiet.events, quiet.requests);

    const short = await runScripted(["Heron", "Otter", "Wren"], { run: { tick_cap: 6 } });
    expect(["all_done", "tick_cap"]).toContain(short.outcome.reason);
    expect(short.outcome.totals.ticks).toBeLessThanOrEqual(6);
    // With the clock in the status line, agents stop by the last step.
    expect(eventsOfType(short.events, "agent_done")).toHaveLength(3);
  });
});
