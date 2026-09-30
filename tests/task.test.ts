import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RunConfigSchema, type RunConfigInput } from "../src/shared/config.ts";
import { ConfigError } from "../src/harness/config.ts";
import { loadTask, snapshotTask, taskWarnings } from "../src/harness/task.ts";

const tmp = mkdtempSync(join(tmpdir(), "swarm-task-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let taskCount = 0;
function makeTask(docs: Record<string, string | Buffer>, taskText = "Summarize the documents.\n"): string {
  const dir = join(tmp, `task-${++taskCount}`);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "task.md"), taskText);
  for (const [filename, content] of Object.entries(docs)) writeFileSync(join(dir, "docs", filename), content);
  return dir;
}

function config(overrides: { count?: number; doc_read_budget?: number } = {}) {
  const input: RunConfigInput = {
    task: "unused",
    agents: { count: overrides.count ?? 3, model: { id: "some/model" } },
    environment: { doc_read_budget: overrides.doc_read_budget ?? 2 },
  };
  return RunConfigSchema.parse(input);
}

describe("loadTask", () => {
  it("reads task.md verbatim and names the task after its folder", () => {
    const dir = makeTask({ "a.md": "A" }, "  Write a memo {with braces}.\n\n");
    const task = loadTask(dir);
    expect(task.text).toBe("  Write a memo {with braces}.\n\n");
    expect(task.name).toBe(`task-${taskCount}`);
    expect(task.dir).toBe(dir);
  });

  it("takes the title from the first Markdown heading, else the filename", () => {
    const task = loadTask(
      makeTask({
        "intro.md": "Some preface.\n\n## The Real Title  \n# Later heading\n",
        "plain.txt": "No headings here.\n#hashtag is not one\n",
        "deep.md": "###### Level six\n",
        "seven.md": "####### Too deep\n",
        "bom.md": "﻿# With a BOM\r\nbody\r\n",
      }),
    );
    const titles = Object.fromEntries(task.docs.map((doc) => [doc.meta.id, doc.meta.title]));
    expect(titles).toEqual({
      bom: "With a BOM",
      deep: "Level six",
      intro: "The Real Title",
      plain: "plain.txt",
      seven: "seven.md",
    });
  });

  it("sorts documents in natural filename order", () => {
    const task = loadTask(
      makeTask({ "doc10.md": "x", "doc2.md": "x", "doc1.txt": "x", "Doc3.md": "x", "appendix.md": "x" }),
    );
    expect(task.docs.map((doc) => doc.meta.filename)).toEqual([
      "appendix.md",
      "doc1.txt",
      "doc2.md",
      "Doc3.md",
      "doc10.md",
    ]);
  });

  it("ignores dotfiles, other extensions, and folders", () => {
    const dir = makeTask({ "a.md": "A", ".hidden.md": "H", "notes.pdf": "P", "data.json": "{}" });
    mkdirSync(join(dir, "docs", "sub.md"));
    writeFileSync(join(dir, "README.md"), "not a document");
    expect(loadTask(dir).docs.map((doc) => doc.meta.id)).toEqual(["a"]);
  });

  it("rejects two documents with the same id", () => {
    const dir = makeTask({ "report.md": "A", "report.txt": "B" });
    expect(() => loadTask(dir)).toThrow(/docs\/report\.md and docs\/report\.txt have the same document id "report"/);
  });

  it("computes words, chars, and the sha256 of the UTF-8 text", () => {
    const text = "# Café\n\nHello   world,\tthis is\na test. ☕\n";
    const task = loadTask(makeTask({ "one.md": text }));
    const meta = task.docs[0]!.meta;
    expect(meta).toEqual({
      id: "one",
      filename: "one.md",
      title: "Café",
      words: 9,
      chars: text.length,
      sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    });
    expect(task.docs[0]!.text).toBe(text);
  });

  it("explains what's missing", () => {
    expect(() => loadTask(join(tmp, "nowhere"))).toThrow(/does not exist/);

    const noTask = join(tmp, "no-task-md");
    mkdirSync(join(noTask, "docs"), { recursive: true });
    expect(() => loadTask(noTask)).toThrow(/has no task\.md/);

    const noDocsDir = join(tmp, "no-docs-dir");
    mkdirSync(noDocsDir);
    writeFileSync(join(noDocsDir, "task.md"), "x");
    expect(() => loadTask(noDocsDir)).toThrow(/has no docs\/ folder/);

    expect(() => loadTask(makeTask({ "a.pdf": "x", ".b.md": "y" }))).toThrow(/at least one \.md or \.txt/);
    expect(() => loadTask(makeTask({}))).toThrow(ConfigError);
  });

  it("rejects text that isn't valid UTF-8", () => {
    const dir = makeTask({ "bad.txt": Buffer.from([0x68, 0x69, 0xff, 0xfe]) });
    expect(() => loadTask(dir)).toThrow(/bad\.txt is not valid UTF-8/);
  });

  it("is named after its folder unless given a name", () => {
    const source = loadTask(makeTask({ "a.md": "A" }));
    const snapshotDir = join(tmp, "runs", "example-20260928-101500-s3-2", "task");
    snapshotTask(source, snapshotDir);
    expect(loadTask(snapshotDir).name).toBe("task");
    expect(loadTask(snapshotDir, "example").name).toBe("example");
    expect(loadTask(`${snapshotDir}/`).name).toBe("task");
  });
});

