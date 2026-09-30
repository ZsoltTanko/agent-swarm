import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { RunConfig } from "../shared/config.ts";
import type { DocMeta } from "../shared/types.ts";
import { ConfigError } from "./config.ts";
import type { LoadedDocument, LoadedTask } from "./types.ts";

const DOC_EXTENSIONS = new Set([".md", ".txt"]);
const HEADING = /^#{1,6}\s+(.+)/;
/** A document above this share of the context window gets a warning. */
const LARGE_DOC_CONTEXT_SHARE = 0.25;
const CHARS_PER_TOKEN = 4;

/**
 * Loads tasks/<name>/: task.md plus every .md or .txt file in docs/ (dotfiles and other files ignored).
 * The task is named `name`, by default the folder's basename.
 */
export function loadTask(dir: string, name = basename(resolve(dir))): LoadedTask {
  const root = resolve(dir);
  if (!isDirectory(root)) throw new ConfigError(`Task folder ${dir} does not exist.`);

  const taskPath = join(root, "task.md");
  if (!isFile(taskPath)) throw new ConfigError(`Task folder ${dir} has no task.md.`);
  const text = readUtf8(taskPath);

  const docsDir = join(root, "docs");
  if (!isDirectory(docsDir)) throw new ConfigError(`Task folder ${dir} has no docs/ folder.`);

  const filenames = readdirSync(docsDir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => DOC_EXTENSIONS.has(extname(name).toLowerCase()))
    .filter((name) => isFile(join(docsDir, name)))
    .sort(naturalOrder);
  if (filenames.length === 0) {
    throw new ConfigError(`Task folder ${dir} has no documents: docs/ needs at least one .md or .txt file.`);
  }

  const docs: LoadedDocument[] = [];
  const filenameById = new Map<string, string>();
  for (const filename of filenames) {
    const doc = loadDocument(join(docsDir, filename));
    const clash = filenameById.get(doc.meta.id);
    if (clash !== undefined) {
      throw new ConfigError(
        `Task folder ${dir}: docs/${clash} and docs/${filename} have the same document id "${doc.meta.id}".`,
      );
    }
    filenameById.set(doc.meta.id, filename);
    docs.push(doc);
  }

  return { name, dir: root, text, docs };
}

/** Writes destDir/task.md and destDir/docs/<filename>, byte-identical to what was loaded. */
export function snapshotTask(task: LoadedTask, destDir: string): void {
  const docsDir = join(destDir, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(destDir, "task.md"), task.text, "utf8");
  for (const doc of task.docs) writeFileSync(join(docsDir, doc.meta.filename), doc.text, "utf8");
}

/** Warnings about the task's fit to the config: coordination not needed, corpus not coverable, oversized documents. */
export function taskWarnings(task: LoadedTask, config: RunConfig, contextLength: number | null): string[] {
  const warnings: string[] = [];
  const docCount = task.docs.length;
  const budget = config.environment.doc_read_budget;
  const agents = config.agents.count;

  if (budget >= docCount) {
    warnings.push(
      `doc_read_budget (${budget}) >= document count (${docCount}): every agent can read every document, so no agent needs the others.`,
    );
  }
  if (agents * budget < docCount) {
    warnings.push(
      `${agents} agents × doc_read_budget ${budget} = ${agents * budget} reads < ${docCount} documents: the team can't cover the corpus.`,
    );
  }
  if (agents === 1) {
    warnings.push(
      "agents.count is 1, but the swarm prompt describes a group (with roster_known false, {team} reads " +
        '"several agents"): a solo run needs a prompt template written for one agent.',
    );
  }
  if (contextLength !== null) {
    for (const { meta } of task.docs) {
      const tokens = Math.ceil(meta.chars / CHARS_PER_TOKEN);
      if (tokens > contextLength * LARGE_DOC_CONTEXT_SHARE) {
        warnings.push(
          `Document ${meta.id} is ~${tokens} tokens, over ${LARGE_DOC_CONTEXT_SHARE * 100}% of the ${contextLength}-token context window.`,
        );
      }
    }
  }
  return warnings;
}

function loadDocument(path: string): LoadedDocument {
  const filename = basename(path);
  const text = readUtf8(path);
  const meta: DocMeta = {
    id: filename.slice(0, filename.length - extname(filename).length),
    filename,
    title: firstHeading(text) ?? filename,
    words: text.split(/\s+/).filter((word) => word.length > 0).length,
    chars: text.length,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
  return { meta, text };
}

function firstHeading(text: string): string | null {
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const title = HEADING.exec(line)?.[1]?.trim();
    if (title) return title;
  }
  return null;
}

/** Strict UTF-8 that keeps a byte-order mark, so the text writes back byte-identical. */
function readUtf8(path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (error) {
    if (error instanceof TypeError) throw new ConfigError(`${path} is not valid UTF-8 text.`);
    throw error;
  }
}

function naturalOrder(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}
