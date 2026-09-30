import { DEFAULT_MAX_TOKENS } from "../../shared/config.ts";
import { OPENROUTER_BASE_URL } from "./client.ts";

/** One entry of GET /api/v1/models, kept verbatim. Prices are USD per token, as strings; a few entries (discount) are numbers. */
export interface CatalogModel {
  id: string;
  canonical_slug?: string;
  context_length: number;
  pricing: Record<string, string | number>;
  supported_parameters: string[];
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    /** null: every effort is accepted; omitted: the model doesn't expose effort selection. */
    supported_efforts?: string[] | null;
    default_effort?: string;
  } | null;
  [key: string]: unknown;
}

/** One entry of GET /api/v1/models/{id}/endpoints, kept verbatim. */
export interface CatalogEndpoint {
  /** Routing slug for provider.order, e.g. "baidu/fp8" or "venice". */
  tag: string;
  provider_name: string;
  quantization: string | null;
  context_length: number;
  max_completion_tokens: number | null;
  /** 0 is healthy. */
  status: number;
  uptime_last_5m?: number | null;
  /** As in CatalogModel. */
  pricing: Record<string, string | number>;
  supported_parameters: string[];
  supports_tool_choice?: Record<string, boolean>;
  supports_implicit_caching?: boolean;
  [key: string]: unknown;
}

export interface RankedEndpoint {
  endpoint: CatalogEndpoint;
  /** USD per million tokens for 10 input tokens per output token; Infinity when a price is missing. */
  blended_price_per_m: number;
  /** Why the endpoint can't serve the params; empty when it can. */
  problems: string[];
}

export interface EndpointResolution {
  /** The params to send: the originals plus max_tokens and the provider pin (explicit values win). */
  params: Record<string, unknown>;
  model: CatalogModel;
  endpoint: CatalogEndpoint;
  /** Every endpoint: compatible ones first, each group cheapest first. */
  ranked: RankedEndpoint[];
  warnings: string[];
}

/** Request keys that steer routing or accounting rather than the model, so endpoints don't list them. */
export const ROUTING_PARAMS = [
  "provider",
  "transforms",
  "plugins",
  "session_id",
  "user",
  "usage",
  "models",
  "route",
  "metadata",
] as const;

const LOW_PRECISION_QUANTIZATIONS = new Set(["fp4", "int4"]);

/** provider.quantizations values that also cover finer-named variants. */
const QUANTIZATION_FAMILIES: Record<string, string[]> = { fp4: ["mxfp4", "nvfp4"], fp8: ["mxfp8"] };

/** provider fields that only reorder endpoints, which the pin makes moot. */
const ORDERING_PROVIDER_FIELDS = ["sort", "preferred_min_throughput", "preferred_max_latency"] as const;

/** What an endpoint must satisfy besides health: derived once from the params. */
interface Requirements {
  /** "tools", "max_tokens", and every params key except routing keys. */
  parameters: string[];
  maxTokens: number;
  /** The tool_choice mode (none, auto, required, function), when params set one. */
  toolChoice: string | null;
  /** params.provider's endpoint filters. */
  only: string[] | null;
  ignore: string[] | null;
  quantizations: string[] | null;
  /** USD per million tokens. */
  maxPrice: { prompt: number | null; completion: number | null };
}

/** The catalog entry for `id` (matched against id, then canonical_slug). */
export async function fetchModel(id: string, fetchImpl: typeof fetch = fetch): Promise<CatalogModel> {
  const json = await getJson(`${OPENROUTER_BASE_URL}/models`, fetchImpl);
  const data = isRecord(json) ? json.data : undefined;
  if (!Array.isArray(data)) throw new Error("GET /api/v1/models returned no data array.");
  const models = data.filter(
    (entry): entry is CatalogModel => isRecord(entry) && typeof entry.id === "string",
  );
  const found = models.find((model) => model.id === id) ?? models.find((model) => model.canonical_slug === id);
  if (found) return found;
  const similar = similarIds(id, models.map((model) => model.id));
  throw new Error(
    `Model "${id}" isn't in the OpenRouter catalog.` +
      (similar.length > 0 ? ` Similar ids: ${similar.join(", ")}.` : ""),
  );
}

