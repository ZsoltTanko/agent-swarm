# Swarm board experiment: design

Status: agreed v1 design, 2026-09-28. Implementation not started.

## Purpose

Anthropology of agent coordination. A small swarm of cheap LLM agents is given an open-ended task over a set of documents, a shared message board, and one shared deliverable. We watch how they use the board: whether conventions and protocols emerge, and how well information one agent finds reaches the others and the final output.

The harness exists to make that behavior visible. Every model call, tool call, post, read, and write is recorded, and a UI lets us watch runs live or replay them tick by tick, down to the exact context any agent saw at any step.

## Principles

- **Coordination is necessary, never instructed.** The environment forces it: no agent can read every document, and there is one deliverable. The prompt describes the tools and says nothing about how to coordinate.
- **Parallel calls, deterministic world.** All agents' model calls in a tick run concurrently; their effects are applied in a seeded order. Given the config, the seed, and the model responses, a run is fully determined.
- **The event log is the source of truth.** The UI and all metrics derive from it.
- **Baseline first.** Experimental knobs live in config, but v1 experiments hold them fixed.

## Concepts

| Term | Meaning |
|---|---|
| Task | A plain-text instruction (`task.md`) plus a folder of documents. Written by the user; knows nothing about swarms. |
| Agent | One model-driven loop with a name, its own context, and a document-read budget. |
| Tick | One lockstep round in which every active agent makes one model call. Agents see ticks as "steps". |
| Board | Shared, append-only message board. |
| Deliverable | One shared text document any agent can overwrite. Its final version is the run's output. |
| Run | One execution of a task under a config and a seed. |
| Event log | Append-only JSONL record of everything that happened in a run. |
| Response cache | Model responses keyed by request hash, seed, and tick. Makes re-runs exact and free. |

## Tasks

```
tasks/<name>/
  task.md      what to do and what the deliverable should be, in plain text
  docs/        the documents: .md or .txt, one file per document
```

- Document id is the filename without extension. Title is the first Markdown heading if there is one, else the filename.
- `task.md` is injected verbatim. It should say what the deliverable is ("Write a one-page memo…", "Produce an annotated timeline…"). The harness adds the fact that the deliverable is shared.
- On load, the harness reports document count and sizes and warns when:
  - `doc_read_budget >= doc count`: no agent needs anyone else;
  - `agents × doc_read_budget < doc count`: the team can't cover the corpus;
  - a document is large relative to the model's context window.
- Each run snapshots the task (`task.md` and docs) into its run folder, so runs stay self-contained if the task changes later.

## What the agents see

Three layers, in order:

1. **Swarm prompt** (system message): a harness-authored template, `prompts/swarm.md`, rendered with the agent's name and facts about the environment. It describes the environment, not strategy.
2. **Task** (inside the system message, delimited): `task.md` verbatim.
3. **Kickoff** (first user message): configurable. Baseline: "Check the board and introduce yourself before you start."

Baseline swarm prompt draft:

```
You are {name}. You are one of several agents who have all been given the
same task and the same tools.

The task involves {doc_count} documents. You can open at most
{doc_read_budget} of them yourself.

All agents share a message board, which everyone can read and post to, and
a single deliverable document, which anyone can read or overwrite. When the
session ends, the deliverable as it stands is the group's output.

The session lasts at most {tick_cap} steps. When you have nothing more to
contribute, call done; after that you can't act again.

<task>
{task}
</task>
```

Agents aren't told how many other agents there are (`roster_known: false`); they find each other through the board. Names come from an unordered pool (Heron, Otter, Wren, Lynx, Moth, Finch, Marten, Ibis, …) and are assigned by seed, so no name implies rank.

## Tools

OpenAI-style function tools. Descriptions state mechanics only.

