# Swarm board experiment: design

Status: agreed v1 design, 2026-09-28. The harness and server are built; the UI is in progress.

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
| Response cache | Model responses keyed by request hash, seed, tick, and agent. Makes re-runs exact and free. |

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
  - a document is large relative to the model's context window;
  - there is one agent: the swarm prompt describes a group, so a solo run needs its own template.
- Each run snapshots the task (`task.md` and docs) into its run folder, so runs stay self-contained if the task changes later. The run's resolved config records the task's name (`task_name`), since its `task` path then points at the snapshot.
- In a run's `run.yaml`, `task` and `prompt_template` are relative to the run folder (`task`, `prompt.md`), so a moved or copied folder re-runs from its own snapshot. The CLI treats any config file named `run.yaml` this way; other configs' paths are relative to the project root.

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

Agents aren't told how many other agents there are (`roster_known: false`); they find each other through the board. Names come from an unordered pool (Heron, Otter, Wren, Lynx, Moth, Finch, Marten, Ibis, …) and are assigned by seed, so no name implies rank. The resolved `run.yaml` records the names (`agents.names`), so a re-run never depends on the pool; a config can also set them explicitly.

## Tools

OpenAI-style function tools. Descriptions state mechanics only.

| Tool | Behavior |
|---|---|
| `read_board()` | Returns every post this agent hasn't received yet: id, author, step, text, reply_to. Free. |
| `post_message(text, reply_to?)` | Appends a post. Longer than `post_max_chars` (baseline 800) is rejected with an error, not truncated. |
| `list_documents()` | Ids, titles, and lengths in words of all documents, marking the ones this agent has opened with "(opened)". Free. |
| `read_document(id)` | Full text. Opening a new document spends one read; re-opening one already opened is free. Over budget returns an error. |
| `read_deliverable()` | Current text, version number, and who wrote that version at which step. Free. |
| `write_deliverable(text)` | Replaces the whole deliverable. The result names the version it replaced and its author ("Saved as v8; replaced v7, written by Otter at step 12"). No locking. |
| `wait()` | Offered when `environment.wait_tool` is on (the default). The agent falls asleep when its step ends (its other calls in the step still run) and takes no steps until another agent posts something it hasn't been told about. Result: "You'll wait until another agent posts." `done` in the same step takes precedence. |
| `done(note?)` | The agent stops permanently. The note is logged, not shown to other agents. |

The last tool result of every step ends with a status line:

```
[step 9/40 · 3 unread posts · 2 document reads left]
```

It's an ambient cue, like an unread badge, and can be switched off (`status_line`). Off, no tool result carries it, and a woken agent is sent only `[step 9/40]`.

Errors (unknown tool, malformed arguments or tool call, unknown document, budget exceeded, post too long) come back as tool results the agent sees, and are logged.

## Tick engine

```
for tick in 1 .. tick_cap:
    active    = agents that are awake and not done
    responses = await all(active.map(a => model.call(a.context)))    // concurrent
    order     = seededShuffle(active, seed, tick)
    for agent in order:
        apply its tool calls, in the order the model emitted them, to the live world;
        append the results and the status line to its context
        (calling wait, or a response with no tool calls, puts the agent to sleep
         once its step has been applied)
    wake each sleeping agent that has a post by another agent newer than its
        sleep marker (below), sending it the status line
    stop, with the first reason that applies:
        all_done     all agents done
        all_stopped  all agents done or stopped, at least one stopped (context_full)
        quiescent    all agents asleep, done, or stopped after the wakes
        cost_cap     cost cap reached
        tick_cap     tick cap reached
```

A natural end (`all_done`, `all_stopped`, `quiescent`) is reported over a cap reached on the same tick.

What this means when reading a run:

