import { describe, expect, it } from "vitest";
import { EnvironmentConfigSchema } from "../src/shared/config.ts";
import type { EnvironmentConfig } from "../src/shared/config.ts";
import { TOOL_NAMES } from "../src/shared/types.ts";
import { World } from "../src/harness/environment.ts";
import { buildTools, countOf, formatNumber, isToolName, parseJsonObject, parseToolArguments } from "../src/harness/tools.ts";
import { makeTask, THREE_DOCS } from "./helpers/fixtures.ts";

function makeWorld(environment: Partial<EnvironmentConfig> = {}, agents = ["Heron", "Otter", "Wren"]): World {
  return new World({
    task: makeTask([
      ...THREE_DOCS,
      { id: "long", title: "A Long One", text: Array.from({ length: 1532 }, () => "word").join(" ") },
    ]),
    agents,
    environment: EnvironmentConfigSchema.parse({ doc_read_budget: 2, post_max_chars: 40, ...environment }),
    tickCap: 40,
  });
}

describe("read_board and post_message", () => {
  it("delivers other agents' posts once, in id order, with reply markers", () => {
    const world = makeWorld();
    expect(world.execute("Heron", 1, "post_message", { text: "hello" })).toEqual({
      result: "Posted as #1.",
      error: null,
      events: [{ type: "post_created", post: { id: 1, author: "Heron", tick: 1, text: "hello", reply_to: null } }],
    });
    world.execute("Otter", 2, "post_message", { text: "hi Heron", reply_to: 1 });
    world.execute("Wren", 2, "post_message", { text: "hi all", reply_to: null });

    const first = world.execute("Heron", 3, "read_board", {});
    expect(first.result).toBe("2 new posts:\n#2 Otter (step 2, reply to #1): hi Heron\n#3 Wren (step 2): hi all");
    expect(first.events).toEqual([{ type: "board_delivered", agent: "Heron", post_ids: [2, 3] }]);

    const again = world.execute("Heron", 3, "read_board", {});
    expect(again.result).toBe("No new posts.");
    expect(again.events).toEqual([{ type: "board_delivered", agent: "Heron", post_ids: [] }]);

    expect(world.execute("Otter", 3, "read_board", {}).result).toBe("2 new posts:\n#1 Heron (step 1): hello\n#3 Wren (step 2): hi all");
    world.execute("Heron", 4, "post_message", { text: "one more" });
    expect(world.execute("Wren", 4, "read_board", {}).result).toBe(
      "3 new posts:\n#1 Heron (step 1): hello\n#2 Otter (step 2, reply to #1): hi Heron\n#4 Heron (step 4): one more",
    );
    expect(world.execute("Otter", 5, "read_board", {}).result).toBe("1 new post:\n#4 Heron (step 4): one more");
  });

  it("rejects empty, too long, and dangling-reply posts without creating them", () => {
    const world = makeWorld();
    expect(world.execute("Heron", 1, "post_message", { text: "  \n " })).toEqual({
      result: "Post text is empty.",
      error: "Post text is empty.",
      events: [],
    });
    const long = world.execute("Heron", 1, "post_message", { text: "x".repeat(41) });
    expect(long.error).toBe("Post is 41 characters; the limit is 40. Nothing was posted.");
    expect(long.result).toBe(long.error);
    expect(world.execute("Heron", 1, "post_message", { text: "x".repeat(40) }).result).toBe("Posted as #1.");
    expect(world.execute("Heron", 1, "post_message", { text: "re", reply_to: 2 }).error).toBe("There is no post #2.");
    expect(world.execute("Heron", 1, "post_message", { text: "re", reply_to: 0 }).error).toBe("There is no post #0.");
    expect(world.posts).toHaveLength(1);
  });

  it("formats large numbers in the too-long error", () => {
    const world = makeWorld({ post_max_chars: 1000 });
    expect(world.execute("Heron", 1, "post_message", { text: "x".repeat(1203) }).error).toBe(
      "Post is 1,203 characters; the limit is 1,000. Nothing was posted.",
    );
  });
});