| Tool | Behavior |
|---|---|
| `read_board()` | Returns every post this agent hasn't received yet: id, author, step, text, reply_to. Free. |
| `post_message(text, reply_to?)` | Appends a post. Longer than `post_max_chars` (baseline 800) is rejected with an error, not truncated. |
| `list_documents()` | Ids, titles, and lengths in words of all documents. Free. |
| `read_document(id)` | Full text. Opening a new document spends one read; re-opening one already opened is free. Over budget returns an error. |
| `read_deliverable()` | Current text, version number, and who wrote that version at which step. Free. |
| `write_deliverable(text)` | Replaces the whole deliverable. The result names the version it replaced and its author ("Saved as v8; replaced v7, written by Otter at step 12"). No locking. |
| `done(note?)` | The agent stops permanently. The note is logged, not shown to other agents. |

The last tool result of every step ends with a status line:

```
[step 9/40 · 3 unread posts · 2 document reads left]
```

It's an ambient cue, like an unread badge, and can be switched off (`status_line`).

Errors (unknown tool, malformed arguments, unknown document, budget exceeded, post too long) come back as tool results the agent sees, and are logged.

## Tick engine

```
for tick in 0 .. tick_cap-1:
    active    = agents that are awake and not done
    responses = await all(active.map(a => model.call(a.context)))    // concurrent
    order     = seededShuffle(active, seed, tick)
    for agent in order:
        apply its tool calls, in the order the model emitted them, to the live world;
        append the results and the status line to its context
        (a response with no tool calls puts the agent to sleep)
    if anyone posted this tick: wake sleeping agents, sending them the status line
    stop if: all agents done
          or all agents asleep or done and nothing was posted this tick
          or cost cap reached
```

What this means when reading a run:

- An agent's decision at tick t is based on the world as of its previous step. The shuffle only decides what its reads return and whose write lands last, so agents react to each other with a one-tick lag.
- Within a tick, effects of agents earlier in the order are visible to reads by agents later in the order.
- A tick takes as long as its slowest call. Reasoning effort mostly determines wall-clock time.
- `max_tool_calls_per_step` (baseline 10) bounds runaway steps; calls beyond it get an error result.
- An agent whose context would exceed the model's context window stops with reason `context_full`. The run continues.
- If a model call still fails after retries, the run aborts with reason `api_error` and the partial log is kept.

## Models via OpenRouter

All model calls go to OpenRouter's OpenAI-compatible chat completions endpoint (`POST https://openrouter.ai/api/v1/chat/completions`) through a thin client on plain `fetch`. We don't use `@openrouter/sdk`: its request schema strips keys it doesn't know (including parts of `reasoning`), and its response parser drops fields we log. The `openai` package would work but adds nothing we need.

### Model config

A model is an id plus a params dict that is merged verbatim into the request body:

```yaml
model:
  id: deepseek/deepseek-v4-flash
  params:
    reasoning: { effort: high }
    temperature: 0.7
    max_tokens: 16000
```

- The harness owns `model`, `messages`, `tools`, and `stream`; setting them in params is a config error. Everything else passes through untouched: reasoning, sampling, `seed`, `provider` routing, and anything OpenRouter adds later.
- The harness doesn't send `tool_choice` (the default, auto, works on every endpoint) or `parallel_tool_calls` (few endpoints list it, which matters under `require_parameters`, below).
- `max_tokens` defaults to 16000 when params don't set it. Reasoning counts against it, and OpenRouter reserves credit against it while calls are in flight, so it should always be explicit.

### Provider pinning

OpenRouter serves most open models from many providers that differ in quantization (fp4, fp8, bf16), context length, parameter support, and price. By default it load-balances across them and falls back on errors, and for requests with tools it reorders them by tool-call quality. Mixing providers within a run would mix model variants, and replaying one provider's reasoning blocks to another is unverified. So each run is pinned to one endpoint:

- If params set `provider.order`, that's the pin.
- Otherwise the harness picks one at run start from `GET /api/v1/models/{id}/endpoints`: healthy (`status` 0), supports every param key plus `tools`, and has enough context and output length. Among those it takes the lowest price for an input-heavy mix (10 input tokens per output token, since every tick re-sends the context) and prints the ranked alternatives.
- Requests carry `provider: { order: [<tag>], allow_fallbacks: false, require_parameters: true }`; anything set explicitly in params wins. `require_parameters` matters: without it OpenRouter silently drops parameters an endpoint doesn't support, and a quietly ignored temperature invalidates an experiment.
- The pinned endpoint is written into the run's resolved config, so re-runs never re-resolve.