/** The endpoints (provider deployments) serving `id`. */
export async function fetchEndpoints(id: string, fetchImpl: typeof fetch = fetch): Promise<CatalogEndpoint[]> {
  const path = id.split("/").map(encodeURIComponent).join("/");
  const json = await getJson(`${OPENROUTER_BASE_URL}/models/${path}/endpoints`, fetchImpl);
  const data = isRecord(json) ? json.data : undefined;
  const endpoints = isRecord(data) ? data.endpoints : undefined;
  if (!Array.isArray(endpoints)) throw new Error(`The endpoints listing for "${id}" has no data.endpoints array.`);
  return endpoints as CatalogEndpoint[];
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`GET ${url} returned invalid JSON.`);
  }
}

/** Up to `limit` catalog ids that look like `query`, closest first. */
function similarIds(query: string, ids: string[], limit = 5): string[] {
  const q = query.toLowerCase();
  const qName = afterSlash(q);
  const threshold = Math.max(2, Math.floor(qName.length * 0.4));
  return ids
    .map((id) => {
      const lower = id.toLowerCase();
      const name = afterSlash(lower);
      const distance =
        qName.length > 0 && name.includes(qName)
          ? 0
          : Math.min(levenshtein(q, lower), levenshtein(qName, name));
      return { id, distance, lengthGap: Math.abs(name.length - qName.length) };
    })
    .filter((candidate) => candidate.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.lengthGap - b.lengthGap || compareStrings(a.id, b.id))
    .slice(0, limit)
    .map((candidate) => candidate.id);
}

function afterSlash(id: string): string {
  return id.slice(id.indexOf("/") + 1);
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Validates params against the model and its endpoints and picks the endpoint to pin. Pure.
 * With params.provider.order, its first entry is the pin (an exact tag, or a provider slug matching
 * every tag "<slug>/..."); otherwise the cheapest compatible endpoint wins. Throws a readable,
 * multi-line Error when nothing fits.
 */
export function resolveEndpoint(
  model: CatalogModel,
  endpoints: CatalogEndpoint[],
  params: Record<string, unknown>,
): EndpointResolution {
  const maxTokens = params.max_tokens ?? DEFAULT_MAX_TOKENS;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`max_tokens must be a positive integer (got ${JSON.stringify(maxTokens)}).`);
  }
  checkReasoning(model, params);
  const provider = providerParams(params);
  const order = explicitOrder(provider);

  if (endpoints.length === 0) throw new Error(`OpenRouter lists no endpoints for ${model.id}.`);

  const requirements = endpointRequirements(params, provider, maxTokens);
  const required = requirements.parameters;
  const ranked = rankEndpoints(endpoints.map((endpoint) => assess(endpoint, requirements)));
  const warnings: string[] = [];

  let chosen: RankedEndpoint;
  if (order !== null) {
    const pin = order[0];
    const matches = ranked.filter((entry) => matchesPin(entry.endpoint.tag, pin));
    if (matches.length === 0) {
      throw new Error(
        [
          `params.provider.order[0] "${pin}" matches no endpoint of ${model.id}.`,
          `Available tags: ${ranked.map((entry) => entry.endpoint.tag).join(", ")}`,
        ].join("\n"),
      );
    }
    // An explicit pin tolerates a health problem (with a warning), nothing else.
    const usable = matches.filter((entry) =>
      entry.problems.every((problem) => problem === healthProblem(entry.endpoint)),
    );
    const first = usable[0];
    if (first === undefined) {
      throw new Error(
        [
          `params.provider.order[0] "${pin}" can't serve these params on ${model.id}:`,
          ...matches.map((entry) => `  ${entry.endpoint.tag}: ${entry.problems.join("; ")}`),
          `Required parameters: ${required.join(", ")}; max_tokens ${maxTokens}.`,
        ].join("\n"),
      );
    }
    chosen = first;
    const health = healthProblem(chosen.endpoint);
    if (health !== null) {
      warnings.push(`Pinned endpoint ${chosen.endpoint.tag} reports ${health}; calls may fail or be slow.`);
    }
    if (matches.length > 1) {
      warnings.push(
        `params.provider.order[0] "${pin}" matches ${matches.length} endpoints ` +
          `(${matches.map((entry) => entry.endpoint.tag).join(", ")}); OpenRouter may route to any of them. ` +
          `Validated ${chosen.endpoint.tag}; pin an exact tag to use one endpoint.`,
      );
    }
    if (order.length > 1) {
      warnings.push(
        `params.provider.order lists ${order.length} entries; only the first was validated, and OpenRouter ` +
          `may fall back to the others, mixing endpoints within a run.`,
      );
    }
  } else {
    const cheapest = ranked.find((entry) => entry.problems.length === 0);
    if (cheapest === undefined) {
      throw new Error(
        [
          `No endpoint of ${model.id} can serve these params.`,
          `Required parameters: ${required.join(", ")}; max_tokens ${maxTokens}.`,
          formatEndpointTable(ranked, null),
          "Drop or change the unsupported params, lower max_tokens, or pin an endpoint with params.provider.order.",
        ].join("\n"),
      );
    }
    chosen = cheapest;
    warnings.push(
      `${chosen.endpoint.tag} was pinned automatically, by list price. List prices don't predict speed or real ` +
        "cost (endpoints differ in caching and in how long the model's output runs), and the cheapest endpoint " +
        "changes from day to day. To keep runs comparable, pin an endpoint you've measured: " +
        "params.provider.order: [<tag>].",
    );
    const ordering = ORDERING_PROVIDER_FIELDS.filter((field) => provider?.[field] !== undefined);
    if (ordering.length > 0) {
      warnings.push(
        `params.provider ${ordering.join(", ")} can't take effect: every request goes to the pinned ` +
          `${chosen.endpoint.tag}. Use only, ignore, quantizations, or max_price to steer the pin.`,
      );
    }
  }

  const quantization = chosen.endpoint.quantization;
  if (quantization !== null && LOW_PRECISION_QUANTIZATIONS.has(quantization.toLowerCase())) {
    warnings.push(`Endpoint ${chosen.endpoint.tag} serves ${quantization} weights, which can degrade output quality.`);
  }
  if (provider?.allow_fallbacks === true) {
    warnings.push("params.provider.allow_fallbacks is true: failed calls may be served by other endpoints.");
  }
  if (provider?.require_parameters === false) {
    warnings.push(
      "params.provider.require_parameters is false: an endpoint may silently ignore params it doesn't support.",
    );
  }

  return {
    params: {
      ...params,
      max_tokens: maxTokens,
      provider: {
        order: [chosen.endpoint.tag],
        allow_fallbacks: false,
        require_parameters: true,
        ...provider,
      },
    },
    model,
    endpoint: chosen.endpoint,
    ranked,
    warnings,
  };
}