describe("list_documents and read_document", () => {
  it("lists every document, marking the ones this agent opened, without spending reads", () => {
    const world = makeWorld();
    world.execute("Heron", 1, "read_document", { id: "d2" });
    const listing = world.execute("Heron", 1, "list_documents", {});
    expect(listing).toEqual({
      result: [
        "4 documents:",
        '- d1 · "First" · 11 words',
        '- d2 · "Second" · 12 words (opened)',
        '- d3 · "Third" · 11 words',
        '- long · "A Long One" · 1,532 words',
      ].join("\n"),
      error: null,
      events: [],
    });
    expect(world.readsLeft("Heron")).toBe(1);
    expect(world.execute("Otter", 1, "list_documents", {}).result).not.toContain("(opened)");
  });

  it("spends a read on first opens only, errors over budget, and re-opens for free", () => {
    const world = makeWorld();
    const first = world.execute("Heron", 1, "read_document", { id: "d1" });
    expect(first.result).toBe('d1 · "First" · 11 words\n\nAlpha one. The first document says the river floods in spring.');
    expect(first.events).toEqual([{ type: "document_opened", agent: "Heron", doc_id: "d1", first_open: true, reads_left: 1 }]);

    expect(world.execute("Heron", 1, "read_document", { id: "d2" }).events).toEqual([
      { type: "document_opened", agent: "Heron", doc_id: "d2", first_open: true, reads_left: 0 },
    ]);
    expect(world.execute("Heron", 2, "read_document", { id: "d3" })).toEqual({
      result: "You've used all 2 of your document reads.",
      error: "You've used all 2 of your document reads.",
      events: [],
    });
    const reopen = world.execute("Heron", 2, "read_document", { id: "d1" });
    expect(reopen.error).toBeNull();
    expect(reopen.events).toEqual([{ type: "document_opened", agent: "Heron", doc_id: "d1", first_open: false, reads_left: 0 }]);
    expect(world.readsLeft("Otter")).toBe(2);
  });

  it("rejects an unknown document id without spending a read", () => {
    const world = makeWorld();
    expect(world.execute("Heron", 1, "read_document", { id: "nope" })).toEqual({
      result: 'There is no document "nope". Use list_documents to see the ids.',
      error: 'There is no document "nope". Use list_documents to see the ids.',
      events: [],
    });
    expect(world.readsLeft("Heron")).toBe(2);
  });
});

describe("the deliverable", () => {
  it("starts empty and records versions with who replaced what, and whether they had seen it", () => {
    const world = makeWorld();
    expect(world.execute("Otter", 1, "read_deliverable", {})).toEqual({
      result: "The deliverable is empty.",
      error: null,
      events: [{ type: "deliverable_read", agent: "Otter", version: 0 }],
    });

    const v1 = world.execute("Heron", 2, "write_deliverable", { text: "Heron's draft" });
    expect(v1.result).toBe("Saved as v1; replaced the empty deliverable.");
    expect(v1.events).toEqual([
      {
        type: "deliverable_written",
        version: {
          version: 1,
          author: "Heron",
          tick: 2,
          text: "Heron's draft",
          replaced_version: 0,
          replaced_author: null,
          writer_had_seen_replaced: true,
        },
      },
    ]);

    // Otter read v1 before writing: seen.
    expect(world.execute("Otter", 3, "read_deliverable", {})).toEqual({
      result: "Deliverable v1, written by Heron at step 2:\n\nHeron's draft",
      error: null,
      events: [{ type: "deliverable_read", agent: "Otter", version: 1 }],
    });
    const v2 = world.execute("Otter", 4, "write_deliverable", { text: "Otter's edit" });
    expect(v2.result).toBe("Saved as v2; replaced v1, written by Heron at step 2.");
    expect(v2.events[0]).toMatchObject({ version: { version: 2, replaced_version: 1, replaced_author: "Heron", writer_had_seen_replaced: true } });

    // Wren never read anything: unseen overwrite.
    const v3 = world.execute("Wren", 5, "write_deliverable", { text: "Wren's rewrite" });
    expect(v3.result).toBe("Saved as v3; replaced v2, written by Otter at step 4.");
    expect(v3.events[0]).toMatchObject({ version: { replaced_author: "Otter", writer_had_seen_replaced: false } });

    // Wren overwrites its own version: seen by definition.
    const v4 = world.execute("Wren", 6, "write_deliverable", { text: "" });
    expect(v4.result).toBe("Saved as v4; replaced v3, which you wrote at step 5.");
    expect(v4.events[0]).toMatchObject({ version: { text: "", replaced_author: "Wren", writer_had_seen_replaced: true } });

    // Heron last saw v1 (its own write), so replacing v4 is unseen.
    expect(world.execute("Heron", 7, "write_deliverable", { text: "x" }).events[0]).toMatchObject({
      version: { version: 5, replaced_version: 4, writer_had_seen_replaced: false },
    });
    expect(world.versions.map((version) => version.version)).toEqual([1, 2, 3, 4, 5]);
    expect(world.deliverableText).toBe("x");
    expect(world.execute("Heron", 7, "read_deliverable", {}).result).toBe("Deliverable v5, written by Heron at step 7:\n\nx");
  });

  it("rejects a deliverable over the limit", () => {
    const world = makeWorld({ deliverable_max_chars: 1000 });
    expect(world.execute("Heron", 1, "write_deliverable", { text: "y".repeat(1001) })).toEqual({
      result: "Deliverable text is 1,001 characters; the limit is 1,000. Nothing was saved.",
      error: "Deliverable text is 1,001 characters; the limit is 1,000. Nothing was saved.",
      events: [],
    });
    expect(world.versions).toHaveLength(0);
  });
});