### Validation at run start

Checks are per endpoint, because a model's `supported_parameters` list is the union across its endpoints.

- The model exists and the pinned endpoint is healthy.
- The endpoint supports `tools` and every param key.
- `reasoning.effort`, if set, is in the model's `reasoning.supported_efforts`.
- `max_tokens` fits the endpoint's `max_completion_tokens`. The endpoint's `context_length` is the limit behind `context_full`.
- The catalog entry and endpoint record go into `run_started`.

`--dry-run` runs all of this, renders the prompts, and makes no model calls.

### Reasoning

- Requested through params (`reasoning: { effort | max_tokens, exclude, enabled }`). What a model accepts comes from its catalog `reasoning` object (`supported_efforts`, `default_effort`, `mandatory`).
- Responses carry `message.reasoning` (readable text, shown in the UI) and `message.reasoning_details` (structured blocks: text, summary, or encrypted).
- Every assistant message goes back into the agent's context exactly as received, `reasoning_details` included. Several providers require this during tool use: DeepSeek returns a 400 without it when tools are present, and Anthropic rejects modified thinking blocks.

### Per-call record

Each call sends `X-OpenRouter-Metadata: enabled` and `X-OpenRouter-Title: swarm-experiment`. The `model_call` event records:

- `usage`, returned on every response: prompt, completion, reasoning (`completion_tokens_details.reasoning_tokens`), and cached (`prompt_tokens_details.cached_tokens`) tokens, plus `cost` in USD.
- The serving provider and any fallback attempts (`openrouter_metadata`), `system_fingerprint`, the generation id (`X-Generation-Id`), `finish_reason` and `native_finish_reason`, and latency.

### Errors and retries

