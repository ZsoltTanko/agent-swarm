/**
 * Fixtures under tests/fixtures/openrouter/ were captured on 2026-09-28 with unauthenticated GETs:
 *   models-deepseek.json               GET /api/v1/models, filtered to deepseek/* entries (verbatim)
 *   deepseek-v4-flash.endpoints.json   GET /api/v1/models/deepseek/deepseek-v4-flash/endpoints (verbatim)
 * In that snapshot baidu/fp8 is the cheapest healthy endpoint; open-inference/fp8 and atlas-cloud/fp4 are unhealthy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOKENS } from "../src/shared/config.ts";
import {
  fetchEndpoints,
  fetchModel,
  formatEndpointTable,
  resolveEndpoint,
  type CatalogEndpoint,
  type CatalogModel,
} from "../src/harness/openrouter/catalog.ts";

const FIXTURES = new URL("./fixtures/openrouter/", import.meta.url);
const modelsResponse = JSON.parse(readFileSync(new URL("models-deepseek.json", FIXTURES), "utf8")) as {
  data: CatalogModel[];
};
const endpointsResponse = JSON.parse(
  readFileSync(new URL("deepseek-v4-flash.endpoints.json", FIXTURES), "utf8"),
) as { data: { endpoints: CatalogEndpoint[] } };

const MODEL = modelsResponse.data.find((model) => model.id === "deepseek/deepseek-v4-flash")!;
const ENDPOINTS = endpointsResponse.data.endpoints;
const BASELINE = { reasoning: { effort: "high" }, temperature: 0.7, max_tokens: 16000 };

function endpoint(tag: string): CatalogEndpoint {
  return ENDPOINTS.find((candidate) => candidate.tag === tag)!;
}

function fetchReturning(status: number, body: unknown) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, urls };
}

describe("fixtures", () => {
  it("hold the model and its endpoints", () => {
    expect(MODEL).toBeDefined();
    expect(MODEL.reasoning?.supported_efforts).toEqual(["xhigh", "high"]);
    expect(ENDPOINTS.length).toBe(15);
  });

  it("carry numeric pricing entries next to the price strings", () => {
    const discounted = ENDPOINTS.find((candidate) => typeof candidate.pricing.discount === "number" && candidate.pricing.discount > 0)!;
    expect(discounted.pricing.discount).toBe(0.577);
    expect(typeof discounted.pricing.prompt).toBe("string");
    const ranked = resolveEndpoint(MODEL, ENDPOINTS, BASELINE).ranked.find((entry) => entry.endpoint === discounted)!;
    expect(Number.isFinite(ranked.blended_price_per_m)).toBe(true);
  });
});

describe("fetchModel", () => {
  it("finds a model by id", async () => {
    const { impl, urls } = fetchReturning(200, modelsResponse);
    const model = await fetchModel("deepseek/deepseek-v4-flash", impl);
    expect(model).toEqual(MODEL);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/models"]);
  });

  it("finds a model by canonical slug", async () => {
    const model = await fetchModel("deepseek/deepseek-v4-flash-20260423", fetchReturning(200, modelsResponse).impl);
    expect(model.id).toBe("deepseek/deepseek-v4-flash");
  });

  it("suggests similar ids for an unknown one", async () => {
    const attempt = fetchModel("deepseek/deepseek-v4-flsh", fetchReturning(200, modelsResponse).impl);
    await expect(attempt).rejects.toThrow(/isn't in the OpenRouter catalog\. Similar ids: deepseek\/deepseek-v4-flash\b/);
  });

  it("suggests at most five ids, including for an id without its author", async () => {
    const error = await fetchModel("deepseek-v4", fetchReturning(200, modelsResponse).impl).then(
      () => new Error("expected a rejection"),
      (reason: unknown) => reason as Error,
    );
    const suggestions = /Similar ids: (.*)\.$/.exec(error.message)![1]!.split(", ");
    expect(suggestions.length).toBeLessThanOrEqual(5);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const id of suggestions) expect(id).toContain("deepseek-v4");
  });

  it("reports HTTP failures", async () => {
    await expect(fetchModel("x/y", fetchReturning(500, { error: "boom" }).impl)).rejects.toThrow(/HTTP 500/);
  });
});

describe("fetchEndpoints", () => {
  it("returns data.endpoints from the model's endpoints listing", async () => {
    const { impl, urls } = fetchReturning(200, endpointsResponse);
    const endpoints = await fetchEndpoints("deepseek/deepseek-v4-flash", impl);
    expect(endpoints).toEqual(ENDPOINTS);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints"]);
  });

  it("reports an unknown model", async () => {
    const attempt = fetchEndpoints("deepseek/nope", fetchReturning(404, { error: { message: "Not Found", code: 404 } }).impl);
    await expect(attempt).rejects.toThrow(/HTTP 404/);
  });
});

describe("resolveEndpoint", () => {
  it("auto-pins the cheapest healthy compatible endpoint", () => {
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, BASELINE);
    expect(resolution.endpoint.tag).toBe("baidu/fp8");
    expect(resolution.params).toEqual({
      reasoning: { effort: "high" },
      temperature: 0.7,
      max_tokens: 16000,
      provider: { order: ["baidu/fp8"], allow_fallbacks: false, require_parameters: true },
    });
    expect(resolution.model).toBe(MODEL);
    expect(resolution.warnings).toEqual([expect.stringMatching(/was pinned automatically, by list price/)]);
  });

  it("ranks every endpoint, compatible ones first, each group cheapest first", () => {
    const { ranked } = resolveEndpoint(MODEL, ENDPOINTS, BASELINE);
    expect(ranked).toHaveLength(ENDPOINTS.length);
    expect(ranked[0]!.endpoint.tag).toBe("baidu/fp8");
    const firstIncompatible = ranked.findIndex((entry) => entry.problems.length > 0);
    expect(ranked.slice(firstIncompatible).every((entry) => entry.problems.length > 0)).toBe(true);
    expect(ranked.slice(firstIncompatible).map((entry) => entry.endpoint.tag).sort()).toEqual([
      "atlas-cloud/fp4",
      "open-inference/fp8",
    ]);
    for (const group of [ranked.slice(0, firstIncompatible), ranked.slice(firstIncompatible)]) {
      const prices = group.map((entry) => entry.blended_price_per_m);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    }
    const baidu = ranked[0]!;
    expect(baidu.blended_price_per_m).toBeCloseTo((10 * 0.05922 + 0.11844) / 11, 10);
    expect(ranked.find((entry) => entry.endpoint.tag === "open-inference/fp8")!.problems).toEqual([
      "unhealthy (status -2)",
    ]);
  });

  it("never auto-pins an unhealthy endpoint, even a cheaper one", () => {
    const cheapButDown = { ...endpoint("baidu/fp8"), tag: "cheap/fp8", status: -3 } as CatalogEndpoint;
    cheapButDown.pricing = { prompt: "0.00000001", completion: "0.00000001" };
    const resolution = resolveEndpoint(MODEL, [...ENDPOINTS, cheapButDown], BASELINE);
    expect(resolution.endpoint.tag).toBe("baidu/fp8");
  });

  it("breaks price ties by uptime, then by tag", () => {
    const base = endpoint("baidu/fp8");
    const a = { ...base, tag: "b/fp8", uptime_last_5m: 99 };
    const b = { ...base, tag: "a/fp8", uptime_last_5m: 99 };
    const c = { ...base, tag: "c/fp8", uptime_last_5m: 100 };
    expect(resolveEndpoint(MODEL, [a, b, c], BASELINE).ranked.map((entry) => entry.endpoint.tag)).toEqual([
      "c/fp8",
      "a/fp8",
      "b/fp8",
    ]);
  });

  it("defaults max_tokens and requires it and tools of the endpoint", () => {
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, { temperature: 0.7 });
    expect(resolution.params.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    const noTools = { ...endpoint("baidu/fp8"), supported_parameters: ["temperature", "max_tokens"] };
    const entry = resolveEndpoint(MODEL, [noTools, endpoint("streamlake/fp8")], { temperature: 0.7 }).ranked.find(
      (candidate) => candidate.endpoint === noTools,
    )!;
    expect(entry.problems).toEqual(["doesn't support: tools"]);
  });

  it("skips endpoints that don't support a param", () => {
    // seed: baidu/fp8 and streamlake/fp8 lack it; deepinfra/fp8 is the cheapest healthy endpoint with it.
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, seed: 42 });
    expect(resolution.endpoint.tag).toBe("deepinfra/fp8");
    const baidu = resolution.ranked.find((entry) => entry.endpoint.tag === "baidu/fp8")!;
    expect(baidu.problems).toEqual(["doesn't support: seed"]);
    expect(resolution.params.seed).toBe(42);
  });

  it("doesn't require routing keys of the endpoint", () => {
    const params = { ...BASELINE, session_id: "run-1", user: "swarm", transforms: [], metadata: { run: "1" } };
    expect(resolveEndpoint(MODEL, ENDPOINTS, params).endpoint.tag).toBe("baidu/fp8");
  });

  it("rejects a reasoning effort the model doesn't list", () => {
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, reasoning: { effort: "medium" } })).toThrow(
      /reasoning\.effort "medium" isn't supported by deepseek\/deepseek-v4-flash\. Allowed: xhigh, high/,
    );
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, reasoning_effort: "low" })).toThrow(
      /reasoning_effort "low" isn't supported.*Allowed: xhigh, high/,
    );
    expect(resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, reasoning: { effort: "xhigh" } }).endpoint.tag).toBe(
      "baidu/fp8",
    );
  });

  it("accepts any effort when supported_efforts is null", () => {
    const model = { ...MODEL, reasoning: { mandatory: false, supported_efforts: null } };
    expect(resolveEndpoint(model, ENDPOINTS, { ...BASELINE, reasoning: { effort: "medium" } }).endpoint.tag).toBe(
      "baidu/fp8",
    );
  });

  it("rejects an effort when the model doesn't expose effort selection, but not reasoning.enabled", () => {
    const model = { ...MODEL, reasoning: { mandatory: false } };
    expect(() => resolveEndpoint(model, ENDPOINTS, { ...BASELINE, reasoning: { effort: "low" } })).toThrow(
      /deepseek-v4-flash doesn't expose effort selection, so reasoning\.effort "low" has no defined effect/,
    );
    expect(() => resolveEndpoint(model, ENDPOINTS, { ...BASELINE, reasoning: undefined, reasoning_effort: "low" })).toThrow(
      /reasoning_effort "low" has no defined effect/,
    );
    expect(resolveEndpoint(model, ENDPOINTS, { ...BASELINE, reasoning: { enabled: true } }).endpoint.tag).toBe("baidu/fp8");
  });

  it("leaves a model without a reasoning object to the endpoint check", () => {
    const model = { ...MODEL, reasoning: undefined };
    expect(resolveEndpoint(model, ENDPOINTS, { ...BASELINE, reasoning: { effort: "medium" } }).endpoint.tag).toBe(
      "baidu/fp8",
    );
  });

  it("rejects turning off a model's mandatory reasoning", () => {
    const model = { ...MODEL, reasoning: { mandatory: true, supported_efforts: ["high", "none"] } };
    expect(() => resolveEndpoint(model, ENDPOINTS, { ...BASELINE, reasoning: { enabled: false } })).toThrow(
      /always reasons, so reasoning\.enabled false isn't accepted/,
    );
    expect(() => resolveEndpoint(model, ENDPOINTS, { ...BASELINE, reasoning: { effort: "none" } })).toThrow(
      /always reasons, so reasoning\.effort "none" isn't accepted/,
    );
  });

  it("rejects reasoning effort and max_tokens together", () => {
    expect(() =>
      resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, reasoning: { effort: "high", max_tokens: 4000 } }),
    ).toThrow(/both effort and max_tokens/);
  });

  it("skips endpoints whose max output is below max_tokens", () => {
    // baidu/fp8 caps output at 131072; streamlake/fp8 allows 384000.
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, max_tokens: 200_000 });
    expect(resolution.endpoint.tag).toBe("streamlake/fp8");
    const baidu = resolution.ranked.find((entry) => entry.endpoint.tag === "baidu/fp8")!;
    expect(baidu.problems).toEqual(["max_tokens 200000 > max output 131072"]);
  });

  it("skips endpoints whose context can't hold max_tokens", () => {
    const small = { ...endpoint("baidu/fp8"), tag: "small/fp8", context_length: 8192 };
    small.pricing = { prompt: "0.00000001", completion: "0.00000001" };
    const resolution = resolveEndpoint(MODEL, [small, endpoint("streamlake/fp8")], BASELINE);
    expect(resolution.endpoint.tag).toBe("streamlake/fp8");
    expect(resolution.ranked[1]!.problems).toEqual(["max_tokens 16000 leaves no room in context 8192"]);
  });

  it("rejects a max_tokens that isn't a positive integer", () => {
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { max_tokens: "lots" })).toThrow(/max_tokens must be a positive integer/);
  });

  it("pins an explicit tag, even when it isn't the cheapest", () => {
    const params = { ...BASELINE, provider: { order: ["novita/fp8"] } };
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, params);
    expect(resolution.endpoint.tag).toBe("novita/fp8");
    expect(resolution.params.provider).toEqual({
      order: ["novita/fp8"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(resolution.warnings).toEqual([]);
  });

  it("pins by provider slug, matching tags without a variant too", () => {
    const bySlug = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: ["deepinfra"] } });
    expect(bySlug.endpoint.tag).toBe("deepinfra/fp8");
    expect(bySlug.params.provider).toEqual({ order: ["deepinfra"], allow_fallbacks: false, require_parameters: true });

    const bareTag = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: ["venice"] } });
    expect(bareTag.endpoint.tag).toBe("venice");
    const region = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: ["azure"] } });
    expect(region.endpoint.tag).toBe("azure/us");
  });

  it("warns when a slug matches several endpoints and validates the best of them", () => {
    const fp4 = { ...endpoint("deepinfra/fp8"), tag: "deepinfra/fp4", quantization: "fp4" };
    fp4.pricing = { prompt: "0.00000001", completion: "0.00000002" };
    const resolution = resolveEndpoint(MODEL, [...ENDPOINTS, fp4], { ...BASELINE, provider: { order: ["deepinfra"] } });
    expect(resolution.endpoint.tag).toBe("deepinfra/fp4");
    expect(resolution.warnings.join("\n")).toMatch(/matches 2 endpoints \(deepinfra\/fp4, deepinfra\/fp8\)/);
    expect(resolution.warnings.join("\n")).toMatch(/fp4 weights/);
  });

  it("accepts an unhealthy explicit pin with a warning", () => {
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: ["open-inference/fp8"] } });
    expect(resolution.endpoint.tag).toBe("open-inference/fp8");
    expect(resolution.warnings).toEqual([expect.stringMatching(/open-inference\/fp8 reports unhealthy \(status -2\); calls may fail or be slow/)]);
  });

  it("warns about an fp4 endpoint", () => {
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: ["relace/fp4"] } });
    expect(resolution.warnings).toEqual([expect.stringMatching(/relace\/fp4 serves fp4 weights/)]);
  });

  it("throws when an explicit pin matches nothing, listing the tags", () => {
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: ["nosuch/fp8"] } })).toThrow(
      /"nosuch\/fp8" matches no endpoint of deepseek\/deepseek-v4-flash\.\nAvailable tags: baidu\/fp8, .*venice/,
    );
  });

  it("throws when an explicit pin can't serve the params, listing its problems", () => {
    const params = { ...BASELINE, seed: 1, provider: { order: ["baidu/fp8"] } };
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, params)).toThrow(
      /"baidu\/fp8" can't serve these params on deepseek\/deepseek-v4-flash:\n {2}baidu\/fp8: doesn't support: seed/,
    );
  });

  it("rejects an empty or malformed provider.order", () => {
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: [] } })).toThrow(
      /provider\.order must be a non-empty list/,
    );
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: "baidu/fp8" } })).toThrow(
      /provider\.order must be a non-empty list/,
    );
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: "baidu/fp8" })).toThrow(
      /params\.provider must be an object/,
    );
  });

  it("lets explicit provider fields win and warns about risky ones", () => {
    const params = {
      ...BASELINE,
      provider: { allow_fallbacks: true, require_parameters: false, data_collection: "deny" },
    };
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, params);
    expect(resolution.params.provider).toEqual({
      order: ["baidu/fp8"],
      allow_fallbacks: true,
      require_parameters: false,
      data_collection: "deny",
    });
    expect(resolution.warnings).toEqual([
      expect.stringMatching(/was pinned automatically, by list price/),
      expect.stringMatching(/allow_fallbacks is true/),
      expect.stringMatching(/require_parameters is false/),
    ]);
  });

  it("skips endpoints with low recent uptime when pinning automatically, but honors an explicit pin with a warning", () => {
    const flaky = ENDPOINTS.map((endpoint) =>
      endpoint.tag === "baidu/fp8" ? { ...endpoint, uptime_last_5m: 90.6 } : endpoint,
    );
    const auto = resolveEndpoint(MODEL, flaky, BASELINE);
    expect(auto.endpoint.tag).not.toBe("baidu/fp8");
    expect(auto.ranked.find((entry) => entry.endpoint.tag === "baidu/fp8")!.problems).toContain("low recent uptime (90%)");

    const pinned = resolveEndpoint(MODEL, flaky, { ...BASELINE, provider: { order: ["baidu/fp8"] } });
    expect(pinned.endpoint.tag).toBe("baidu/fp8");
    expect(pinned.warnings).toContainEqual(expect.stringMatching(/baidu\/fp8 reports low recent uptime \(90%\)/));
  });

  it("warns when provider.order lists more than one entry", () => {
    const params = { ...BASELINE, provider: { order: ["baidu/fp8", "streamlake/fp8"] } };
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, params);
    expect(resolution.endpoint.tag).toBe("baidu/fp8");
    expect(resolution.params.provider).toMatchObject({ order: ["baidu/fp8", "streamlake/fp8"] });
    expect(resolution.warnings).toEqual([expect.stringMatching(/lists 2 entries; only the first was validated/)]);
  });

  it("applies provider.ignore and provider.only when choosing the endpoint", () => {
    const ignored = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { ignore: ["baidu"] } });
    expect(ignored.endpoint.tag).toBe("streamlake/fp8");
    expect(ignored.ranked.find((entry) => entry.endpoint.tag === "baidu/fp8")!.problems).toEqual(["in provider.ignore"]);
    expect(ignored.params.provider).toEqual({
      order: ["streamlake/fp8"],
      allow_fallbacks: false,
      require_parameters: true,
      ignore: ["baidu"],
    });

    const only = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { only: ["novita", "parasail/fp8"] } });
    expect(only.endpoint.tag).toBe("novita/fp8");
    expect(only.ranked.filter((entry) => entry.problems.length === 0).map((entry) => entry.endpoint.tag).sort()).toEqual([
      "novita/fp8",
      "parasail/fp8",
    ]);
  });

  it("applies provider.quantizations, with fp4 and fp8 covering their variants", () => {
    const fp4 = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { quantizations: ["fp4"] } });
    expect(fp4.endpoint.tag).toBe("relace/fp4");
    const nvfp4 = { ...endpoint("baidu/fp8"), tag: "nv/fp4", quantization: "nvfp4" };
    const unknown = resolveEndpoint(MODEL, [...ENDPOINTS, nvfp4], { ...BASELINE, provider: { quantizations: ["unknown"] } });
    expect(unknown.endpoint.tag).toBe("venice");
    expect(resolveEndpoint(MODEL, [nvfp4], { ...BASELINE, provider: { quantizations: ["fp4"] } }).endpoint.tag).toBe("nv/fp4");
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { quantizations: ["bf16"] } })).toThrow(
      /No endpoint of deepseek\/deepseek-v4-flash can serve these params[\s\S]*quantization fp8 not in provider\.quantizations/,
    );
  });

  it("applies provider.max_price, in USD per million tokens", () => {
    // baidu/fp8 costs 0.0592 in and 0.1184 out; streamlake/fp8 0.0594 and 0.1187; relace/fp4 1.28 out.
    const capped = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { max_price: { prompt: 0.0593 } } });
    expect(capped.endpoint.tag).toBe("baidu/fp8");
    expect(capped.ranked.find((entry) => entry.endpoint.tag === "streamlake/fp8")!.problems).toEqual([
      "$0.0594/M in > provider.max_price.prompt 0.0593",
    ]);
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { max_price: { completion: 0.1 } } })).toThrow(
      /No endpoint/,
    );
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { max_price: { prompt: "cheap" } } })).toThrow(
      /max_price\.prompt must be a number/,
    );
  });

  it("rejects an explicit pin that the params' own provider filters exclude", () => {
    expect(() =>
      resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, provider: { order: ["baidu/fp8"], ignore: ["baidu"] } }),
    ).toThrow(/"baidu\/fp8" can't serve these params[\s\S]*baidu\/fp8: in provider\.ignore/);
  });

  it("warns that provider.sort and preferred_* can't take effect under an automatic pin", () => {
    const resolution = resolveEndpoint(MODEL, ENDPOINTS, {
      ...BASELINE,
      provider: { sort: "throughput", preferred_max_latency: 2 },
    });
    expect(resolution.warnings).toEqual([
      expect.stringMatching(/was pinned automatically, by list price/),
      expect.stringMatching(/provider sort, preferred_max_latency can't take effect: every request goes to the pinned baidu\/fp8/),
    ]);
  });

  it("checks a tool_choice mode against the endpoint's supports_tool_choice", () => {
    // Of the healthy endpoints, only deepinfra/fp8 and azure/us honor "required".
    const required = resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, tool_choice: "required" });
    expect(required.endpoint.tag).toBe("deepinfra/fp8");
    expect(required.ranked.find((entry) => entry.endpoint.tag === "baidu/fp8")!.problems).toEqual([
      "doesn't support tool_choice required",
    ]);
    const named = { type: "function", function: { name: "read_board" } };
    expect(resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, tool_choice: named }).endpoint.tag).toBe("deepinfra/fp8");
    expect(resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, tool_choice: "auto" }).endpoint.tag).toBe("baidu/fp8");
    expect(() => resolveEndpoint(MODEL, ENDPOINTS, { ...BASELINE, tool_choice: 3 })).toThrow(/params\.tool_choice must be/);
  });

  it("is idempotent on its own output", () => {
    const first = resolveEndpoint(MODEL, ENDPOINTS, BASELINE);
    const second = resolveEndpoint(MODEL, ENDPOINTS, first.params);
    expect(second.params).toEqual(first.params);
    expect(JSON.stringify(second.params)).toBe(JSON.stringify(first.params));
    expect(second.endpoint.tag).toBe(first.endpoint.tag);
  });

  it("explains, with the endpoint table, when nothing is compatible", () => {
    // parasail/fp8 supports logprobs and seed, but no endpoint allows 950000 output tokens.
    const params = { ...BASELINE, logprobs: true, seed: 1, max_tokens: 950_000 };
    let message = "";
    try {
      resolveEndpoint(MODEL, ENDPOINTS, params);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("No endpoint of deepseek/deepseek-v4-flash can serve these params.");
    expect(message).toContain("Required parameters: tools, max_tokens, reasoning, temperature, logprobs, seed; max_tokens 950000.");
    expect(message).toMatch(/baidu\/fp8 .*doesn't support: logprobs, seed; max_tokens 950000 > max output 131072/);
    expect(message).toMatch(/parasail\/fp8 .* {2}max_tokens 950000 > max output 943718\n/);
    expect(message).toContain("pin an endpoint with params.provider.order");
    expect(message.split("\n").length).toBeGreaterThan(ENDPOINTS.length);
  });

  it("throws when the model has no endpoints", () => {
    expect(() => resolveEndpoint(MODEL, [], BASELINE)).toThrow(/no endpoints/);
  });
});

describe("formatEndpointTable", () => {
  it("renders a fixed-width table marking the chosen endpoint", () => {
    const { ranked, endpoint: chosen } = resolveEndpoint(MODEL, ENDPOINTS, BASELINE);
    const lines = formatEndpointTable(ranked, chosen.tag).split("\n");
    expect(lines).toHaveLength(ranked.length + 1);
    expect(lines[0]).toMatch(/^\s+tag\s+quant\s+context\s+max out\s+\$\/M in\s+\$\/M out\s+blended\s+problems$/);
    expect(lines[1]).toMatch(/^\*\s+baidu\/fp8\s+fp8\s+1\.05M\s+131k\s+0\.0592\s+0\.1184\s+0\.0646\s+ok$/);
    expect(lines.filter((line) => line.startsWith("*"))).toHaveLength(1);
    expect(lines.find((line) => line.includes("open-inference/fp8"))).toMatch(/unhealthy \(status -2\)$/);
    const problemsColumn = lines[0]!.indexOf("problems");
    for (const line of lines.slice(1)) expect(line.slice(problemsColumn - 2, problemsColumn)).toBe("  ");
  });

  it("marks nothing without a chosen tag and shows unknown values", () => {
    const odd = { ...endpoint("baidu/fp8"), tag: "odd", quantization: null, max_completion_tokens: null, pricing: {} };
    const table = formatEndpointTable([{ endpoint: odd, blended_price_per_m: Infinity, problems: [] }], null);
    expect(table.split("\n")[1]).toMatch(/^\s+odd\s+-\s+1\.05M\s+-\s+\?\s+\?\s+\?\s+ok$/);
  });
});