describe("done, status, and waking", () => {
  it("marks the agent done and refuses further calls", () => {
    const world = makeWorld();
    expect(world.execute("Heron", 3, "done", { note: "bye" })).toEqual({
      result: "Done. You won't act again.",
      error: null,
      events: [{ type: "agent_done", agent: "Heron", note: "bye" }],
    });
    expect(world.status("Heron")).toBe("done");
    expect(world.execute("Otter", 3, "done", {}).events).toEqual([{ type: "agent_done", agent: "Otter", note: null }]);
    expect(() => world.execute("Heron", 4, "read_board", {})).toThrow(/done/);
  });

  it("formats the status line with singulars and plurals", () => {
    const world = makeWorld({ doc_read_budget: 3 });
    expect(world.statusLine("Heron", 9)).toBe("[step 9/40 · 0 unread posts · 3 document reads left]");
    world.execute("Otter", 9, "post_message", { text: "one" });
    world.execute("Heron", 9, "read_document", { id: "d1" });
    world.execute("Heron", 9, "read_document", { id: "d2" });
    expect(world.statusLine("Heron", 9)).toBe("[step 9/40 · 1 unread post · 1 document read left]");
    world.execute("Wren", 9, "post_message", { text: "two" });
    world.execute("Heron", 9, "post_message", { text: "mine" });
    expect(world.statusLine("Heron", 10)).toBe("[step 10/40 · 2 unread posts · 1 document read left]");
    world.execute("Heron", 10, "read_board", {});
    expect(world.unreadCount("Heron")).toBe(0);
  });

  it("wakes a sleeper only for another agent's post newer than its marker", () => {
    const world = makeWorld();
    world.execute("Heron", 1, "post_message", { text: "before" });
    world.sleep("Otter", 1);
    expect(world.status("Otter")).toBe("asleep");
    expect(world.shouldWake("Otter")).toBe(false);

    world.sleep("Heron", 1);
    world.wake("Otter");
    world.execute("Otter", 2, "post_message", { text: "own" });
    world.sleep("Otter", 1);
    // Post #2 is Otter's own, so it doesn't wake Otter; it does wake Heron.
    expect(world.shouldWake("Otter")).toBe(false);
    expect(world.shouldWake("Heron")).toBe(true);
    expect(world.shouldWake("Wren")).toBe(false);

    world.stop("Wren");
    expect(world.status("Wren")).toBe("stopped");
    expect(() => world.status("Nobody")).toThrow(/Unknown agent/);
  });
});

