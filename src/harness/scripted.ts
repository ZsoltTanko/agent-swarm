import { createHash } from "node:crypto";
import type { AssistantMessage, ToolCall, Usage } from "../shared/types.ts";
import type { ModelClient, ModelRequest, ModelResult } from "./types.ts";

/**
 * A deterministic fake agent for tests and --scripted runs. Each response is a pure function of the
 * request: the agent reads its name from the system prompt and its situation from its own earlier tool
 * calls and their results, then follows a plausible plan (introduce, claim documents, read, post notes,
 * draft or extend the deliverable, wait, sign off), with the occasional mistake.
 */
export function createScriptedModelClient(): ModelClient {
  return {
    async call(request: ModelRequest): Promise<ModelResult> {
      return scriptedResult(request);
    },
  };
}

const INPUT_USD_PER_MILLION = 0.06;
const OUTPUT_USD_PER_MILLION = 0.12;

/** Reasoning prefixes that mark waiting steps, so later calls can count them. */
const WAITING_FOR_DRAFT = "No draft on the deliverable yet";
const WAITING_FOR_ADDITIONS = "Waiting for the others to add their notes";

export function scriptedResult(request: ModelRequest): ModelResult {
  const hash = sha256(canonicalJson(request));
  const plan = decide(observe(request));
  const toolCalls: ToolCall[] = plan.calls.map((call, index) => ({
    id: `call_${sha256(`${hash}:${index}`).slice(0, 24)}`,
    type: "function",
    function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) },
  }));
  const message: AssistantMessage = { role: "assistant", content: plan.content ?? "" };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  message.refusal = null;
  message.reasoning = plan.reasoning;
  message.reasoning_details = [{ type: "reasoning.text", text: plan.reasoning, format: "unknown", index: 0 }];
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  return {
    message,
    finish_reason: finishReason,
    native_finish_reason: finishReason,
    truncated: false,
    usage: estimateUsage(request, message),
    provider: "Scripted",
    openrouter_metadata: null,
    system_fingerprint: null,
    generation_id: `gen-scripted-${hash.slice(0, 24)}`,
    latency_ms: 600 + (Number.parseInt(hash.slice(0, 8), 16) % 401),
    cache_key: hash,
    cache_hit: false,
    attempts: 1,
  };
}

/* ---------- What the agent knows ---------- */

interface PastCall {
  name: string;
  /** Null when the arguments weren't a JSON object. */
  args: Record<string, unknown> | null;
  /** The tool result without the status line; null if no result came back. */
  result: string | null;
}

interface PastStep {
  reasoning: string;
  calls: PastCall[];
}

interface BoardPost {
  id: number;
  author: string;
  text: string;
}

interface DeliverableView {
  version: number;
  author: string | null;
  text: string;
  /** Known from the agent's own write rather than a read. */
  mine: boolean;
}

interface Situation {
  name: string;
  /** The agent's past steps (model calls) in this run; its length is the current step's index. */
  steps: PastStep[];
  budget: number;
  postMaxChars: number;
  deliverableMaxChars: number;
  /** From the latest status line; unread is null when the line doesn't give it. */
  clock: Clock | null;
  docs: { id: string; title: string }[];
  opened: Map<string, { title: string; text: string }>;
  /** Every post the agent has seen, its own included. */
  board: Map<number, BoardPost>;
  /** The latest version the agent has read or written. */
  deliverable: DeliverableView | null;
}

interface Clock {
  tick: number;
  cap: number;
  unread: number | null;
}