- An agent's decision at tick t is based on the world as of its previous step. The shuffle only decides what its reads return and whose write lands last, so agents react to each other with a one-tick lag.
- Within a tick, effects of agents earlier in the order are visible to reads by agents later in the order.
- An agent's sleep marker is the highest post id it can know of, and only goes up. It is raised when the agent is woken, to the highest post id that exists then (the wake is the notice), and when each of its steps finishes applying: with the status line on, to the highest post id that exists then (the status line has just told it how many posts are unread); with it off, to the highest post id it has been shown by `read_board` or as the id of its own post, since nothing else tells it about posts. It is 0 before the agent's first step. So a post the agent never learned of, such as one that lands after its step later in the same tick, still wakes it if its next response makes no tool calls. An agent that calls `wait` falls asleep after its marker is raised for that step, so posts its status line has just counted as unread don't wake it; only newer ones do.
- A tick takes as long as its slowest call. Reasoning effort mostly determines wall-clock time.
- `max_tool_calls_per_step` (baseline 10) bounds runaway steps; calls beyond it get an error result.
- An agent whose context would exceed the model's context window stops with reason `context_full`. The run continues.
- If a model call still fails after retries, the run aborts with reason `api_error` and the partial log is kept.
- Ctrl-C aborts the calls in flight, backoff waits included, and ends the run with reason `interrupted` (exit code 130). That tick isn't applied; the partial log is kept.
- When a tick aborts (`api_error`, `interrupted`), the calls of that tick that did return were paid for and cached. `run_ended` lists them as `unapplied`, and its cost totals include them.

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
- Otherwise the harness picks one at run start from `GET /api/v1/models/{id}/endpoints`: healthy (`status` 0 and, when reported, at least 95% uptime over the last 5 minutes), supports every param key plus `tools` (and the `tool_choice` mode, if params set one), has enough context and output length, and passes the params' own `provider` filters (`only`, `ignore`, `quantizations`, and the prompt and completion `max_price`). Among those it takes the lowest price for an input-heavy mix (10 input tokens per output token, since every tick re-sends the context) and prints the ranked alternatives. `provider.sort` and the `preferred_*` fields can't take effect once the run is pinned, so they draw a warning. An automatic pin always draws a warning too: list prices don't predict speed or real cost (in measured runs, the cheapest-listed endpoint was 3× slower per token and cost 3× more per call, because endpoints differ in caching and output length), and the cheapest endpoint changes from day to day. The shipped configs therefore pin a measured endpoint explicitly, which also keeps runs of different conditions on the same model variant.
- Requests carry `provider: { order: [<tag>], allow_fallbacks: false, require_parameters: true }`; anything set explicitly in params wins. `require_parameters` matters: without it OpenRouter silently drops parameters an endpoint doesn't support, and a quietly ignored temperature invalidates an experiment.
- The pinned endpoint is written into the run's resolved config, so re-runs never re-resolve: re-running a run's `run.yaml` makes no catalog lookup.

### Validation at run start

Checks are per endpoint, because a model's `supported_parameters` list is the union across its endpoints.

- The model exists and the pinned endpoint is healthy.
- The endpoint supports `tools` and every param key, and, when params set `tool_choice`, that mode (its `supports_tool_choice`).
- The endpoint passes the params' `provider` filters (`only`, `ignore`, `quantizations`, `max_price`).
- Reasoning params fit the model's catalog `reasoning` object:
  - `reasoning.effort` (or `reasoning_effort`) must be in `supported_efforts`. A `null` list accepts any effort; a model that omits the list has no effort selection, so an effort is rejected there.
  - A model whose reasoning is `mandatory` rejects `enabled: false` and effort `none`.
  - `effort` and `max_tokens` can't both be set.
- `max_tokens` fits the endpoint's `max_completion_tokens`. The endpoint's `context_length` is the limit behind `context_full`.
- The catalog entry and endpoint record go into `run_started`.

`--dry-run` runs all of this, renders the prompts, and makes no model calls.

### Reasoning

- Requested through params (`reasoning: { effort | max_tokens, exclude, enabled }`). What a model accepts comes from its catalog `reasoning` object (`supported_efforts`, `default_effort`, `mandatory`).
- Responses carry `message.reasoning` (readable text, shown in the UI) and `message.reasoning_details` (structured blocks: text, summary, or encrypted).
- Every assistant message goes back into the agent's context with its content, tool calls, and `reasoning_details` exactly as received (`reasoning` instead, when there are no details). Several providers require this during tool use: DeepSeek returns a 400 without it when tools are present, and Anthropic rejects modified thinking blocks.