/** "tools", "max_tokens", and every params key except routing keys. */
function requiredParameters(params: Record<string, unknown>): string[] {
  const routing = new Set<string>(ROUTING_PARAMS);
  const keys = Object.keys(params).filter((key) => !routing.has(key));
  return [...new Set(["tools", "max_tokens", ...keys])];
}

function endpointRequirements(
  params: Record<string, unknown>,
  provider: Record<string, unknown> | undefined,
  maxTokens: number,
): Requirements {
  return {
    parameters: requiredParameters(params),
    maxTokens,
    toolChoice: toolChoiceMode(params.tool_choice),
    only: stringList(provider, "only"),
    ignore: stringList(provider, "ignore"),
    quantizations: stringList(provider, "quantizations"),
    maxPrice: maxPrice(provider),
  };
}

/** "none", "auto", "required", or "function" for { type: "function", ... }; null when unset. */
function toolChoiceMode(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  if (isRecord(value) && value.type === "function") return "function";
  throw new Error('params.tool_choice must be "none", "auto", "required", or { type: "function", function: { name } }.');
}

function stringList(provider: Record<string, unknown> | undefined, field: string): string[] | null {
  const value = provider?.[field];
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`params.provider.${field} must be a list of strings.`);
  }
  return value;
}

function maxPrice(provider: Record<string, unknown> | undefined): Requirements["maxPrice"] {
  const value = provider?.max_price;
  if (value === undefined) return { prompt: null, completion: null };
  if (!isRecord(value)) throw new Error("params.provider.max_price must be an object (USD per million tokens).");
  const limit = (field: "prompt" | "completion"): number | null => {
    const raw = value[field];
    if (raw === undefined) return null;
    const usd = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(usd)) throw new Error(`params.provider.max_price.${field} must be a number.`);
    return usd;
  };
  return { prompt: limit("prompt"), completion: limit("completion") };
}

/**
 * Checks reasoning params against the model's catalog `reasoning` object. `effort` is only defined for
 * models that list supported_efforts (null means any is accepted; omitted means the model has no effort
 * selection); a model with mandatory reasoning can't have it turned off; effort and max_tokens exclude
 * each other. A model without a reasoning object is left to the endpoint check of the `reasoning` param.
 */