const STATUS_LINE = /^\[step (\d+)\/(\d+)(?: · ([\d,]+) unread posts?)?[^\]\n]*\]$/;
const DOC_HEADER = /^(.+?) · "(.*)" · [\d,]+ words?(?: \(opened\))?$/;
const POST_HEADER = /^#(\d+) (\S+) \(step \d+(?:, reply to #\d+)?\): /;
const NOTE_LINE = /^- `([^`]+)` \("(.*?)"\): "(.*)"/;

function observe(request: ModelRequest): Situation {
  const system = request.messages.find((message) => message.role === "system")?.content ?? "";
  const describe = (tool: string): string =>
    request.tools.find((definition) => definition.function.name === tool)?.function.description ?? "";
  const situation: Situation = {
    name: /\bYou are ([A-Z][\w-]*)\./.exec(system)?.[1] ?? "Agent",
    steps: [],
    budget:
      numberIn(describe("read_document"), /one of your ([\d,]+) document reads/) ??
      numberIn(system, /open at most ([\d,]+)/) ??
      3,
    postMaxChars: numberIn(describe("post_message"), /At most ([\d,]+) characters/) ?? 800,
    deliverableMaxChars: numberIn(describe("write_deliverable"), /At most ([\d,]+) characters/) ?? 20000,
    clock: null,
    docs: [],
    opened: new Map(),
    board: new Map(),
    deliverable: null,
  };

  const byId = new Map<string, PastCall>();
  for (const message of request.messages) {
    if (message.role === "assistant") {
      const step: PastStep = { reasoning: reasoningOf(message), calls: [] };
      for (const call of message.tool_calls ?? []) {
        const past: PastCall = { name: call.function.name, args: jsonObject(call.function.arguments), result: null };
        step.calls.push(past);
        byId.set(call.id, past);
      }
      situation.steps.push(step);
    } else if (message.role === "tool") {
      const { body, clock } = splitStatusLine(message.content);
      if (clock !== null) situation.clock = clock;
      const past = byId.get(message.tool_call_id);
      if (past !== undefined) {
        past.result = body;
        absorb(situation, past);
      }
    } else if (message.role === "user") {
      const clock = parseClock(message.content.trim());
      if (clock !== null) situation.clock = clock;
    }
  }
  return situation;
}

/** Updates what the agent knows from one tool call and its result. */
function absorb(s: Situation, call: PastCall): void {
  const result = call.result ?? "";
  const text = typeof call.args?.text === "string" ? call.args.text : "";
  switch (call.name) {
    case "list_documents":
      s.docs = result
        .split("\n")
        .slice(1)
        .flatMap((line) => {
          const match = DOC_HEADER.exec(line.replace(/^- /, ""));
          return match ? [{ id: match[1]!, title: match[2]! }] : [];
        });
      break;
    case "read_document": {
      const split = result.indexOf("\n\n");
      const match = split === -1 ? null : DOC_HEADER.exec(result.slice(0, split));
      if (match) s.opened.set(match[1]!, { title: match[2]!, text: result.slice(split + 2) });
      break;
    }
    case "read_board":
      if (!/^[\d,]+ new posts?:\n/.test(result)) break;
      for (const chunk of result.slice(result.indexOf("\n") + 1).split(/\n(?=#\d+ \S+ \(step \d+(?:, reply to #\d+)?\): )/)) {
        const match = POST_HEADER.exec(chunk);
        if (match) s.board.set(Number(match[1]), { id: Number(match[1]), author: match[2]!, text: chunk.slice(match[0].length) });
      }
      break;
    case "post_message": {
      const match = /^Posted as #(\d+)\.$/.exec(result);
      if (match) s.board.set(Number(match[1]), { id: Number(match[1]), author: s.name, text });
      break;
    }
    case "read_deliverable": {
      if (result === "The deliverable is empty.") {
        s.deliverable = { version: 0, author: null, text: "", mine: false };
        break;
      }
      const match = /^Deliverable v(\d+), written by (\S+) at step \d+:\n\n/.exec(result);
      if (match) {
        s.deliverable = { version: Number(match[1]), author: match[2]!, text: result.slice(match[0].length), mine: false };
      }
      break;
    }
    case "write_deliverable": {
      const match = /^Saved as v(\d+);/.exec(result);
      if (match) s.deliverable = { version: Number(match[1]), author: s.name, text, mine: true };
      break;
    }
    default:
      break;
  }
}

/* ---------- Derived facts ---------- */

const pastCalls = (s: Situation): PastCall[] => s.steps.flatMap((step) => step.calls);
const readsLeft = (s: Situation): number => Math.max(0, s.budget - s.opened.size);
const postsBy = (s: Situation, mine: boolean): BoardPost[] =>
  [...s.board.values()].sort((a, b) => a.id - b.id).filter((post) => (post.author === s.name) === mine);
const backticked = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
const isIntro = (post: BoardPost): boolean => post.text.startsWith(`Hi, I'm ${post.author}.`);
const isNotes = (post: BoardPost): boolean => post.text.startsWith("Notes on ");

