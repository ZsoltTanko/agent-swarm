import { z } from "zod";

/** Agent names: unordered, so no name implies rank. Assigned per run by seed. */
export const NAME_POOL = [
  "Heron",
  "Otter",
  "Wren",
  "Lynx",
  "Moth",
  "Finch",
  "Marten",
  "Ibis",
  "Newt",
  "Tern",
  "Vole",
  "Shrike",
  "Plover",
  "Stoat",
  "Egret",
  "Gecko",
  "Kestrel",
  "Marmot",
  "Petrel",
  "Quail",
  "Dunlin",
  "Siskin",
  "Avocet",
  "Bittern",
  "Linnet",
  "Pipit",
  "Skink",
  "Tapir",
  "Oriole",
  "Grebe",
  "Sable",
  "Coati",
] as const;

/** Request-body keys the harness sets itself; a model's params may not set them. */
export const HARNESS_OWNED_PARAMS = ["model", "messages", "tools", "stream"] as const;

export const DEFAULT_MAX_TOKENS = 16000;

export const ModelConfigSchema = z.strictObject({
  id: z.string().min(1),
  /** Merged verbatim into the OpenRouter request body. */
  params: z.record(z.string(), z.unknown()).default({}),
});

export const EnvironmentConfigSchema = z.strictObject({
  doc_read_budget: z.number().int().min(1).default(4),
  post_max_chars: z.number().int().positive().default(800),
  deliverable_max_chars: z.number().int().positive().default(20000),
  status_line: z.boolean().default(true),
  /** Offer the wait tool. Without it, an agent can only wait by ending a step without tool calls. */
  wait_tool: z.boolean().default(true),
  roster_known: z.boolean().default(false),
  kickoff: z.string().min(1).default("Check the board and introduce yourself before you start."),
  /** Path relative to the project root; in a run's run.yaml, relative to the run folder. */
  prompt_template: z.string().min(1).default("prompts/swarm.md"),
});

export const RunSettingsSchema = z.strictObject({
  seed: z.number().int().nonnegative().default(1),
  tick_cap: z.number().int().positive().default(40),
  max_tool_calls_per_step: z.number().int().positive().default(10),
  max_concurrency: z.number().int().positive().default(8),
  max_cost_usd: z.number().positive().default(2),
  call_timeout_s: z.number().positive().default(600),
  max_retries: z.number().int().nonnegative().default(6),
});

export const RunConfigSchema = z.strictObject({
  /** Task directory (task.md + docs/), relative to the project root; in a run's run.yaml, relative to the run folder. */
  task: z.string().min(1),
  /**
   * The task's name in run ids and the UI; defaults to the basename of `task`. A resolved run.yaml
   * records it, because its `task` points at the run's snapshot folder.
   */
  task_name: z.string().min(1).optional(),
  agents: z
    .strictObject({
      count: z.number().int().min(1).max(NAME_POOL.length),
      /**
       * The agents' names, in index order. Drawn from NAME_POOL by seed when absent; a resolved run.yaml
       * records them, so a run's names never depend on the pool.
       */
      names: z.array(z.string().regex(/^[A-Z][A-Za-z-]*$/, "must be one capitalized word")).optional(),
      model: ModelConfigSchema,
    })
    .refine((agents) => agents.names === undefined || agents.names.length === agents.count, {
      message: "names must list exactly count names",
      path: ["names"],
    })
    .refine((agents) => agents.names === undefined || new Set(agents.names).size === agents.names.length, {
      message: "names must be distinct",
      path: ["names"],
    }),
  environment: EnvironmentConfigSchema.prefault({}),
  run: RunSettingsSchema.prefault({}),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
export type RunSettings = z.infer<typeof RunSettingsSchema>;
/**
 * A validated config. After endpoint resolution the same shape is the "resolved config"
 * written to runs/<id>/run.yaml: params carry the provider pin and max_tokens, and paths
 * point at the run's own snapshots (relative to the run folder), so the file can be fed back
 * to the CLI as-is, from anywhere the folder is moved or copied to.
 */
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type RunConfigInput = z.input<typeof RunConfigSchema>;
