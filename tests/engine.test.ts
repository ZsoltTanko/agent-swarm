import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstDifference, normalizeForComparison } from "../src/shared/compare.ts";
import type { ToolCall } from "../src/shared/types.ts";
import { ModelCallError } from "../src/harness/types.ts";
import type { ModelClient } from "../src/harness/types.ts";
import { runSwarm } from "../src/harness/engine.ts";
import { createEventLog } from "../src/harness/eventlog.ts";
import { createOpenRouterModelClient } from "../src/harness/openrouter/client.ts";
import { buildTools } from "../src/harness/tools.ts";
import { capturing, createFakeModel, tc } from "./helpers/fake-model.ts";
import type { FakeStep } from "./helpers/fake-model.ts";
import {
  eventsOfType,
  expectContextsMatchLog,
  makeAgents,
  makeConfig,
  makeTask,
  runScenario,
  systemPromptsFor,
  tempLogPath,
  THREE_DOCS,
} from "./helpers/fixtures.ts";

const repeat = (step: FakeStep, times: number): FakeStep[] => Array.from({ length: times }, () => step);

/**
 * A fake OpenRouter endpoint for the real client: `respond` gets the agent (from "You are <name>." in the
 * system prompt, else "?"), how many requests that agent has made before, and the request body.
 */
function openRouterFake(
  respond: (agent: string, n: number, body: { messages: unknown[] }) => { status: number; body: unknown },
) {
  const counts = new Map<string, number>();
  let requests = 0;
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests += 1;
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const agent = /^You are (\w+)\./.exec(body.messages[0]!.content)?.[1] ?? "?";
    const n = counts.get(agent) ?? 0;
    counts.set(agent, n + 1);
    const response = respond(agent, n, body);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, requests: () => requests };
}

/** A chat completion with one tool call. */
function toolCompletion(id: string, [name, args]: [string, Record<string, unknown>]): Record<string, unknown> {
  const toolCalls = [{ id: `${id}-0`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
  return {
    id,
    provider: "Fake",
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: toolCalls } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
  };
}

function openRouterClient(cacheDir: string, fetchImpl: typeof fetch, offline: boolean): ModelClient {
  return createOpenRouterModelClient({
    apiKey: offline ? null : "test-key",
    cacheDir,
    offline,
    timeoutMs: 5_000,
    maxRetries: 0,
    fetchImpl,
  });
}

describe("runSwarm: logging and contexts", () => {
  it("starts with run_started, logs each step in order, and keeps contexts equal to the rebuilt ones", async () => {
    const { client, requests } = createFakeModel({
      Heron: [
        { content: "Hello.", calls: [tc("read_board"), tc("post_message", { text: "hi" })] },
        [tc("read_document", { id: "d1" }), tc("write_deliverable", { text: "draft" })],
        [tc("done", { note: "ok" })],
      ],
      Otter: [[tc("list_documents")], { content: "Thinking.", calls: [tc("read_board")] }, [tc("done")]],
    });
    const { outcome, events, summaries, config } = await runScenario({ names: ["Heron", "Otter"], model: client });

    const started = events[0]!;
    expect(started).toMatchObject({
      seq: 0,
      tick: 0,
      type: "run_started",
      run_id: "test-run",
      seed: 1,
      kickoff: "Go.",
      mode: "scripted",
      model_info: null,
    });
    if (started.type !== "run_started") throw new Error("expected run_started");
    expect(started.config).toEqual(config);
    expect(started.agents.map((agent) => agent.name)).toEqual(["Heron", "Otter"]);
    expect(started.task.docs.map((doc) => doc.id)).toEqual(["d1", "d2", "d3"]);
    expect(Object.keys(started.system_prompts)).toEqual(["Heron", "Otter"]);
    expect(started.tools).toEqual(buildTools(config.environment));
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));

    // Per step: model_call, then each tool call's domain events followed by its tool_call.
    const tick1 = eventsOfType(events, "tick_started")[0]!;
    expect(tick1).toMatchObject({ tick: 1, active: ["Heron", "Otter"], asleep: [], finished: [] });
    const heronStep = events.filter((event) => event.tick === 1 && "agent" in event && event.agent === "Heron");
    expect(heronStep.map((event) => event.type)).toEqual(["model_call", "board_delivered", "tool_call", "tool_call"]);
    const postEvent = events.find((event) => event.type === "post_created")!;
    expect(postEvent.seq).toBe(heronStep[3]!.seq - 1);

    const heronCall = eventsOfType(events, "model_call").find((event) => event.agent === "Heron" && event.tick === 1)!;
    expect(heronCall).toMatchObject({
      order_index: tick1.order.indexOf("Heron"),
      cache_key: "key-Heron-0",
      cache_hit: false,
      finish_reason: "tool_calls",
      provider: "Fake",
      generation_id: "gen-Heron-0",
      latency_ms: 10,
      request_messages: 2,
    });
    expect(heronCall.message.content).toBe("Hello.");

    expect(expectContextsMatchLog(events, requests)).toBe(6);
    expect(requests[0]!.request).toMatchObject({ model: "test/model", params: { max_tokens: 1000 } });
    expect(requests[0]!.request.messages).toEqual([
      { role: "system", content: expect.stringContaining("You are Heron.") },
      { role: "user", content: "Go." },
    ]);
    expect(requests[0]!.request.tools).toEqual(started.tools);

    expect(outcome).toMatchObject({ reason: "all_done", error: null, finalDeliverable: "draft" });
    expect(outcome.totals).toEqual({
      ticks: 3,
      model_calls: 6,
      cache_hits: 0,
      usage: { prompt_tokens: 600, completion_tokens: 120, reasoning_tokens: 30, cached_tokens: 0, cost_usd: expect.closeTo(0.006, 10) },
      posts: 1,
      deliverable_versions: 1,
    });
    const ended = events.at(-1)!;
    expect(ended).toMatchObject({ type: "run_ended", tick: 3, reason: "all_done", error: null, totals: outcome.totals });

    expect(summaries.map((summary) => summary.tick)).toEqual([1, 2, 3]);
    expect(summaries[0]).toMatchObject({ active: 2, posts: 1, doc_opens: 0, writes: 0, asleep: 0, finished: 0 });
  });

  it("applies effects in the tick's order: an earlier agent's post reaches a later agent's read, not the reverse", async () => {
    const step = (text: string): FakeStep[] => [[tc("post_message", { text }), tc("read_board")], [tc("done")]];
    const { client, requests } = createFakeModel({ Heron: step("from Heron"), Otter: step("from Otter"), Wren: step("from Wren") });
    const { events } = await runScenario({ names: ["Heron", "Otter", "Wren"], model: client });

    const order = eventsOfType(events, "tick_started")[0]!.order;
    const postIdOf = new Map(eventsOfType(events, "post_created").map((event) => [event.post.author, event.post.id]));
    const delivered = new Map(
      eventsOfType(events, "board_delivered")
        .filter((event) => event.tick === 1)
        .map((event) => [event.agent, event.post_ids]),
    );
    order.forEach((agent, index) => {
      expect(postIdOf.get(agent)).toBe(index + 1);
      expect(delivered.get(agent)).toEqual(order.slice(0, index).map((earlier) => postIdOf.get(earlier)));
    });
    // At tick 2 each agent's board holds the posts made after its own read at tick 1 (by later agents).
    expectContextsMatchLog(events, requests);
  });

  it("gives identical events for the same seed and different tick orders for a different seed", async () => {
    const names = ["Heron", "Otter", "Wren", "Lynx", "Moth"];
    const script = (): Record<string, FakeStep[]> =>
      Object.fromEntries(
        names.map((name) => [
          name,
          [
            [tc("post_message", { text: `${name} here` }), tc("read_board")],
            [tc("read_board"), tc("write_deliverable", { text: `${name}'s version` })],
            [tc("read_board")],
            [tc("done")],
          ],
        ]),
      );
    const run = async (seed: number) =>
      (await runScenario({ names, model: createFakeModel(script()).client, config: { run: { seed } } })).events;

    const [a, b, c] = [await run(7), await run(7), await run(8)];
    expect(normalizeForComparison(a)).toEqual(normalizeForComparison(b));
    expect(firstDifference(a, b)).toBeNull();
    const orders = (events: typeof a) => eventsOfType(events, "tick_started").map((event) => event.order);
    expect(orders(a)).toEqual(orders(b));
    expect(orders(a)).not.toEqual(orders(c));
    expect(orders(a)).toHaveLength(4);
  });

  it("keeps at most max_concurrency calls in flight", async () => {
    const names = ["Heron", "Otter", "Wren", "Lynx", "Moth"];
    const { client: inner } = createFakeModel(Object.fromEntries(names.map((name) => [name, [[tc("done")]]])));
    let inFlight = 0;
    let peak = 0;
    const client: ModelClient = {
      async call(request, context) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return inner.call(request, context);
      },
    };
    const { outcome } = await runScenario({ names, model: client, config: { run: { max_concurrency: 2 } } });
    expect(outcome.reason).toBe("all_done");
    expect(peak).toBe(2);
  });

  it("requires a system prompt for every agent", async () => {
    const task = makeTask(THREE_DOCS);
    const config = makeConfig({ count: 2 });
    const agents = makeAgents(["Heron", "Otter"]);
    const prompts = systemPromptsFor(agents, task, config);
    delete prompts.Otter;
    await expect(
      runSwarm({
        runId: "r",
        config,
        task,
        agents,
        systemPrompts: prompts,
        kickoff: "Go.",
        tools: buildTools(config.environment),
        model: createFakeModel({}).client,
        log: createEventLog(tempLogPath()),
        mode: "scripted",
        modelInfo: null,
      }),
    ).rejects.toThrow(/Otter/);
  });

  it("records the run's mode in run_started", async () => {
    for (const mode of ["live", "offline", "scripted"] as const) {
      const { client } = createFakeModel({ Heron: [[tc("done")]] });
      const { events } = await runScenario({ names: ["Heron"], model: client, mode });
      expect(events[0]).toMatchObject({ type: "run_started", mode });
    }
  });
});