function myClaim(s: Situation): string[] | null {
  const intro = postsBy(s, true).find(isIntro);
  return intro ? backticked(intro.text) : null;
}

function otherClaims(s: Situation): { post: BoardPost; docs: string[] }[] {
  return postsBy(s, false)
    .filter(isIntro)
    .map((post) => ({ post, docs: backticked(post.text) }));
}

function notesPosted(s: Situation): Set<string> {
  return new Set(postsBy(s, true).filter(isNotes).flatMap((post) => backticked(post.text.split("\n")[0] ?? "")));
}

function myWrites(s: Situation): PastCall[] {
  return pastCalls(s).filter((call) => call.name === "write_deliverable" && /^Saved as v/.test(call.result ?? ""));
}

/** The alphabetically first agent the agent knows of drafts the deliverable. */
function isDrafter(s: Situation): boolean {
  const names = [s.name, ...postsBy(s, false).map((post) => post.author)].sort();
  return names[0] === s.name;
}

/** A step after which the agent slept: it called only wait, or made no tool calls. */
const isSleep = (step: PastStep | undefined): boolean =>
  step !== undefined && step.calls.every((past) => past.name === "wait");

function mySection(s: Situation): string {
  return `## Notes from ${s.name}`;
}

/* ---------- Planning ---------- */

interface PlannedCall {
  name: string;
  /** A string is sent verbatim as the arguments, malformed or not. */
  args: Record<string, unknown> | string;
}

interface Plan {
  content: string | null;
  reasoning: string;
  calls: PlannedCall[];
}

function decide(s: Situation): Plan {
  if (s.steps.length === 0) return orient(s);
  if (s.clock !== null && s.clock.tick + 1 >= s.clock.cap) {
    return finish(s, "I'm out of steps, so I'll stop here.", false);
  }
  return withQuirk(s, introduce(s) ?? read(s) ?? report(s) ?? contribute(s));
}

function orient(s: Situation): Plan {
  return {
    content: aside(s, "orient", "Let me look around before I start."),
    reasoning: "I should see who else is on the board and what the documents are before I claim anything.",
    calls: [call("read_board"), call("list_documents")],
  };
}

function introduce(s: Situation): Plan | null {
  if (myClaim(s) !== null) return null;
  const others = otherClaims(s);
  const claim = chooseClaim(s, new Set(others.flatMap((other) => other.docs)));
  let text = `Hi, I'm ${s.name}.`;
  text += claim.length > 0 ? ` I'll take ${listIds(claim)}.` : " I don't see any documents yet.";
  text +=
    others.length > 0
      ? ` I see ${listNames(others.map((other) => other.post.author))} already posted, so I picked around their claims.`
      : " I'll post notes on each one as I read it.";
  const calls = [call("post_message", { text: fit(text, s.postMaxChars) })];
  if (claim[0] !== undefined && readsLeft(s) > 0) calls.push(call("read_document", { id: claim[0] }));
  if (s.docs.length === 0) calls.push(call("list_documents"));
  return {
    content: aside(s, "introduce", "Introducing myself and claiming a few documents."),
    reasoning:
      claim.length > 0
        ? `I'll introduce myself and claim ${listIds(claim)} so we don't all read the same things. I can start on ${claim[0]} right away.`
        : "I'll introduce myself; there are no documents to claim yet.",
    calls,
  };
}