### Per-call record

Each call sends `X-OpenRouter-Metadata: enabled` and `X-OpenRouter-Title: swarm-experiment`. The `model_call` event records:

- `usage`, returned on every response: prompt, completion, reasoning (`completion_tokens_details.reasoning_tokens`), and cached (`prompt_tokens_details.cached_tokens`) tokens, plus `cost` in USD.
- The serving provider and any fallback attempts (`openrouter_metadata`), `system_fingerprint`, the generation id (`X-Generation-Id`), `finish_reason` and `native_finish_reason`, latency, and how many requests the call took (`attempts`, 1 when it wasn't retried).

### Errors and retries

- **Retried** with exponential backoff and jitter, honoring `Retry-After`:
  - 408, 429, 500, 502, 503, 504, 524, and 529, plus network errors;
  - a 402 that carries `Retry-After` (OpenRouter's in-flight credit reservation);
  - 200 responses that carry a provider or timeout error, in the body or in the choice (a choice error is classified like a body error; a bare `finish_reason: "error"` is retried);
  - empty zero-token responses (cold starts): no completion tokens, a blank finish reason, and no content, refusal, tool calls, or reasoning. A refusal (`message.refusal`, `finish_reason: "content_filter"`) is an answer, not an error;
  - responses whose `tool_calls` entries lack a string `id`, `function.name`, or `function.arguments`.
- **Not retried:** 400, 401, 403, 404, 413, 422, and 402 without `Retry-After`. The run aborts with the error.
- Final successful responses are cached, and so are context-length failures: they are the final outcome of that request (the agent stops with `context_full`), so a re-run must stop the agent the same way without calling again. Nothing else that fails is cached.
- `finish_reason: "length"` isn't retried. The response is used as-is and flagged `truncated` in the log and UI; the fix is a higher `max_tokens`.
- The harness validates tool arguments itself. Malformed JSON, unknown tools, and schema mismatches go back to the agent as tool errors. Whether a response has tool calls is decided by a non-empty `tool_calls` array, not by `finish_reason`.
- The API key must be visible ASCII; the CLI checks it at start, since a stray line break would otherwise surface in fetch's error message, key included.
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

The cache key is a sha256 of the canonical JSON (sorted keys) of the full request body, the run seed, the tick, and the agent's name. The agent is in the key because two agents can send identical bodies in one tick (a prompt template without `{name}`), and each needs its own sample. So:

- Re-running a run's resolved config (`runs/<run-id>/run.yaml`, which includes the pinned endpoint): every request matches, and the re-run reproduces the event log exactly with zero network calls. The CLI then compares the two logs and prints the first difference, if any (exit code 3). The comparison (`src/shared/compare.ts`) ignores only what legitimately differs: timestamps, latency, cache hits, the run id, the run-folder paths in the config, the mode (a live run re-runs offline), and the catalog lookup, which re-runs skip. `--offline` turns any cache miss into an error; that's how determinism gets verified.
- Re-running a run that was cut short (`interrupted`, `api_error`) resumes it: the re-run is compared with the original up to the original's `run_ended`, and goes on from there.
- New seed: different shuffles and names and no cache hits, so a fresh sample.
- Forks (later): re-run up to tick N, change something, continue. Everything before the change comes from the cache.

The seed drives the shuffle at each tick (a PRNG seeded from seed and tick), name assignment, and the cache key. Sampling randomness happens at the provider; the cache is what makes it reproducible.

Cache layout: `cache/<hh>/<hash>.json`, one file per response, holding the request, the raw response (provider, usage, and cost included), its headers, latency, and attempt count. A cached context-length failure holds the error body as its response and an `error` field with the message the call failed with. Gitignored.

## Event log

`runs/<run-id>/events.jsonl`, one JSON object per line, each with `seq` (monotonic), `tick`, `at` (wall clock), `type`, and a payload.

| Type | Payload |
|---|---|
| `run_started` | resolved config, rendered prompts, task snapshot manifest (doc ids and hashes), seed, mode (`live`, `offline` for `--offline`, `scripted` for `--scripted`), catalog entry and pinned endpoint record for each model |
| `tick_started` | active agents, shuffle order, sleeping and finished agents |
| `model_call` | agent, cache key, cache hit, assistant message verbatim (content, tool calls, reasoning, reasoning details), finish reason, truncated, usage (prompt, completion, reasoning, cached tokens), cost, provider metadata, system fingerprint, generation id, latency, attempts |
| `tool_call` | agent, position in the step, tool, arguments, result exactly as the agent saw it, error |
| `post_created` | post id, author, text, reply_to |
| `board_delivered` | agent, post ids: exact read receipts |
| `document_opened` | agent, doc id, reads left |
| `deliverable_read` | agent, version read |
| `deliverable_written` | version, author, text, replaced version and its author, whether the writer had seen the version it replaced |
| `agent_slept`, `agent_woke`, `agent_done`, `agent_stopped` | agent, reason or note (`agent_slept.reason` is `wait` or `no_tool_calls`); `agent_stopped` also the cache key of the error response |
| `run_ended` | reason, totals, and the unapplied calls of an aborted tick (agent, cache key, cache hit, usage) |

Within a tick, each agent's step is logged in the shuffle order; `src/shared/events.ts` documents the exact order. Every message added to an agent's context can be rebuilt from these events, so the UI reconstructs the exact request for any step without the cache. When a run ends, the final deliverable is also written to `runs/<run-id>/deliverable.md`.

## Observer UI

Every view is a function of the event log up to a tick. Live and replay are the same code path: live means the log is still growing, the server streams new lines over SSE, and the view follows the newest tick until you scrub away ("jump to live" returns).

- **Runs list:** task, model, seed, status, ticks, cost, end reason, start time. Scripted runs and offline re-runs are marked, here and in the run header, and a scripted run's cost is muted: it is simulated, never spend.
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
- Posting blind: how often an agent posted while it had unread posts: posts by others from earlier ticks not delivered to it before its step. A `read_board` in the same response doesn't count, since the model wrote the post before any result came back.
- Deliverable: versions, distinct authors, overwrites of unseen versions, final length.
- Activity: steps per agent, ticks asleep, tick of done, end reason.
- Cost: tokens (prompt, completion, reasoning, cached) and USD per agent and per tick.

## Configuration

```yaml
task: tasks/example
# task_name: example              # optional; defaults to the task folder's name

agents:
  count: 5
  model:
    id: deepseek/deepseek-v4-flash
    params:                       # merged verbatim into the OpenRouter request body
      reasoning: { effort: high }
      temperature: 0.7
      max_tokens: 16000
      provider: { order: [streamlake/fp8] }   # pin a measured endpoint; without it, pinned automatically

environment:
  doc_read_budget: 4
  post_max_chars: 800
  deliverable_max_chars: 20000
  status_line: true
  wait_tool: true
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
  max_retries: 6
```

Per-agent model overrides (for mixed swarms) come later; the config and event shapes already carry a model per agent.

CLI:

```bash
npm run swarm -- configs/baseline.yaml --seed 3              # new run
npm run swarm -- configs/baseline.yaml --dry-run             # validate, pin endpoint, render prompts; no model calls
npm run swarm -- configs/baseline.yaml --scripted            # scripted fake model; no network, no API key
npm run swarm -- runs/<run-id>/run.yaml --offline            # exact re-run from cache; any miss is an error; logs compared
npm run swarm -- runs/<run-id>/run.yaml --scripted           # the same for a scripted run, which has no cache entries
npm run ui                                                     # server and UI
```

Exit codes: 0 finished; 1 an error, including a run that ended with `api_error`; 2 bad arguments; 3 a re-run's log differs from the original's; 130 interrupted.

The runs list marks a run `stale` (probably killed) when its log hasn't grown for longer than any healthy tick could take: every attempt of a call timing out with full backoff between attempts, times the waves of calls `max_concurrency` allows, and never less than 10 minutes.

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