describe("tools", () => {
  const env = EnvironmentConfigSchema.parse({ doc_read_budget: 3, post_max_chars: 800, deliverable_max_chars: 20000 });

  it("builds the seven tools in order with config numbers in the descriptions", () => {
    const tools = buildTools(env);
    expect(tools.map((tool) => tool.function.name)).toEqual([...TOOL_NAMES]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.function.name, tool.function]));
    expect(byName.read_board!.description).toBe("Return the posts on the message board that you haven't seen yet.");
    expect(byName.post_message!.description).toBe(
      "Post a message to the board. At most 800 characters. Optionally reply to an earlier post by its id.",
    );
    expect(byName.list_documents!.description).toBe(
      "List all documents with their ids, titles, and lengths. Doesn't use any of your document reads.",
    );
    expect(byName.read_document!.description).toBe(
      "Return the full text of a document. Opening a document you haven't opened before uses one of your 3 document reads; opening it again is free.",
    );
    expect(byName.read_deliverable!.description).toBe(
      "Return the current deliverable, its version number, and who wrote that version.",
    );
    expect(byName.write_deliverable!.description).toBe(
      "Replace the entire deliverable with new text. At most 20,000 characters.",
    );
    expect(byName.done!.description).toBe(
      "Stop working. After this you can't act again. The optional note isn't shown to other agents.",
    );
    expect(byName.post_message!.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" }, reply_to: { type: "integer" } },
      required: ["text"],
    });
    expect(byName.read_document!.parameters.required).toEqual(["id"]);
    expect(byName.done!.parameters.required).toBeUndefined();
    expect(byName.read_board!.parameters).toEqual({ type: "object", properties: {} });
    for (const tool of tools) expect(tool.type).toBe("function");
  });

  it("parses and validates arguments", () => {
    expect(parseToolArguments("read_board", "")).toEqual({ ok: true, args: {} });
    expect(parseToolArguments("read_board", "  \n")).toEqual({ ok: true, args: {} });
    expect(parseToolArguments("read_board", '{"extra": 1}')).toEqual({ ok: true, args: { extra: 1 } });
    expect(parseToolArguments("post_message", '{"text": "hi"}')).toEqual({ ok: true, args: { text: "hi" } });
    expect(parseToolArguments("post_message", '{"text": "hi", "reply_to": null}')).toMatchObject({ ok: true });
    expect(parseToolArguments("post_message", '{"text": "hi", "reply_to": 3}')).toMatchObject({ ok: true });
    expect(parseToolArguments("done", '{"note": null}')).toMatchObject({ ok: true });
    expect(parseToolArguments("done", "{}")).toMatchObject({ ok: true });

    expect(parseToolArguments("post_message", '{"text": "hi"')).toEqual({ ok: false, error: "Arguments aren't valid JSON." });
    expect(parseToolArguments("post_message", "[1]")).toEqual({ ok: false, error: "Arguments must be a JSON object." });
    expect(parseToolArguments("post_message", "null")).toEqual({ ok: false, error: "Arguments must be a JSON object." });
    expect(parseToolArguments("post_message", "{}")).toEqual({ ok: false, error: 'Missing required argument "text".' });
    expect(parseToolArguments("post_message", '{"text": null}')).toEqual({ ok: false, error: 'Argument "text" must be a string.' });
    expect(parseToolArguments("post_message", '{"text": 5}')).toEqual({ ok: false, error: 'Argument "text" must be a string.' });
    expect(parseToolArguments("post_message", '{"text": "a", "reply_to": 1.5}')).toEqual({
      ok: false,
      error: 'Argument "reply_to" must be an integer.',
    });
    expect(parseToolArguments("post_message", '{"text": "a", "reply_to": "3"}')).toMatchObject({ ok: false });
    expect(parseToolArguments("read_document", '{"id": 3}')).toEqual({ ok: false, error: 'Argument "id" must be a string.' });
    expect(parseToolArguments("write_deliverable", '{"text": ""}')).toEqual({ ok: true, args: { text: "" } });
    expect(parseToolArguments("done", '{"note": 1}')).toEqual({ ok: false, error: 'Argument "note" must be a string.' });
  });

  it("has small helpers for names, raw objects, and numbers", () => {
    expect(isToolName("read_board")).toBe(true);
    expect(isToolName("search")).toBe(false);
    expect(parseJsonObject("")).toEqual({});
    expect(parseJsonObject('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonObject("[1]")).toBeNull();
    expect(parseJsonObject("{bad")).toBeNull();
    expect(formatNumber(1532)).toBe("1,532");
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(800)).toBe("800");
    expect(countOf(1, "post")).toBe("1 post");
    expect(countOf(0, "post")).toBe("0 posts");
  });
});