/** A contiguous (wrapping) range of documents starting at a name-derived offset, avoiding claimed ones when possible. */
function chooseClaim(s: Situation, claimed: Set<string>): string[] {
  const ids = s.docs.map((doc) => doc.id);
  if (ids.length === 0) return [];
  const offset = hashInt(`claim:${s.name}`) % ids.length;
  const rotated = [...ids.slice(offset), ...ids.slice(0, offset)];
  const preferred = [...rotated.filter((id) => !claimed.has(id)), ...rotated.filter((id) => claimed.has(id))];
  return preferred.slice(0, Math.min(s.budget, ids.length));
}

function read(s: Situation): Plan | null {
  const claim = myClaim(s) ?? [];
  const attempts = new Map<string, number>();
  for (const past of pastCalls(s)) {
    const id = past.name === "read_document" ? past.args?.id : undefined;
    if (typeof id === "string") attempts.set(id, (attempts.get(id) ?? 0) + 1);
  }
  const claimedByAnyone = new Set([...claim, ...otherClaims(s).flatMap((other) => other.docs)]);
  const readable = (id: string): boolean =>
    !s.opened.has(id) && (attempts.get(id) ?? 0) < 2 && s.docs.some((doc) => doc.id === id);
  const targets = [
    ...claim.filter(readable),
    ...s.docs.map((doc) => doc.id).filter((id) => !claimedByAnyone.has(id) && readable(id)),
  ].slice(0, Math.min(2, readsLeft(s)));
  if (targets.length === 0) return null;
  const extra = targets.filter((id) => !claim.includes(id));
  return {
    content: aside(s, `read:${s.steps.length}`, `Reading ${listIds(targets)}.`),
    reasoning:
      extra.length > 0
        ? `Nobody has claimed ${listIds(extra)}, and I still have reads left, so I'll cover it.`
        : `Next I'll read ${listIds(targets)} from my claim and check the board.`,
    calls: [...targets.map((id) => call("read_document", { id })), call("read_board")],
  };
}

function report(s: Situation): Plan | null {
  const posted = notesPosted(s);
  const fresh = [...s.opened.keys()].filter((id) => !posted.has(id));
  // Each notes post covers at least one document; the count bound stops reposting if ids were cut off.
  if (fresh.length === 0 || postsBy(s, true).filter(isNotes).length >= s.opened.size) return null;

  const overlap = otherClaims(s).find((other) => other.docs.some((id) => fresh.includes(id)));
  const shared = overlap ? overlap.docs.filter((id) => fresh.includes(id)) : [];
  const header = `Notes on ${listIds(fresh)}${overlap ? ` (we overlap on ${listIds(shared)})` : ""}:`;
  const calls = [
    call("post_message", {
      text: notesText(s, header, fresh),
      ...(overlap ? { reply_to: overlap.post.id } : {}),
    }),
  ];

  const triedOverBudget = pastCalls(s).some((past) => (past.result ?? "").startsWith("You've used all"));
  const unopened = s.docs.map((doc) => doc.id).filter((id) => !s.opened.has(id));
  let reasoning = `I've read ${listIds(fresh)}. I'll share a line from each so the others can use it.`;
  if (readsLeft(s) === 0 && !triedOverBudget && unopened[0] !== undefined) {
    calls.push(call("read_document", { id: unopened[0] }));
    reasoning += ` I'd also like to look at ${unopened[0]}, though I may be out of reads.`;
  }
  calls.push(call("read_deliverable"));
  return { content: aside(s, "report", "Posting my notes."), reasoning, calls };
}

function notesText(s: Situation, header: string, ids: string[]): string {
  const lines = ids.map((id) => {
    const doc = s.opened.get(id)!;
    return { prefix: `- \`${id}\` ("${doc.title}"): "`, quote: quoteFrom(doc.text, `${s.name}:${id}`) };
  });
  const fixed = header.length + lines.reduce((sum, line) => sum + line.prefix.length + 2, 0);
  const perQuote = Math.max(20, Math.floor((s.postMaxChars - fixed) / Math.max(1, lines.length)));
  const body = lines.map((line) => `${line.prefix}${fit(line.quote, perQuote)}"`);
  return fit([header, ...body].join("\n"), s.postMaxChars);
}