describe("snapshotTask", () => {
  it("writes task.md and the documents byte-identical", () => {
    const docs = {
      "01-crlf.md": Buffer.from("# Title\r\nline one\r\nline two\r\n", "utf8"),
      "02-bom.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("with a byte-order mark\n")]),
      "03-unicode.md": Buffer.from("Ünïcödé — 日本語 — 🦦\nno trailing newline", "utf8"),
    };
    const source = makeTask(docs, "Task with a trailing space \n");
    const task = loadTask(source);
    const dest = join(tmp, "snapshot-1");
    snapshotTask(task, dest);

    expect(readFileSync(join(dest, "task.md"))).toEqual(readFileSync(join(source, "task.md")));
    expect(readdirSync(join(dest, "docs")).sort()).toEqual(Object.keys(docs).sort());
    for (const [filename, bytes] of Object.entries(docs)) {
      expect(readFileSync(join(dest, "docs", filename))).toEqual(bytes);
    }
    const reloaded = loadTask(dest);
    expect(reloaded.docs.map((doc) => doc.meta)).toEqual(task.docs.map((doc) => doc.meta));
    expect(reloaded.text).toBe(task.text);
  });
});

describe("taskWarnings", () => {
  const docs = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`d${i + 1}.md`, "x".repeat(400)]));
  const task = loadTask(makeTask(docs));

  it("is quiet when the team needs each other and can cover the corpus", () => {
    expect(taskWarnings(task, config({ count: 3, doc_read_budget: 2 }), 100_000)).toEqual([]);
  });

  it("warns when one agent can read everything", () => {
    const warnings = taskWarnings(task, config({ count: 3, doc_read_budget: 6 }), null);
    expect(warnings).toEqual([expect.stringContaining("doc_read_budget (6) >= document count (6)")]);
  });

  it("warns when the team can't cover the corpus", () => {
    const warnings = taskWarnings(task, config({ count: 2, doc_read_budget: 2 }), null);
    expect(warnings).toEqual([expect.stringContaining("2 agents × doc_read_budget 2 = 4 reads < 6 documents")]);
  });

  it("warns about documents over a quarter of the context window", () => {
    const mixed = loadTask(makeTask({ "small.md": "x".repeat(100), "big.md": "x".repeat(1_001) }));
    // big.md is ~251 tokens: over 25% of a 1000-token window; small.md is 25 tokens.
    const warnings = taskWarnings(mixed, config({ count: 1, doc_read_budget: 1 }), 1000);
    expect(warnings.filter((w) => w.startsWith("Document"))).toEqual([
      "Document big is ~251 tokens, over 25% of the 1000-token context window.",
    ]);
    expect(taskWarnings(mixed, config({ count: 1, doc_read_budget: 1 }), null).some((w) => w.startsWith("Document"))).toBe(
      false,
    );
  });

  it("warns that a solo run gets the group prompt", () => {
    const warnings = taskWarnings(task, config({ count: 1, doc_read_budget: 6 }), null);
    expect(warnings).toContainEqual(expect.stringMatching(/^agents\.count is 1, but the swarm prompt describes a group/));
    expect(taskWarnings(task, config({ count: 2, doc_read_budget: 3 }), null)).toEqual([]);
  });
});