function checkReasoning(model: CatalogModel, params: Record<string, unknown>): void {
  const reasoning = isRecord(params.reasoning) ? params.reasoning : null;
  const requested: [string, unknown][] = [];
  if (reasoning?.effort !== undefined) requested.push(["reasoning.effort", reasoning.effort]);
  if (params.reasoning_effort !== undefined) requested.push(["reasoning_effort", params.reasoning_effort]);
  if (reasoning?.effort !== undefined && reasoning.max_tokens !== undefined) {
    throw new Error("params.reasoning sets both effort and max_tokens; OpenRouter takes one or the other.");
  }

  const info = model.reasoning;
  if (!isRecord(info)) return;
  if (info.mandatory === true) {
    if (reasoning?.enabled === false) {
      throw new Error(`${model.id} always reasons, so reasoning.enabled false isn't accepted.`);
    }
    const off = requested.find(([, effort]) => effort === "none");
    if (off) throw new Error(`${model.id} always reasons, so ${off[0]} "none" isn't accepted.`);
  }
  if (!Object.hasOwn(info, "supported_efforts")) {
    const first = requested[0];
    if (first) {
      throw new Error(
        `${model.id} doesn't expose effort selection, so ${first[0]} ${JSON.stringify(first[1])} has no defined ` +
          "effect. Drop it, or use reasoning.enabled.",
      );
    }
    return;
  }
  const allowed = info.supported_efforts;
  if (!Array.isArray(allowed)) return;
  for (const [name, effort] of requested) {
    if (typeof effort !== "string" || !allowed.includes(effort)) {
      throw new Error(
        `${name} ${JSON.stringify(effort)} isn't supported by ${model.id}. ` +
          `Allowed: ${allowed.length > 0 ? allowed.join(", ") : "(none)"}` +
          (model.reasoning?.default_effort ? ` (default ${model.reasoning.default_effort}).` : "."),
      );
    }
  }
}

function providerParams(params: Record<string, unknown>): Record<string, unknown> | undefined {
  if (params.provider === undefined) return undefined;
  if (!isRecord(params.provider)) throw new Error("params.provider must be an object.");
  return params.provider;
}

/** provider.order, or null when it isn't set. An order that is set must start with a tag or slug. */
function explicitOrder(provider: Record<string, unknown> | undefined): [string, ...unknown[]] | null {
  if (provider?.order === undefined) return null;
  const order: unknown = provider.order;
  if (!Array.isArray(order) || typeof order[0] !== "string" || order[0] === "") {
    throw new Error(
      "params.provider.order must be a non-empty list of endpoint tags (e.g. baidu/fp8) or provider slugs.",
    );
  }
  return order as [string, ...unknown[]];
}

function matchesPin(tag: string, pin: string): boolean {
  const lowerTag = tag.toLowerCase();
  const lowerPin = pin.toLowerCase();
  if (lowerPin.includes("/")) return lowerTag === lowerPin;
  return lowerTag.split("/")[0] === lowerPin;
}

function assess(endpoint: CatalogEndpoint, requirements: Requirements): RankedEndpoint {
  const { maxTokens, toolChoice, only, ignore, quantizations, maxPrice } = requirements;
  const problems: string[] = [];
  const health = healthProblem(endpoint);
  if (health !== null) problems.push(health);
  const supported = new Set(Array.isArray(endpoint.supported_parameters) ? endpoint.supported_parameters : []);
  const missing = requirements.parameters.filter((parameter) => !supported.has(parameter));
  if (missing.length > 0) problems.push(`doesn't support: ${missing.join(", ")}`);
  // Every endpoint lists tool_choice; which modes it honors is in supports_tool_choice, when the record has it.
  if (toolChoice !== null && isRecord(endpoint.supports_tool_choice) && endpoint.supports_tool_choice[toolChoice] !== true) {
    problems.push(`doesn't support tool_choice ${toolChoice}`);
  }
  if (typeof endpoint.max_completion_tokens === "number" && maxTokens > endpoint.max_completion_tokens) {
    problems.push(`max_tokens ${maxTokens} > max output ${endpoint.max_completion_tokens}`);
  }
  if (typeof endpoint.context_length === "number" && maxTokens >= endpoint.context_length) {
    problems.push(`max_tokens ${maxTokens} leaves no room in context ${endpoint.context_length}`);
  }
  if (only !== null && !only.some((slug) => matchesPin(endpoint.tag, slug))) problems.push("not in provider.only");
  if (ignore !== null && ignore.some((slug) => matchesPin(endpoint.tag, slug))) problems.push("in provider.ignore");
  if (quantizations !== null && !matchesQuantization(endpoint.quantization, quantizations)) {
    problems.push(`quantization ${endpoint.quantization ?? "unknown"} not in provider.quantizations`);
  }
  const input = pricePerMillion(endpoint.pricing?.prompt);
  const output = pricePerMillion(endpoint.pricing?.completion);
  if (maxPrice.prompt !== null && input > maxPrice.prompt) {
    problems.push(`$${formatPrice(input)}/M in > provider.max_price.prompt ${maxPrice.prompt}`);
  }
  if (maxPrice.completion !== null && output > maxPrice.completion) {
    problems.push(`$${formatPrice(output)}/M out > provider.max_price.completion ${maxPrice.completion}`);
  }
  return { endpoint, blended_price_per_m: blendedPrice(endpoint), problems };
}