/**
 * The deliverable phase. The drafter (see isDrafter) writes a first draft, waits a few steps for
 * additions without ever sleeping, and always signs off with a post. Everyone else sleeps until a draft
 * appears, appends a section of their own, and re-adds it if a later write dropped it. Because the drafter
 * stays awake and posts on the way out, a sleeping agent is always woken eventually.
 */
function contribute(s: Situation): Plan {
  const writes = myWrites(s);
  const deliverable = s.deliverable;
  if (writes.length === 0) {
    if (deliverable === null) return checkDeliverable(s, "Let me see where the deliverable stands.");
    if (deliverable.version > 0) return extend(s, deliverable);
    const waited = s.steps.filter((step) => isSleep(step) || step.reasoning.startsWith(WAITING_FOR_DRAFT)).length;
    if (isDrafter(s) || waited >= 3) return draft(s);
    const announced = postsBy(s, false).some((post) => post.text.includes("first draft"));
    if (announced) return checkDeliverable(s, "Someone said there's a draft; I'll read it before adding to it.");
    if (!isSleep(s.steps.at(-1))) return sleep(s, "The deliverable is still empty. I'll wait for a draft before adding anything.");
    return {
      content: null,
      reasoning: `${WAITING_FOR_DRAFT}. I'll check the board and the deliverable again.`,
      calls: [call("read_board"), call("read_deliverable")],
    };
  }

  if (deliverable === null || deliverable.mine) {
    return checkDeliverable(s, "I'll re-read the deliverable to make sure my write is still there.");
  }

  // Every write of an extender carries its section; a first write without one was a draft.
  const drafted = writes[0]?.args?.text;
  if (typeof drafted === "string" && !drafted.includes(mySection(s))) {
    const extended = deliverable.author !== s.name;
    const lastWrite = s.steps.findLastIndex((step) => step.calls.some((past) => past.name === "write_deliverable"));
    const waits = s.steps.slice(lastWrite + 1).filter((step) => step.reasoning.startsWith(WAITING_FOR_ADDITIONS)).length;
    if (extended) return finish(s, "The others have built on the draft. My part is done.", true);
    if (postsBy(s, false).length === 0 || waits >= 3) {
      return finish(s, "No one has added to the draft, but I've done what I can.", true);
    }
    return {
      content: null,
      reasoning: `${WAITING_FOR_ADDITIONS}. I'll check the board and the deliverable.`,
      calls: [call("read_board"), call("read_deliverable")],
    };
  }

  if (deliverable.text.includes(mySection(s))) {
    return finish(s, "My notes are in the deliverable.", hashInt(`signoff:${s.name}`) % 2 === 0);
  }
  if (writes.length >= 3) return finish(s, "I've tried to add my notes several times; I'll leave it here.", true);
  return extend(s, deliverable);
}

function checkDeliverable(s: Situation, reasoning: string): Plan {
  return {
    content: aside(s, `check:${s.steps.length}`, "Checking the deliverable."),
    reasoning,
    calls: [call("read_deliverable"), call("read_board")],
  };
}

function draft(s: Situation): Plan {
  const findings = collectFindings(s);
  const covered = new Set(findings.map((finding) => finding.id));
  const gaps = s.docs.filter((doc) => !covered.has(doc.id));
  const lines = [
    "# Working draft",
    "",
    `Started by ${s.name} from the notes on the board. Add to it rather than replacing it.`,
    "",
    "## Findings",
    ...findings.map((finding) => `- \`${finding.id}\` ("${finding.title}"): "${finding.quote}" (${finding.who})`),
  ];
  if (gaps.length > 0) lines.push("", "## Not covered yet", ...gaps.map((doc) => `- \`${doc.id}\` ("${doc.title}")`));
  const text = fit(lines.join("\n"), s.deliverableMaxChars);
  return {
    content: aside(s, "draft", "Starting the deliverable."),
    reasoning: `The deliverable is still empty. I'll start a first draft from ${findings.length} findings so there's something to build on.`,
    calls: [
      call("write_deliverable", { text }),
      call("post_message", {
        text: `I've put up a first draft of the deliverable with ${findings.length} findings. Please add your notes to it rather than rewriting it.`,
      }),
    ],
  };
}