- **Retried** with exponential backoff and jitter, honoring `Retry-After`:
  - 408, 429, 502, 503, 504, 524, and 529, plus network errors;
  - a 402 that carries `Retry-After` (OpenRouter's in-flight credit reservation);
  - 200 responses that carry a provider or timeout error;
  - empty zero-token responses (cold starts).
- **Not retried:** 400, 401, 403, 404, 413, 422, and 402 without `Retry-After`. The run aborts with the error.
- Only final successful responses are cached.
- `finish_reason: "length"` isn't retried. The response is used as-is and flagged `truncated` in the log and UI; the fix is a higher `max_tokens`.
- The harness validates tool arguments itself. Malformed JSON, unknown tools, and schema mismatches go back to the agent as tool errors. Whether a response has tool calls is decided by a non-empty `tool_calls` array, not by `finish_reason`.
- Calls are non-streaming, with a configurable timeout (`call_timeout_s`, default 600). Node's default 300-second fetch timeouts are raised to match.

### Prompt caching

Agent contexts only ever grow, and the system prompt and tools stay byte-identical for the whole run, so any provider that caches prefixes will get hits. Few open-model endpoints cache implicitly, though (1 of 15 for `deepseek/deepseek-v4-flash`). At these prices it barely matters: a 5-agent, 40-tick run averaging ~20k tokens of context per call is ~4M input tokens, roughly $0.30 on the cheapest `deepseek-v4-flash` endpoints. Explicit `cache_control` breakpoints (Anthropic, Qwen, Gemini) can come later.

### Candidate models (snapshot, 2026-09-28)

Cheap open-weight models whose catalog entries list both `tools` and `reasoning`. Prices are the model-level list prices per million tokens; individual endpoints vary.

| Model | Input $/M | Output $/M | Context | Reasoning |
|---|---|---|---|---|
| `deepseek/deepseek-v4-flash` | 0.062 | 0.125 | 1M | optional; efforts xhigh, high |
| `qwen/qwen3.5-flash-02-23` | 0.065 | 0.26 | 1M | optional; no effort levels listed |
| `google/gemma-4-31b-it` | 0.09 | 0.34 | 262k | optional, off by default |
| `z-ai/glm-5.3-flash` | 0.15 | 0.50 | 1.3M | always on; efforts max, high, low |
| `openai/gpt-oss-120b` | 0.15 | 0.60 | 131k | always on; efforts high, medium, low |

Avoid `:free` variants for swarms; they're capped at 20 requests a minute.

## Determinism, caching, replay

Two separate mechanisms:

- **Replay** means watching a run, finished or in progress. It needs only the run folder and makes no API calls.
- **Re-run** means executing the harness again. Model responses come from the response cache whenever the request matches.

The cache key is a sha256 of the canonical JSON (sorted keys) of the full request body, the run seed, and the tick. So:

- Re-running a run's resolved config (`runs/<run-id>/run.yaml`, which includes the pinned endpoint): every request matches, and the re-run reproduces the event log exactly (timing fields aside) with zero network calls. `--offline` turns any cache miss into an error; that's how determinism gets verified.
- New seed: different shuffles and names and no cache hits, so a fresh sample.
- Forks (later): re-run up to tick N, change something, continue. Everything before the change comes from the cache.

The seed drives the shuffle at each tick (a PRNG seeded from seed and tick), name assignment, and the cache key. Sampling randomness happens at the provider; the cache is what makes it reproducible.

Cache layout: `cache/<hh>/<hash>.json`, one file per response, holding the request, the raw response, and call metadata (provider, latency, usage, cost). Gitignored.

## Event log

`runs/<run-id>/events.jsonl`, one JSON object per line, each with `seq` (monotonic), `tick`, `at` (wall clock), `type`, and a payload.

| Type | Payload |
|---|---|
| `run_started` | resolved config, rendered prompts, task snapshot manifest (doc ids and hashes), seed, catalog entry and pinned endpoint record for each model |
| `tick_started` | active agents, shuffle order |
| `model_call` | agent, cache key, cache hit, assistant message verbatim (content, tool calls, reasoning, reasoning details), finish reason, truncated, usage (prompt, completion, reasoning, cached tokens), cost, provider metadata, system fingerprint, generation id, latency |
| `tool_call` | agent, position in the step, tool, arguments, result exactly as the agent saw it, error |
| `post_created` | post id, author, text, reply_to |
| `board_delivered` | agent, post ids: exact read receipts |
| `document_opened` | agent, doc id, reads left |
| `deliverable_written` | version, author, text, replaced version and its author, whether the writer had seen the version it replaced |
| `agent_slept`, `agent_woke`, `agent_done`, `agent_stopped` | agent, reason or note |
| `run_ended` | reason, totals |

Every message added to an agent's context can be rebuilt from these events, so the UI reconstructs the exact request for any step without the cache. When a run ends, the final deliverable is also written to `runs/<run-id>/deliverable.md`.

## Observer UI

Every view is a function of the event log up to a tick. Live and replay are the same code path: live means the log is still growing, the server streams new lines over SSE, and the view follows the newest tick until you scrub away ("jump to live" returns).

- **Runs list:** task, model, seed, status, ticks, cost, end reason, start time.
- **Run view:**
  - Header: scrubber, play/pause/speed, per-tick activity strip, token and cost totals.
  - Board: posts in commit order with author colors, step stamps, reply links, and read receipts ("seen by"); filter by author.
  - Agent timeline: an agents × ticks grid. Each cell shows that step's actions as icons (read document, read board, post, write deliverable, asleep, done) and the remaining budget.
  - Agent transcript: one agent's full conversation rendered as a chat (system prompt, kickoff, collapsible reasoning, text, tool calls, tool results), cut off at the scrubber's tick.
  - Inspector: the selected step's exact request and raw response JSON, usage, cost, latency, provider, cache hit.
  - Deliverable: version history with diffs and authors, flagging writes that replaced a version the writer never saw.
  - Coverage: a documents × agents grid colored by the tick each document was opened; unread documents and duplicate reads stand out. Clicking a document opens it and shows who read it when.
- **Cross-linking:** selecting a post highlights the step that wrote it and every step that received it; selecting a step highlights what it read and wrote.
- **Search** across posts, agent text and reasoning, and deliverable versions.
- **Keyboard:** ←/→ step through ticks, space plays/pauses, number keys select an agent.

## Metrics

Derived from the log, no task instrumentation needed. Shown in the run summary.

- Coverage: documents opened by at least one agent, duplicate opens, never-opened documents.
- Board participation: posts per agent, first-post tick, replies, post lengths.
- Posting blind: how often an agent posted while it had unread posts.
- Deliverable: versions, distinct authors, overwrites of unseen versions, final length.
- Activity: steps per agent, ticks asleep, tick of done, end reason.
- Cost: tokens (prompt, completion, reasoning, cached) and USD per agent and per tick.

## Configuration

```yaml
task: tasks/example

agents:
  count: 5
  model:
    id: deepseek/deepseek-v4-flash
    params:                       # merged verbatim into the OpenRouter request body
      reasoning: { effort: high }
      temperature: 0.7
      max_tokens: 16000
      # provider: { order: [baidu/fp8] }   # optional; otherwise pinned automatically

environment:
  doc_read_budget: 4
  post_max_chars: 800
  deliverable_max_chars: 20000
  status_line: true
  roster_known: false
  kickoff: "Check the board and introduce yourself before you start."
  prompt_template: prompts/swarm.md

run:
  seed: 1
  tick_cap: 40
  max_tool_calls_per_step: 10
  max_concurrency: 8
  max_cost_usd: 2.00
  call_timeout_s: 600
```

Per-agent model overrides (for mixed swarms) come later; the config and event shapes already carry a model per agent.

CLI:

```bash
npm run swarm -- configs/baseline.yaml --seed 3              # new run
npm run swarm -- configs/baseline.yaml --dry-run             # validate, pin endpoint, render prompts; no model calls
npm run swarm -- runs/<run-id>/run.yaml --offline            # exact re-run from cache; any miss is an error
npm run ui                                                     # server and UI
```

## Stack and layout

TypeScript throughout, Node 22 or later. One package, no monorepo tooling.

```
DESIGN.md
package.json, tsconfig*.json
.env.example              OPENROUTER_API_KEY=
configs/baseline.yaml
prompts/swarm.md
tasks/example/            small hand-written task for development
src/
  shared/                 event and config types, used by the three below
  harness/                CLI, tick engine, environment and tools, OpenRouter client, cache
  server/                 run listing, event streaming (SSE), document and cache lookup
  ui/                     React + Vite
runs/                     gitignored
cache/                    gitignored
```

Dependencies stay small: `zod` for config validation, `yaml`, `tsx` to run TypeScript directly, React and Vite, `diff`, Hono for the server, Vitest. The OpenRouter client is plain `fetch`. The model client is an interface, and tests drive the tick engine with a scripted fake model, so engine behavior is tested without network access.

`OPENROUTER_API_KEY` lives in `.env` (gitignored) and is never written to logs, caches, or run folders.

## Milestones

1. **Harness.** Config and task loading, prompt rendering, environment and tools, tick engine, OpenRouter client with endpoint pinning and validation, cache, event log, CLI, scripted-model tests. Done when a real run on `tasks/example` completes and an `--offline` re-run of its `run.yaml` reproduces its event log with zero network calls.
2. **Observer UI.** Server, runs list, and run view (scrubber, board, timeline, transcript, inspector, deliverable history, coverage, documents), live and replay.
3. **Metrics and ergonomics.** Run summary metrics, search, filters, keyboard navigation, cross-link polish.

## Later

- Forks: re-run to tick N, inject a change (a seeded post, a swapped model, the board removed), continue.
- Experimental variables: roster known, kickoff wording, framing, status line off, threads, post cap, mixed models, a planted bad actor, a no-board control.
- Run comparison across seeds and conditions.
- Transcript coding: LLM-assisted tagging of posts (claim, status, finding, question, proposal, social, meta).
- Instrumented tasks: planted "tracer" facts that make information flow precisely measurable.
- Paged documents or a character-based read budget, for corpora with very uneven document sizes.

## Open questions

- Should a deliverable change wake sleeping agents, or only new posts? (v1: only posts.)
- Should `done` be reversible when new posts arrive? (v1: no.)
- Is 800 characters the right post cap for the documents we'll use?