/** An endpoint's quantization (null counts as "unknown") against provider.quantizations. */
function matchesQuantization(quantization: string | null, allowed: string[]): boolean {
  const value = (quantization ?? "unknown").toLowerCase();
  return allowed.some((entry) => {
    const lower = entry.toLowerCase();
    return lower === value || (QUANTIZATION_FAMILIES[lower] ?? []).includes(value);
  });
}

/** Endpoints below this recent uptime (percent) are skipped by automatic pinning. */
export const MIN_UPTIME_PERCENT = 95;

function healthProblem(endpoint: CatalogEndpoint): string | null {
  if (endpoint.status !== 0) return `unhealthy (status ${endpoint.status})`;
  const uptime = endpoint.uptime_last_5m;
  if (typeof uptime === "number" && uptime < MIN_UPTIME_PERCENT) return `low recent uptime (${Math.floor(uptime)}%)`;
  return null;
}

function rankEndpoints(entries: RankedEndpoint[]): RankedEndpoint[] {
  const byPrice = (a: RankedEndpoint, b: RankedEndpoint) =>
    a.blended_price_per_m - b.blended_price_per_m ||
    (b.endpoint.uptime_last_5m ?? -1) - (a.endpoint.uptime_last_5m ?? -1) ||
    compareStrings(a.endpoint.tag, b.endpoint.tag);
  const compatible = entries.filter((entry) => entry.problems.length === 0).sort(byPrice);
  const incompatible = entries.filter((entry) => entry.problems.length > 0).sort(byPrice);
  return [...compatible, ...incompatible];
}

/** (10 × input + output) / 11, in USD per million tokens. */
function blendedPrice(endpoint: CatalogEndpoint): number {
  const input = pricePerMillion(endpoint.pricing?.prompt);
  const output = pricePerMillion(endpoint.pricing?.completion);
  return Number.isFinite(input) && Number.isFinite(output) ? (10 * input + output) / 11 : Infinity;
}

/** A per-token price string as USD per million tokens; NaN when missing or negative (variable pricing). */
function pricePerMillion(value: unknown): number {
  const perToken = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(perToken) && perToken >= 0 ? perToken * 1e6 : Number.NaN;
}

/** A fixed-width table of ranked endpoints; the chosen one is marked with "*". */
export function formatEndpointTable(ranked: RankedEndpoint[], chosenTag: string | null): string {
  const header = ["", "tag", "quant", "context", "max out", "$/M in", "$/M out", "blended", "problems"];
  const rightAligned = new Set([3, 4, 5, 6, 7]);
  const rows = ranked.map(({ endpoint, blended_price_per_m, problems }) => [
    endpoint.tag === chosenTag ? "*" : "",
    endpoint.tag,
    endpoint.quantization ?? "-",
    formatTokens(endpoint.context_length),
    formatTokens(endpoint.max_completion_tokens),
    formatPrice(pricePerMillion(endpoint.pricing?.prompt)),
    formatPrice(pricePerMillion(endpoint.pricing?.completion)),
    formatPrice(blended_price_per_m),
    problems.length > 0 ? problems.join("; ") : "ok",
  ]);
  const table = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  return table
    .map((row) =>
      row
        .map((cell, column) => {
          if (column === row.length - 1) return cell;
          const width = widths[column]!;
          return rightAligned.has(column) ? cell.padStart(width) : cell.padEnd(width);
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatPrice(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "?";
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