function extend(s: Situation, base: DeliverableView): Plan {
  const lines = [...s.opened.entries()].map(
    ([id, doc]) => `- \`${id}\` ("${doc.title}"): "${fit(quoteFrom(doc.text, `${s.name}:${id}`), 240)}"`,
  );
  const section = [mySection(s), ...(lines.length > 0 ? lines : ["- Nothing to add from my documents."])].join("\n");
  const text = fit(`${base.text.trimEnd()}\n\n${section}`, s.deliverableMaxChars);
  const retry = myWrites(s).length > 0;
  const announcement = postsBy(s, false).find((post) => post.text.includes("first draft"));
  const myLastPost = postsBy(s, true).at(-1);
  const replyTo = retry ? myLastPost?.id : announcement?.id;
  const post = retry
    ? `My notes were missing from v${base.version}, so I've added them back.`
    : `I've added my notes to the deliverable, on top of v${base.version}.`;
  return {
    content: aside(s, `extend:${base.version}`, "Adding my section."),
    reasoning: retry
      ? `My section isn't in v${base.version}; someone must have overwritten it. I'll add it back on top of their version.`
      : `There's a draft at v${base.version}. I'll append my notes as a section of my own.`,
    calls: [
      call("write_deliverable", { text }),
      call("post_message", replyTo === undefined ? { text: post } : { text: post, reply_to: replyTo }),
    ],
  };
}

function finish(s: Situation, reasoning: string, signOff: boolean): Plan {
  const calls: PlannedCall[] = [];
  if (signOff) {
    const latest = postsBy(s, false).filter((post) => post.text.includes("deliverable")).at(-1);
    const text = `Signing off. I read ${s.opened.size > 0 ? listIds([...s.opened.keys()]) : "no documents"}; the deliverable is at v${s.deliverable?.version ?? 0} as far as I know.`;
    calls.push(call("post_message", latest === undefined ? { text } : { text, reply_to: latest.id }));
  }
  const withNote = hashInt(`note:${s.name}`) % 3 !== 0;
  calls.push(call("done", withNote ? { note: `Opened ${s.opened.size} of ${s.docs.length} documents.` } : {}));
  return { content: aside(s, "finish", "That's all from me."), reasoning, calls };
}

/**
 * Some agents wait with the wait tool, others by ending the step without tool calls. Posts the status line
 * already announced won't wake a waiting agent, so an agent with unread posts reads the board instead.
 */
function sleep(s: Situation, content: string): Plan {
  if ((s.clock?.unread ?? 0) > 0) {
    return { content: null, reasoning: "There are unread posts; I'll read them first.", calls: [call("read_board")] };
  }
  const reasoning = "There's nothing for me to do until someone posts.";
  if (hashInt(`wait:${s.name}`) % 2 === 0) return { content, reasoning, calls: [call("wait")] };
  return { content, reasoning, calls: [] };
}

/** Each agent makes one characteristic mistake from its third step on: a malformed call or an unknown tool. */
function withQuirk(s: Situation, plan: Plan): Plan {
  if (s.steps.length < 2 || plan.calls.length === 0 || plan.calls.some((planned) => planned.name === "done")) {
    return plan;
  }
  const quirkDone = pastCalls(s).some(
    (past) => past.name === "search_documents" || (past.name === "post_message" && past.args === null),
  );
  if (quirkDone) return plan;
  switch (hashInt(`quirk:${s.name}`) % 3) {
    case 0:
      return {
        ...plan,
        calls: [...plan.calls, call("post_message", `{"text": "Quick update from ${s.name}: still working through my documents`)],
      };
    case 1: {
      const topic = s.docs[0]?.title.split(/\s+/)[0] ?? "summary";
      return { ...plan, calls: [call("search_documents", { query: topic.toLowerCase() }), ...plan.calls] };
    }
    default:
      return plan;
  }
}