describe("runSwarm: world rules through the engine", () => {
  it("spends document reads on first opens only, errors over budget, and re-opens for free", async () => {
    const { client, requests } = createFakeModel({
      Heron: [
        [tc("read_document", { id: "d1" }), tc("read_document", { id: "d2" })],
        [tc("read_document", { id: "d3" }), tc("read_document", { id: "d1" })],
        [tc("done")],
      ],
    });
    const { events, summaries } = await runScenario({ names: ["Heron"], model: client });

    expect(eventsOfType(events, "document_opened").map(({ doc_id, first_open, reads_left, tick }) => ({ doc_id, first_open, reads_left, tick }))).toEqual([
      { doc_id: "d1", first_open: true, reads_left: 1, tick: 1 },
      { doc_id: "d2", first_open: true, reads_left: 0, tick: 1 },
      { doc_id: "d1", first_open: false, reads_left: 0, tick: 2 },
    ]);
    const tick2 = eventsOfType(events, "tool_call").filter((event) => event.tick === 2);
    expect(tick2[0]).toMatchObject({
      name: "read_document",
      arguments: { id: "d3" },
      result: "You've used all 2 of your document reads.",
      error: "You've used all 2 of your document reads.",
    });
    expect(tick2[1]!.result).toMatch(/^d1 · "First" · 11 words\n\nAlpha one\./);
    expect(tick2[1]!.result.endsWith("\n\n[step 2/10 · 0 unread posts · 0 document reads left]")).toBe(true);
    expect(summaries.map((summary) => summary.doc_opens)).toEqual([2, 0, 0]);
    expectContextsMatchLog(events, requests);
  });

  it("records deliverable versions with replaced author and seen/unseen/own overwrites", async () => {
    const idle = [tc("read_board")];
    const { client, requests } = createFakeModel({
      Heron: [[tc("write_deliverable", { text: "H1" })], idle, idle, idle, idle, [tc("write_deliverable", { text: "H6" })], [tc("done")]],
      Otter: [idle, [tc("read_deliverable")], [tc("write_deliverable", { text: "O3" })], idle, idle, idle, [tc("done")]],
      Wren: [idle, idle, idle, [tc("write_deliverable", { text: "W4" })], [tc("write_deliverable", { text: "W5" })], idle, [tc("done")]],
    });
    const { events, outcome, summaries } = await runScenario({ names: ["Heron", "Otter", "Wren"], model: client });

    const versions = eventsOfType(events, "deliverable_written").map((event) => event.version);
    expect(versions.map(({ version, author, tick, replaced_version, replaced_author, writer_had_seen_replaced }) => ({
      version,
      author,
      tick,
      replaced_version,
      replaced_author,
      writer_had_seen_replaced,
    }))).toEqual([
      { version: 1, author: "Heron", tick: 1, replaced_version: 0, replaced_author: null, writer_had_seen_replaced: true },
      { version: 2, author: "Otter", tick: 3, replaced_version: 1, replaced_author: "Heron", writer_had_seen_replaced: true },
      { version: 3, author: "Wren", tick: 4, replaced_version: 2, replaced_author: "Otter", writer_had_seen_replaced: false },
      { version: 4, author: "Wren", tick: 5, replaced_version: 3, replaced_author: "Wren", writer_had_seen_replaced: true },
      { version: 5, author: "Heron", tick: 6, replaced_version: 4, replaced_author: "Wren", writer_had_seen_replaced: false },
    ]);
    const writeResults = eventsOfType(events, "tool_call")
      .filter((event) => event.name === "write_deliverable")
      .map((event) => event.result.split("\n\n")[0]);
    expect(writeResults).toEqual([
      "Saved as v1; replaced the empty deliverable.",
      "Saved as v2; replaced v1, written by Heron at step 1.",
      "Saved as v3; replaced v2, written by Otter at step 3.",
      "Saved as v4; replaced v3, which you wrote at step 4.",
      "Saved as v5; replaced v4, written by Wren at step 5.",
    ]);
    expect(eventsOfType(events, "deliverable_read")).toMatchObject([{ agent: "Otter", version: 1, tick: 2 }]);
    expect(outcome.finalDeliverable).toBe("H6");
    expect(outcome.totals.deliverable_versions).toBe(5);
    expect(summaries.map((summary) => summary.writes)).toEqual([1, 0, 1, 1, 1, 1, 0]);
    expectContextsMatchLog(events, requests);
  });

  it("puts an agent with no tool calls to sleep and wakes it only for a newer post by another agent", async () => {
    const idle = [tc("read_board")];
    const { client, requests } = createFakeModel({
      // Heron sleeps at tick 2, after Otter's post #1 at tick 1: that post must not wake it.
      Heron: [idle, { content: "Waiting." }, [tc("read_board")], [tc("done")]],
      Otter: [[tc("post_message", { text: "first" })], idle, idle, [tc("post_message", { text: "second" })], [tc("done")]],
      Wren: [idle, idle, idle, idle, [tc("done")]],
    });
    const { events, outcome, summaries } = await runScenario({ names: ["Heron", "Otter", "Wren"], model: client });

    expect(eventsOfType(events, "agent_slept")).toMatchObject([{ tick: 2, agent: "Heron" }]);
    const ticks = eventsOfType(events, "tick_started");
    expect(ticks[2]).toMatchObject({ tick: 3, active: ["Otter", "Wren"], asleep: ["Heron"] });
    expect(ticks[3]).toMatchObject({ tick: 4, active: ["Otter", "Wren"], asleep: ["Heron"] });
    expect(ticks[4]).toMatchObject({ tick: 5, active: ["Heron", "Otter", "Wren"], asleep: [] });
    expect(requests.filter((request) => request.agent === "Heron").map((request) => request.tick)).toEqual([1, 2, 5, 6]);

    const woke = eventsOfType(events, "agent_woke");
    expect(woke).toEqual([
      expect.objectContaining({ tick: 4, agent: "Heron", message: "[step 4/10 · 1 unread post · 2 document reads left]" }),
    ]);
    const lastOfTick4 = events.filter((event) => event.tick === 4).at(-1)!;
    expect(lastOfTick4.type).toBe("agent_woke");
    const heronAt5 = requests.find((request) => request.agent === "Heron" && request.tick === 5)!;
    expect(heronAt5.request.messages.at(-1)).toEqual({ role: "user", content: woke[0]!.message });
    expect(summaries[1]).toMatchObject({ tick: 2, asleep: 1 });
    expect(outcome.reason).toBe("all_done");
    expectContextsMatchLog(events, requests);
  });

  it("wakes a sleeper for a post made in the same tick, whatever the order", async () => {
    const { client, requests } = createFakeModel({
      Heron: [{ content: "Nothing to do." }, [tc("read_board")], [tc("done")]],
      Otter: [[tc("post_message", { text: "news" })], [tc("read_board")], [tc("done")]],
    });
    const { events } = await runScenario({ names: ["Heron", "Otter"], model: client, config: { environment: { status_line: false } } });
    expect(eventsOfType(events, "agent_slept")).toMatchObject([{ tick: 1, agent: "Heron" }]);
    expect(eventsOfType(events, "agent_woke")).toEqual([expect.objectContaining({ tick: 1, agent: "Heron", message: "[step 1/10]" })]);
    expect(eventsOfType(events, "tick_started")[1]).toMatchObject({ active: ["Heron", "Otter"] });
    expectContextsMatchLog(events, requests);
  });

  it("wakes a sleeper for a post made after its previous step, in an earlier tick", async () => {
    const { client, requests } = createFakeModel({
      // Otter posts #1 at tick 1 after Heron's step; Heron sleeps at tick 2 without having heard of it.
      Heron: [[tc("read_board")], { content: "Nothing new." }, [tc("read_board")], [tc("done")]],
      Otter: [[tc("post_message", { text: "news" })], [tc("list_documents")], [tc("done")]],
    });
    const { events, outcome } = await runScenario({ names: ["Heron", "Otter"], model: client });
    expect(eventsOfType(events, "tick_started")[0]!.order).toEqual(["Heron", "Otter"]);
    expect(eventsOfType(events, "board_delivered")[0]).toMatchObject({ tick: 1, agent: "Heron", post_ids: [] });

    expect(eventsOfType(events, "agent_slept")).toMatchObject([{ tick: 2, agent: "Heron" }]);
    expect(eventsOfType(events, "post_created").map((event) => event.tick)).toEqual([1]);
    expect(eventsOfType(events, "agent_woke")).toEqual([
      expect.objectContaining({ tick: 2, agent: "Heron", message: "[step 2/10 · 1 unread post · 2 document reads left]" }),
    ]);
    expect(eventsOfType(events, "board_delivered").filter((event) => event.agent === "Heron").at(-1)).toMatchObject({
      tick: 3,
      post_ids: [1],
    });
    expect(outcome.reason).toBe("all_done");
    expectContextsMatchLog(events, requests);
  });

  it("measures a woken agent's marker from its wake, so it sleeps on when nothing newer arrives", async () => {
    const { client, requests } = createFakeModel({
      Heron: [{ content: "Idle." }, { content: "Still idle." }],
      Otter: [[tc("post_message", { text: "one" })], [tc("read_board")], [tc("read_board")], [tc("done")]],
    });
    const { events, outcome } = await runScenario({ names: ["Heron", "Otter"], model: client });
    expect(eventsOfType(events, "agent_slept").map(({ tick, agent }) => ({ tick, agent }))).toEqual([
      { tick: 1, agent: "Heron" },
      { tick: 2, agent: "Heron" },
    ]);
    expect(eventsOfType(events, "agent_woke").map(({ tick, agent }) => ({ tick, agent }))).toEqual([{ tick: 1, agent: "Heron" }]);
    expect(eventsOfType(events, "tick_started")[2]).toMatchObject({ tick: 3, active: ["Otter"], asleep: ["Heron"] });
    expect(outcome.reason).toBe("quiescent");
    expectContextsMatchLog(events, requests);
  });

  it("puts an agent that calls wait to sleep after its step, until another agent posts", async () => {
    const { client, requests } = createFakeModel({
      Heron: [[tc("read_board"), tc("wait")], [tc("done")]],
      Otter: [[tc("read_board")], [tc("post_message", { text: "news" })], [tc("done")]],
    });
    const { events, outcome } = await runScenario({ names: ["Heron", "Otter"], model: client });

    const heronCalls = eventsOfType(events, "tool_call").filter((event) => event.agent === "Heron" && event.tick === 1);
    expect(heronCalls.map((event) => event.name)).toEqual(["read_board", "wait"]);
    expect(heronCalls[1]!.error).toBeNull();
    expect(heronCalls[1]!.result).toMatch(/^You'll wait until another agent posts\.\n\n\[step 1\/10 · 0 unread posts · /);
    expect(eventsOfType(events, "agent_slept")).toMatchObject([{ tick: 1, agent: "Heron", reason: "wait" }]);
    const sleptSeq = eventsOfType(events, "agent_slept")[0]!.seq;
    expect(heronCalls.every((event) => event.seq < sleptSeq)).toBe(true);

    expect(eventsOfType(events, "agent_woke")).toMatchObject([{ tick: 2, agent: "Heron" }]);
    expect(requests.filter((request) => request.agent === "Heron").map((request) => request.tick)).toEqual([1, 3]);
    expect(outcome.reason).toBe("all_done");
    expectContextsMatchLog(events, requests);
  });

  it("runs the step's other calls after wait, and lets done take precedence over wait", async () => {
    const { client, requests } = createFakeModel({
      Heron: [[tc("wait"), tc("post_message", { text: "back soon" })]],
      Otter: [[tc("wait"), tc("done")]],
    });
    const { events, outcome } = await runScenario({ names: ["Heron", "Otter"], model: client });
    expect(eventsOfType(events, "post_created")).toMatchObject([{ tick: 1, post: { author: "Heron", text: "back soon" } }]);
    expect(eventsOfType(events, "agent_slept")).toMatchObject([{ tick: 1, agent: "Heron", reason: "wait" }]);
    expect(eventsOfType(events, "agent_done")).toMatchObject([{ tick: 1, agent: "Otter" }]);
    expect(outcome.reason).toBe("quiescent");
    expectContextsMatchLog(events, requests);
  });

  it("doesn't wake a waiting agent for posts it already knew of", async () => {
    const { client, requests } = createFakeModel({
      Heron: [[tc("list_documents")], [tc("wait")]],
      Otter: [[tc("post_message", { text: "early" })], [tc("read_board")], [tc("done")]],
    });
    const { events, outcome } = await runScenario({ names: ["Heron", "Otter"], model: client });
    expect(eventsOfType(events, "agent_slept")).toMatchObject([{ tick: 2, agent: "Heron", reason: "wait" }]);
    expect(eventsOfType(events, "agent_woke")).toEqual([]);
    expect(requests.filter((request) => request.agent === "Heron").map((request) => request.tick)).toEqual([1, 2]);
    expect(outcome.reason).toBe("quiescent");
    expectContextsMatchLog(events, requests);
  });

  it("offers wait only when wait_tool is on, and treats it as unknown otherwise", async () => {
    const { client, requests } = createFakeModel({ Heron: [[tc("wait")], [tc("done")]] });
    const { events, outcome } = await runScenario({
      names: ["Heron"],
      model: client,
      config: { environment: { wait_tool: false } },
    });
    const offered = requests[0]!.request.tools.map((tool) => tool.function.name);
    expect(offered).not.toContain("wait");
    expect(offered).toContain("done");
    expect(eventsOfType(events, "tool_call")[0]).toMatchObject({ name: "wait", error: 'Unknown tool "wait".' });
    expect(eventsOfType(events, "agent_slept")).toEqual([]);
    expect(outcome.reason).toBe("all_done");
    expectContextsMatchLog(events, requests);
  });

  it("logs a response without tool calls as a no_tool_calls sleep", async () => {
    const { client } = createFakeModel({ Heron: [{ content: "Nothing to do." }] });
    const { events } = await runScenario({ names: ["Heron"], model: client });
    expect(eventsOfType(events, "agent_slept")).toMatchObject([{ tick: 1, agent: "Heron", reason: "no_tool_calls" }]);
  });

  it("with the status line off, measures the marker by the posts an agent was shown", async () => {
    // Heron posts #1 before Otter's step at tick 1; Otter never reads the board, so nothing tells it about #1.
    const script = () =>
      createFakeModel({
        Heron: [[tc("post_message", { text: "news" })], ...repeat([tc("list_documents")], 3), [tc("done")]],
        Otter: [[tc("list_documents")], { content: "Idle." }, [tc("list_documents")], { content: "Idle again." }],
      });
    const off = script();
    const quiet = await runScenario({ names: ["Heron", "Otter"], model: off.client, config: { environment: { status_line: false } } });
    expect(eventsOfType(quiet.events, "tick_started")[0]!.order).toEqual(["Heron", "Otter"]);
    expect(eventsOfType(quiet.events, "agent_slept").map(({ tick }) => tick)).toEqual([2, 4]);
    // #1 wakes Otter at tick 2; the wake is the notice, so Otter isn't woken for #1 again at tick 4.
    expect(eventsOfType(quiet.events, "agent_woke")).toEqual([
      expect.objectContaining({ tick: 2, agent: "Otter", message: "[step 2/10]" }),
    ]);
    expect(quiet.outcome.reason).toBe("quiescent");
    expectContextsMatchLog(quiet.events, off.requests);

    // With the status line on, Otter's tick-1 result said "1 unread post", so #1 doesn't wake it.
    const on = script();
    const told = await runScenario({ names: ["Heron", "Otter"], model: on.client });
    const otterResult = eventsOfType(told.events, "tool_call").find((event) => event.agent === "Otter")!.result;
    expect(otterResult).toContain("[step 1/10 · 1 unread post · 2 document reads left]");
    expect(eventsOfType(told.events, "agent_woke")).toHaveLength(0);
  });

  it("with the status line off, counts posts shown by read_board, and every id up to its own post, as known", async () => {
    // After Heron's #1, Otter either reads the board or posts #2 ("Posted as #2" says #1 exists).
    for (const firstStep of [[tc("read_board")], [tc("post_message", { text: "two" })]]) {
      const { client, requests } = createFakeModel({
        Heron: [[tc("post_message", { text: "one" })], [tc("list_documents")], [tc("done")]],
        Otter: [firstStep, { content: "Idle." }],
      });
      const { events, outcome } = await runScenario({
        names: ["Heron", "Otter"],
        model: client,
        config: { environment: { status_line: false } },
      });
      expect(eventsOfType(events, "tick_started")[0]!.order).toEqual(["Heron", "Otter"]);
      expect(eventsOfType(events, "agent_slept")).toMatchObject([{ tick: 2, agent: "Otter" }]);
      expect(eventsOfType(events, "agent_woke")).toHaveLength(0);
      expect(outcome.reason).toBe("quiescent");
      expectContextsMatchLog(events, requests);
    }
  });

  it("turns a malformed tool call into a tool error instead of crashing", async () => {
    const malformed: ModelClient = {
      async call(_request, context) {
        const { client } = createFakeModel({ [context.agent]: [[tc("read_board")]] });
        const result = await client.call(_request, context);
        if (context.tick === 1) {
          result.message.tool_calls = [
            { id: "bad-0", type: "function", function: { name: "read_board" } },
            { id: "bad-1", type: "function" },
            result.message.tool_calls![0]!,
          ] as unknown as ToolCall[];
        } else {
          result.message.tool_calls = [{ id: "done-0", type: "function", function: { name: "done", arguments: "{}" } }];
        }
        return result;
      },
    };
    const { client, requests } = capturing(malformed);
    const { events, outcome } = await runScenario({ names: ["Heron"], model: client });
    const calls = eventsOfType(events, "tool_call").filter((event) => event.tick === 1);
    expect(calls.map(({ call_id, name, raw_arguments, arguments: args, error }) => ({ call_id, name, raw_arguments, args, error }))).toEqual([
      { call_id: "bad-0", name: "read_board", raw_arguments: "", args: null, error: "Malformed tool call." },
      { call_id: "bad-1", name: "", raw_arguments: "", args: null, error: "Malformed tool call." },
      { call_id: "Heron-0-0", name: "read_board", raw_arguments: "{}", args: {}, error: null },
    ]);
    expect(outcome.reason).toBe("all_done");
    expectContextsMatchLog(events, requests);
  });

  it("applies the per-step rules: call limit, calls after done, unknown tools, and bad arguments", async () => {
    const { client, requests } = createFakeModel({
      Heron: [
        [tc("read_board"), tc("read_board"), tc("post_message", { text: "third" })],
        [
          tc("search", { query: "x" }),
          tc("post_message", '{"text": "unterminated'),
          tc("read_document", {}),
        ],
        [
          tc("post_message", { text: "this post is far too long" }),
          tc("post_message", { text: "reply", reply_to: 9 }),
          tc("post_message", "{}"),
        ],
        [tc("done", { note: "bye" }), tc("post_message", { text: "after done" }), tc("read_board")],
      ],
    });
    const { events } = await runScenario({
      names: ["Heron"],
      model: client,
      config: { environment: { post_max_chars: 20 }, run: { max_tool_calls_per_step: 2 } },
    });
    const calls = eventsOfType(events, "tool_call").map(({ tick, index, name, raw_arguments, arguments: args, result, error }) => ({
      tick,
      index,
      name,
      raw_arguments,
      args,
      result,
      error,
    }));
    const status = (tick: number) => `\n\n[step ${tick}/10 · 0 unread posts · 2 document reads left]`;
    const limit = "Too many tool calls in one step (limit 2). This call was ignored.";
    const afterDone = "You've already called done; this call was ignored.";
    expect(calls).toEqual([
      { tick: 1, index: 0, name: "read_board", raw_arguments: "{}", args: {}, result: "No new posts.", error: null },
      { tick: 1, index: 1, name: "read_board", raw_arguments: "{}", args: {}, result: "No new posts.", error: null },
      { tick: 1, index: 2, name: "post_message", raw_arguments: '{"text":"third"}', args: { text: "third" }, result: limit + status(1), error: limit },
      { tick: 2, index: 0, name: "search", raw_arguments: '{"query":"x"}', args: { query: "x" }, result: 'Unknown tool "search".', error: 'Unknown tool "search".' },
      { tick: 2, index: 1, name: "post_message", raw_arguments: '{"text": "unterminated', args: null, result: "Arguments aren't valid JSON.", error: "Arguments aren't valid JSON." },
      { tick: 2, index: 2, name: "read_document", raw_arguments: "{}", args: {}, result: limit + status(2), error: limit },
      {
        tick: 3,
        index: 0,
        name: "post_message",
        raw_arguments: '{"text":"this post is far too long"}',
        args: { text: "this post is far too long" },
        result: "Post is 25 characters; the limit is 20. Nothing was posted.",
        error: "Post is 25 characters; the limit is 20. Nothing was posted.",
      },
      {
        tick: 3,
        index: 1,
        name: "post_message",
        raw_arguments: '{"text":"reply","reply_to":9}',
        args: { text: "reply", reply_to: 9 },
        result: "There is no post #9.",
        error: "There is no post #9.",
      },
      { tick: 3, index: 2, name: "post_message", raw_arguments: "{}", args: {}, result: limit + status(3), error: limit },
      { tick: 4, index: 0, name: "done", raw_arguments: '{"note":"bye"}', args: { note: "bye" }, result: "Done. You won't act again.", error: null },
      { tick: 4, index: 1, name: "post_message", raw_arguments: '{"text":"after done"}', args: { text: "after done" }, result: afterDone, error: afterDone },
      { tick: 4, index: 2, name: "read_board", raw_arguments: "{}", args: {}, result: afterDone + status(4), error: afterDone },
    ]);
    expect(eventsOfType(events, "post_created")).toHaveLength(0);
    expect(eventsOfType(events, "agent_done")).toMatchObject([{ agent: "Heron", note: "bye", tick: 4 }]);
    expectContextsMatchLog(events, requests);
  });

  it("reports missing and mistyped arguments, with the parsed object logged", async () => {
    const { client } = createFakeModel({
      Heron: [[tc("read_document", {}), tc("post_message", { text: 3 }), tc("done", { note: null })]],
    });
    const { events } = await runScenario({ names: ["Heron"], model: client });
    const calls = eventsOfType(events, "tool_call");
    expect(calls[0]).toMatchObject({ arguments: {}, error: 'Missing required argument "id".' });
    expect(calls[1]).toMatchObject({ arguments: { text: 3 }, error: 'Argument "text" must be a string.' });
    expect(calls[2]).toMatchObject({ arguments: { note: null }, error: null });
    expect(eventsOfType(events, "agent_done")).toMatchObject([{ note: null }]);
  });

  it("appends the status line to the last result only, and never when status_line is off", async () => {
    const script = () =>
      createFakeModel({
        Heron: [[tc("post_message", { text: "hi" }), tc("read_document", { id: "d1" })], [tc("done")]],
        Otter: [[tc("read_board"), tc("read_document", { id: "d1" }), tc("read_document", { id: "d2" })], [tc("done")]],
      });
    const on = script();
    const { events } = await runScenario({ names: ["Heron", "Otter"], model: on.client });
    const tick1 = eventsOfType(events, "tool_call").filter((event) => event.tick === 1);
    const heron = tick1.filter((event) => event.agent === "Heron");
    const otter = tick1.filter((event) => event.agent === "Otter");
    expect(heron[0]!.result).toBe("Posted as #1.");
    expect(heron[1]!.result.endsWith("\n\n[step 1/10 · 0 unread posts · 1 document read left]")).toBe(true);
    expect(otter[0]!.result).not.toContain("[step");
    expect(otter[1]!.result).not.toContain("[step");
    // Otter's read_board comes first, so whatever the order, Otter has no unread posts by its last call.
    expect(otter[2]!.result.endsWith("\n\n[step 1/10 · 0 unread posts · 0 document reads left]")).toBe(true);
    expectContextsMatchLog(events, on.requests);

    const off = script();
    const quiet = await runScenario({ names: ["Heron", "Otter"], model: off.client, config: { environment: { status_line: false } } });
    for (const event of eventsOfType(quiet.events, "tool_call")) expect(event.result).not.toContain("[step");
    expectContextsMatchLog(quiet.events, off.requests);
  });

  it("counts unread posts at the moment the status line is appended", async () => {
    const { client } = createFakeModel({
      Heron: [[tc("post_message", { text: "one" }), tc("post_message", { text: "two" })], [tc("done")]],
      Otter: [[tc("list_documents")], [tc("done")]],
    });
    const { events } = await runScenario({ names: ["Heron", "Otter"], model: client });
    const order = eventsOfType(events, "tick_started")[0]!.order;
    const otterResult = eventsOfType(events, "tool_call").find((event) => event.agent === "Otter")!.result;
    const expected = order[0] === "Heron" ? "2 unread posts" : "0 unread posts";
    expect(otterResult).toContain(`[step 1/10 · ${expected} · 2 document reads left]`);
  });
});

describe("runSwarm: end reasons", () => {
  it("ends quiescent when every agent sleeps, even at the tick cap", async () => {
    const { client } = createFakeModel({ Heron: [{ content: "zzz" }], Otter: [{}] });
    const { outcome, events } = await runScenario({ names: ["Heron", "Otter"], model: client, config: { run: { tick_cap: 1 } } });
    expect(outcome.reason).toBe("quiescent");
    expect(events.at(-1)).toMatchObject({ type: "run_ended", tick: 1, reason: "quiescent", totals: { ticks: 1, model_calls: 2 } });
  });

  it("ends at the tick cap", async () => {
    const { client, requests } = createFakeModel({ Heron: repeat([tc("read_board")], 3), Otter: repeat([tc("read_board")], 3) });
    const { outcome, events, summaries } = await runScenario({ names: ["Heron", "Otter"], model: client, config: { run: { tick_cap: 3 } } });
    expect(outcome).toMatchObject({ reason: "tick_cap", error: null, finalDeliverable: "" });
    expect(outcome.totals.ticks).toBe(3);
    expect(requests).toHaveLength(6);
    expect(summaries).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "run_ended", tick: 3, reason: "tick_cap" });
  });

  it("ends at the cost cap, but all_done takes precedence", async () => {
    const expensive = { calls: [tc("read_board")], cost_usd: 0.006 };
    const capped = await runScenario({
      names: ["Heron", "Otter"],
      model: createFakeModel({ Heron: [expensive, expensive], Otter: [expensive, expensive] }).client,
      config: { run: { max_cost_usd: 0.01 } },
    });
    expect(capped.outcome.reason).toBe("cost_cap");
    expect(capped.outcome.totals.usage.cost_usd).toBeCloseTo(0.012);
    expect(capped.events.at(-1)).toMatchObject({ tick: 1, reason: "cost_cap" });
    expect(capped.summaries).toEqual([expect.objectContaining({ tick: 1, cost_usd: expect.closeTo(0.012, 10) })]);

    const done = { calls: [tc("done")], cost_usd: 0.02 };
    const finished = await runScenario({
      names: ["Heron", "Otter"],
      model: createFakeModel({ Heron: [done], Otter: [done] }).client,
      config: { run: { max_cost_usd: 0.01 } },
    });
    expect(finished.outcome.reason).toBe("all_done");
  });

  it("ends with api_error on a fatal error, a cache miss, or any other exception, without applying that tick", async () => {
    const failures: [Error, string][] = [
      [new ModelCallError("HTTP 400: bad request", "fatal", 400), "HTTP 400: bad request"],
      [new ModelCallError("Not in the cache.", "cache_miss"), "Not in the cache."],
      [new TypeError("boom"), "boom"],
    ];
    for (const [failure, message] of failures) {
      const { client, requests } = createFakeModel({
        Heron: [[tc("read_board")], failure],
        Otter: [[tc("read_board")], [tc("post_message", { text: "lost" })]],
      });
      const { outcome, events, summaries } = await runScenario({ names: ["Heron", "Otter"], model: client });
      expect(outcome).toMatchObject({ reason: "api_error", error: message, unapplied: [{ agent: "Otter" }] });
      expect(outcome.totals).toMatchObject({ ticks: 2, model_calls: 2, posts: 0 });
      expect(requests).toHaveLength(4);
      expect(events.filter((event) => event.tick === 2).map((event) => event.type)).toEqual(["tick_started", "run_ended"]);
      expect(events.at(-1)).toMatchObject({ type: "run_ended", tick: 2, reason: "api_error", error: message });
      expect(summaries).toHaveLength(1);
    }
  });

  it("stops an agent whose context is full and carries on with the others", async () => {
    const { client, requests } = createFakeModel({
      Heron: [[tc("read_board")], new ModelCallError("Context too long: 1,200,000 tokens.", "context_length", 400)],
      Otter: [[tc("read_board")], [tc("read_board")], [tc("done")]],
    });
    const { outcome, events, summaries } = await runScenario({ names: ["Heron", "Otter"], model: client });
    expect(eventsOfType(events, "agent_stopped")).toEqual([
      expect.objectContaining({
        tick: 2,
        agent: "Heron",
        reason: "context_full",
        detail: "Context too long: 1,200,000 tokens.",
        cache_key: null,
      }),
    ]);
    expect(eventsOfType(events, "tick_started")[2]).toMatchObject({ active: ["Otter"], finished: ["Heron"] });
    expect(requests.filter((request) => request.agent === "Heron")).toHaveLength(2);
    expect(summaries[1]).toMatchObject({ finished: 1 });
    // Otter chose to finish, Heron didn't: not all_done.
    expect(outcome).toMatchObject({ reason: "all_stopped", totals: { ticks: 3, model_calls: 4 } });
    expectContextsMatchLog(events, requests);
  });

  it("ends all_stopped, not all_done, when every agent's context is full", async () => {
    const full = () => new ModelCallError("Context too long.", "context_length", 400);
    const { client } = createFakeModel({ Heron: [[tc("read_board")], full()], Otter: [[tc("read_board")], full()] });
    const { outcome, events } = await runScenario({ names: ["Heron", "Otter"], model: client });
    expect(eventsOfType(events, "agent_stopped").map((event) => event.agent).sort()).toEqual(["Heron", "Otter"]);
    expect(eventsOfType(events, "agent_done")).toHaveLength(0);
    expect(outcome).toMatchObject({ reason: "all_stopped", totals: { ticks: 2 } });
  });

  it("reports quiescent over a cost cap reached on the same tick", async () => {
    const { client } = createFakeModel({ Heron: [{ content: "zzz", cost_usd: 1 }], Otter: [{ content: "zzz", cost_usd: 1 }] });
    const { outcome } = await runScenario({ names: ["Heron", "Otter"], model: client, config: { run: { max_cost_usd: 1 } } });
    expect(outcome.reason).toBe("quiescent");
    expect(outcome.totals.usage.cost_usd).toBe(2);
  });

  it("lists the aborted tick's calls that returned as unapplied, and counts their cost", async () => {
    const { client } = createFakeModel({
      Heron: [[tc("read_board")], new ModelCallError("HTTP 400: bad request", "fatal", 400)],
      Otter: [[tc("read_board")], { calls: [tc("post_message", { text: "lost" })], cost_usd: 0.5 }],
    });
    const { outcome, events } = await runScenario({ names: ["Heron", "Otter"], model: client });
    const unapplied = [
      { agent: "Otter", cache_key: "key-Otter-1", cache_hit: false, usage: expect.objectContaining({ cost_usd: 0.5 }) },
    ];
    expect(outcome).toMatchObject({ reason: "api_error", unapplied, totals: { model_calls: 2, posts: 0 } });
    expect(outcome.totals.usage.cost_usd).toBeCloseTo(0.502, 10);
    expect(events.at(-1)).toMatchObject({ type: "run_ended", unapplied, totals: outcome.totals });
    expect(eventsOfType(events, "model_call")).toHaveLength(2);
  });

  it("ends interrupted when aborted mid-tick, without applying that tick", async () => {
    const controller = new AbortController();
    const { client, requests } = createFakeModel({
      Heron: [[tc("read_board")], { calls: [tc("post_message", { text: "lost" })], before: () => controller.abort() }],
      Otter: [[tc("read_board")], [tc("read_board")]],
    });
    const { outcome, events } = await runScenario({ names: ["Heron", "Otter"], model: client, signal: controller.signal });
    expect(outcome).toMatchObject({ reason: "interrupted", error: null, totals: { ticks: 2, model_calls: 2, posts: 0 } });
    expect(requests).toHaveLength(4);
    expect(events.filter((event) => event.tick === 2).map((event) => event.type)).toEqual(["tick_started", "run_ended"]);
  });

  it("cancels the calls in flight on abort and ends interrupted promptly", async () => {
    const controller = new AbortController();
    const fetches: (AbortSignal | null | undefined)[] = [];
    const hangs = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetches.push(init?.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    const cacheDir = mkdtempSync(join(tmpdir(), "swarm-engine-cache-"));
    const model = createOpenRouterModelClient({
      apiKey: "test-key",
      cacheDir,
      offline: false,
      timeoutMs: 600_000,
      maxRetries: 3,
      fetchImpl: hangs,
    });
    setTimeout(() => controller.abort(), 30);
    const started = performance.now();
    const { outcome, events } = await runScenario({ names: ["Heron", "Otter"], model, signal: controller.signal });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(outcome).toMatchObject({ reason: "interrupted", error: null, totals: { ticks: 1, model_calls: 0 } });
    expect(fetches).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(["run_started", "tick_started", "run_ended"]);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it("re-runs offline across a context_full stop, from the cache alone", async () => {
    const fake = openRouterFake((agent, n) => {
      if (agent === "Heron" && n === 1) {
        return { status: 400, body: { error: { code: 400, message: "This endpoint's maximum context length is 1000 tokens." } } };
      }
      return { status: 200, body: toolCompletion(`gen-${agent}-${n}`, n === 0 ? ["read_board", {}] : ["done", {}]) };
    });
    const cacheDir = mkdtempSync(join(tmpdir(), "swarm-engine-cache-"));
    const original = await runScenario({ names: ["Heron", "Otter"], model: openRouterClient(cacheDir, fake.impl, false) });
    expect(eventsOfType(original.events, "agent_stopped")).toEqual([
      expect.objectContaining({ tick: 2, agent: "Heron", cache_key: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
    expect(original.outcome.reason).toBe("all_stopped");

    const requestsSoFar = fake.requests();
    const rerun = await runScenario({ names: ["Heron", "Otter"], model: openRouterClient(cacheDir, fake.impl, true) });
    expect(fake.requests()).toBe(requestsSoFar);
    expect(firstDifference(original.events, rerun.events)).toBeNull();
  });

  it("gives agents with identical requests their own samples, which an offline re-run reproduces", async () => {
    let samples = 0;
    const fake = openRouterFake((_agent, _n, body) => {
      samples += 1;
      const firstStep = body.messages.length === 2;
      return {
        status: 200,
        body: toolCompletion(`gen-${samples}`, firstStep ? ["post_message", { text: `sample ${samples}` }] : ["done", {}]),
      };
    });
    const names = ["Heron", "Otter", "Wren"];
    // A template without {name}: every agent's tick-1 request is the same.
    const systemPrompts = Object.fromEntries(names.map((name) => [name, "You are one of several agents."]));
    const cacheDir = mkdtempSync(join(tmpdir(), "swarm-engine-cache-"));
    const original = await runScenario({ names, systemPrompts, model: openRouterClient(cacheDir, fake.impl, false) });
    const texts = eventsOfType(original.events, "post_created").map((event) => event.post.text);
    expect(new Set(texts).size).toBe(3);
    expect(new Set(eventsOfType(original.events, "model_call").filter((e) => e.tick === 1).map((e) => e.cache_key)).size).toBe(3);

    const rerun = await runScenario({ names, systemPrompts, model: openRouterClient(cacheDir, fake.impl, true) });
    expect(rerun.outcome.reason).toBe("all_done");
    expect(firstDifference(original.events, rerun.events)).toBeNull();
  });

  it("passes the run's signal to every model call and logs each call's attempts", async () => {
    const controller = new AbortController();
    const { client: inner } = createFakeModel({ Heron: [[tc("done")]] });
    const signals: (AbortSignal | undefined)[] = [];
    const client: ModelClient = {
      async call(request, context) {
        signals.push(context.signal);
        return { ...(await inner.call(request, context)), attempts: 4 };
      },
    };
    const { events } = await runScenario({ names: ["Heron"], model: client, signal: controller.signal });
    expect(signals).toEqual([controller.signal]);
    expect(eventsOfType(events, "model_call")).toMatchObject([{ agent: "Heron", attempts: 4 }]);
  });

  it("ends interrupted at tick 0 when aborted before the first tick", async () => {
    const { client, requests } = createFakeModel({ Heron: [[tc("done")]] });
    const { outcome, events } = await runScenario({ names: ["Heron"], model: client, signal: AbortSignal.abort() });
    expect(outcome).toMatchObject({ reason: "interrupted", totals: { ticks: 0, model_calls: 0 } });
    expect(requests).toHaveLength(0);
    expect(events.map((event) => [event.type, event.tick])).toEqual([
      ["run_started", 0],
      ["run_ended", 0],
    ]);
  });
});
