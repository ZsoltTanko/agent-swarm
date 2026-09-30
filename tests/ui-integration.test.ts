import { afterEach, describe, expect, it, vi } from "vitest";
import { isNotFound, loadCachedCall, loadDocument } from "../src/ui/api.ts";
import { DEFAULT_RUN_PARAMS, selectionPatch, transcriptAgentOf } from "../src/ui/url.ts";

function stubFetch(statuses: number[]) {
  const fetch = vi.fn(async () => {
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: `status ${status}` }), { status });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("loadDocument and loadCachedCall", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetch each resource once per session", async () => {
    const fetch = stubFetch([200]);
    await loadDocument("run-a", "01-survey");
    await loadDocument("run-a", "01-survey");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keep a 404, but try again after any other failure", async () => {
    const fetch = stubFetch([404, 500, 200]);
    const key = "a".repeat(64);
    await expect(loadCachedCall(key)).rejects.toSatisfy(isNotFound);
    await expect(loadCachedCall(key)).rejects.toSatisfy(isNotFound);
    expect(fetch).toHaveBeenCalledTimes(1);

    const other = "b".repeat(64);
    await expect(loadCachedCall(other)).rejects.toThrow("status 500");
    await expect(loadCachedCall(other)).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("selectionPatch", () => {
  it("points the transcript at the agent of a selected step or agent", () => {
    expect(selectionPatch({ kind: "step", agent: "Wren", tick: 4 })).toEqual({
      selection: { kind: "step", agent: "Wren", tick: 4 },
      agent: "Wren",
    });
    expect(selectionPatch({ kind: "agent", agent: "Moth" })).toEqual({ selection: { kind: "agent", agent: "Moth" }, agent: "Moth" });
  });

  it("leaves the transcript agent alone for posts, documents, versions, and no selection", () => {
    expect(selectionPatch({ kind: "post", id: 3 })).toEqual({ selection: { kind: "post", id: 3 } });
    expect(selectionPatch({ kind: "doc", id: "01-survey" })).toEqual({ selection: { kind: "doc", id: "01-survey" } });
    expect(selectionPatch({ kind: "version", version: 2 })).toEqual({ selection: { kind: "version", version: 2 } });
    expect(selectionPatch({ kind: "none" })).toEqual({ selection: { kind: "none" } });
  });
});

describe("transcriptAgentOf", () => {
  it("prefers the agent picked for the transcript", () => {
    expect(transcriptAgentOf({ ...DEFAULT_RUN_PARAMS, agent: "Otter", selection: { kind: "step", agent: "Wren", tick: 2 } })).toBe(
      "Otter",
    );
  });

  it("falls back to the selected step's or agent's agent, else null (the first agent)", () => {
    expect(transcriptAgentOf({ ...DEFAULT_RUN_PARAMS, selection: { kind: "step", agent: "Wren", tick: 2 } })).toBe("Wren");
    expect(transcriptAgentOf({ ...DEFAULT_RUN_PARAMS, selection: { kind: "agent", agent: "Tern" } })).toBe("Tern");
    expect(transcriptAgentOf({ ...DEFAULT_RUN_PARAMS, selection: { kind: "post", id: 1 } })).toBeNull();
    expect(transcriptAgentOf(DEFAULT_RUN_PARAMS)).toBeNull();
  });
});