function collectFindings(s: Situation): { id: string; title: string; quote: string; who: string }[] {
  const findings = [...s.opened.entries()].map(([id, doc]) => ({
    id,
    title: doc.title,
    quote: fit(quoteFrom(doc.text, `${s.name}:${id}`), 240),
    who: s.name,
  }));
  for (const post of postsBy(s, false).filter(isNotes)) {
    for (const line of post.text.split("\n")) {
      const match = NOTE_LINE.exec(line);
      if (match && !findings.some((finding) => finding.id === match[1])) {
        findings.push({ id: match[1]!, title: match[2]!, quote: match[3]!.replace(/"$/, ""), who: post.author });
      }
    }
  }
  return findings;
}

/* ---------- Helpers ---------- */

function call(name: string, args: Record<string, unknown> | string = {}): PlannedCall {
  return { name, args };
}

/** Content text on roughly a third of steps. */
function aside(s: Situation, salt: string, text: string): string | null {
  return hashInt(`aside:${s.name}:${salt}`) % 3 === 0 ? text : null;
}

/** One of the first few sentences of a document's prose, chosen by salt. */
function quoteFrom(text: string, salt: string): string {
  const prose = text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .join(" ");
  const sentences = prose
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);
  if (sentences.length === 0) return prose.slice(0, 120).trim() || "(no text)";
  const readable = sentences.filter((sentence) => sentence.length <= 200);
  const pool = readable.length > 0 ? readable : sentences;
  return pool[hashInt(salt) % Math.min(3, pool.length)]!;
}

function fit(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function listIds(ids: string[]): string {
  return listNames(ids.map((id) => `\`${id}\``));
}

function listNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function numberIn(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  return match ? Number(match[1]!.replaceAll(",", "")) : null;
}

function parseClock(text: string): Clock | null {
  const match = STATUS_LINE.exec(text);
  if (!match) return null;
  const unread = match[3] === undefined ? null : Number(match[3].replaceAll(",", ""));
  return { tick: Number(match[1]), cap: Number(match[2]), unread };
}

function splitStatusLine(content: string): { body: string; clock: Clock | null } {
  const index = content.lastIndexOf("\n\n[step ");
  if (index !== -1) {
    const clock = parseClock(content.slice(index + 2));
    if (clock !== null) return { body: content.slice(0, index), clock };
  }
  return { body: content, clock: null };
}

function reasoningOf(message: AssistantMessage): string {
  const first = message.reasoning_details?.[0] as { text?: unknown } | undefined;
  if (typeof first?.text === "string") return first.text;
  return typeof message.reasoning === "string" ? message.reasoning : "";
}

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw === "" ? "{}" : raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function estimateUsage(request: ModelRequest, message: AssistantMessage): Usage {
  const promptChars = JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
  const outputChars = (message.content ?? "").length + (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0);
  const reasoningTokens = Math.ceil((message.reasoning ?? "").length / 4);
  const promptTokens = Math.ceil(promptChars / 4);
  const completionTokens = Math.ceil(outputChars / 4) + reasoningTokens;
  const cost = (promptTokens * INPUT_USD_PER_MILLION + completionTokens * OUTPUT_USD_PER_MILLION) / 1_000_000;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    reasoning_tokens: reasoningTokens,
    cached_tokens: 0,
    cost_usd: Math.round(cost * 1e12) / 1e12,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashInt(text: string): number {
  return Number.parseInt(sha256(text).slice(0, 8), 16);
}

/** JSON with object keys sorted, so equal requests hash equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}
