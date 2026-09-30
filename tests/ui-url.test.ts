import { describe, expect, it } from "vitest";
import { CENTER_TABS, NO_SELECTION, type Selection } from "../src/ui/contract.ts";
import {
  DEFAULT_RUN_PARAMS,
  decodeSelection,
  encodeSelection,
  formatHash,
  parseHash,
  runHref,
  sameSelection,
  type Route,
} from "../src/ui/url.ts";

const SELECTIONS: Selection[] = [
  { kind: "none" },
  { kind: "step", agent: "Otter", tick: 12 },
  { kind: "post", id: 7 },
  { kind: "doc", id: "03-budget-memo" },
  { kind: "version", version: 3 },
  { kind: "agent", agent: "Wren" },
];

describe("selection encoding", () => {
  it("encodes each kind in the documented form", () => {
    expect(SELECTIONS.map(encodeSelection)).toEqual([
      null,
      "step:Otter@12",
      "post:7",
      "doc:03-budget-memo",
      "version:3",
      "agent:Wren",
    ]);
  });

  it("round-trips every kind", () => {
    for (const selection of SELECTIONS) expect(decodeSelection(encodeSelection(selection))).toEqual(selection);
  });

  it("splits a step at the last @", () => {
    expect(decodeSelection("step:odd@name@4")).toEqual({ kind: "step", agent: "odd@name", tick: 4 });
  });

  it("keeps colons inside document ids", () => {
    expect(decodeSelection("doc:a:b")).toEqual({ kind: "doc", id: "a:b" });
  });

  it.each([
    ["", "empty"],
    ["post", "no colon"],
    ["post:", "no id"],
    ["post:0", "post 0"],
    ["post:-1", "negative"],
    ["post:1.5", "fraction"],
    ["step:Otter", "no tick"],
    ["step:@3", "no agent"],
    ["step:Otter@x", "bad tick"],
    ["version:0", "the empty version"],
    ["doc:", "no doc id"],
    ["agent:", "no agent"],
    ["tick:3", "unknown kind"],
  ])("decodes %j (%s) as no selection", (value) => {
    expect(decodeSelection(value)).toEqual(NO_SELECTION);
  });

  it("compares selections by value", () => {
    expect(sameSelection({ kind: "post", id: 3 }, { kind: "post", id: 3 })).toBe(true);
    expect(sameSelection({ kind: "post", id: 3 }, { kind: "version", version: 3 })).toBe(false);
  });
});

describe("parseHash", () => {
  it.each(["", "#", "#/", "#/runs", "/", "#/unknown/thing", "#/run/", "#/run"])("routes %j to the runs list", (hash) => {
    expect(parseHash(hash)).toEqual({ page: "runs" });
  });

  it("opens a run with default parameters", () => {
    expect(parseHash("#/run/example-20260928-204625-s1")).toEqual({
      page: "run",
      runId: "example-20260928-204625-s1",
      params: DEFAULT_RUN_PARAMS,
    });
  });

  it("reads every parameter", () => {
    expect(
      parseHash("#/run/r1?t=14&tab=transcript&sel=step:Otter@12&agent=Wren&authors=Heron,Otter&dv=changes"),
    ).toEqual({
      page: "run",
      runId: "r1",
      params: {
        tick: 14,
        tab: "transcript",
        selection: { kind: "step", agent: "Otter", tick: 12 },
        agent: "Wren",
        authors: ["Heron", "Otter"],
        deliverableMode: "changes",
      },
    });
  });

  it("reads the author filter as a list, dropping empty and malformed names and repeats", () => {
    expect(parseHash("#/run/r1?authors=Heron")).toMatchObject({ params: { authors: ["Heron"] } });
    expect(parseHash("#/run/r1?authors=,Heron,,%E0%A4%A,Otter,Heron,")).toMatchObject({
      params: { authors: ["Heron", "Otter"] },
    });
    expect(parseHash("#/run/r1?authors=")).toMatchObject({ params: { authors: [] } });
    expect(parseHash("#/run/r1?authors=a%2Cb,c")).toMatchObject({ params: { authors: ["a,b", "c"] } });
  });

  it("shows the deliverable's text unless dv=changes", () => {
    expect(parseHash("#/run/r1?dv=changes")).toMatchObject({ params: { deliverableMode: "changes" } });
    expect(parseHash("#/run/r1?dv=text")).toMatchObject({ params: { deliverableMode: "text" } });
    expect(parseHash("#/run/r1?dv=diff")).toMatchObject({ params: { deliverableMode: "text" } });
  });

  it("reads t=live and t=0", () => {
    expect(parseHash("#/run/r1?t=live").page === "run" && parseHash("#/run/r1?t=live")).toMatchObject({
      params: { tick: "live" },
    });
    expect(parseHash("#/run/r1?t=0")).toMatchObject({ params: { tick: 0 } });
  });

  it("falls back to defaults for malformed parameters", () => {
    expect(parseHash("#/run/r1?t=-3&tab=nope&sel=garbage&agent=&authors=,&dv=")).toEqual({
      page: "run",
      runId: "r1",
      params: DEFAULT_RUN_PARAMS,
    });
  });

  it("decodes percent-encoded run ids and values, and ignores a trailing slash", () => {
    expect(parseHash("#/run/example%20copy/?sel=doc%3A01%20notes&agent=Otter")).toEqual({
      page: "run",
      runId: "example copy",
      params: { ...DEFAULT_RUN_PARAMS, selection: { kind: "doc", id: "01 notes" }, agent: "Otter" },
    });
  });

  it("goes to the runs list on a malformed escape in the run id, and skips malformed parameters", () => {
    expect(parseHash("#/run/%E0%A4%A")).toEqual({ page: "runs" });
    expect(parseHash("#/run/r1?sel=%E0%A4%A&t=3")).toMatchObject({ params: { tick: 3, selection: NO_SELECTION } });
  });

  it("uses the first occurrence of a repeated parameter", () => {
    expect(parseHash("#/run/r1?t=2&t=9")).toMatchObject({ params: { tick: 2 } });
  });
});

describe("formatHash", () => {
  it("formats the runs list", () => {
    expect(formatHash({ page: "runs" })).toBe("#/");
  });

  it("leaves out parameters at their default", () => {
    expect(runHref("r1")).toBe("#/run/r1");
  });

  it("keeps selections readable", () => {
    expect(runHref("r1", { tick: 5, selection: { kind: "step", agent: "Otter", tick: 5 } })).toBe(
      "#/run/r1?t=5&sel=step:Otter@5",
    );
  });

  it("escapes separators inside values", () => {
    expect(runHref("a b", { selection: { kind: "doc", id: "x&y=z" } })).toBe("#/run/a%20b?sel=doc:x%26y%3Dz");
    expect(runHref("r1", { authors: ["a,b", "c&d"] })).toBe("#/run/r1?authors=a%2Cb,c%26d");
  });

  it("writes the author filter and the deliverable mode readably, and leaves them out at their default", () => {
    expect(runHref("r1", { authors: ["Heron", "Otter"], deliverableMode: "changes" })).toBe(
      "#/run/r1?authors=Heron,Otter&dv=changes",
    );
    expect(runHref("r1", { authors: [], deliverableMode: "text" })).toBe("#/run/r1");
  });

  it("round-trips through parseHash", () => {
    const routes: Route[] = [
      { page: "runs" },
      ...CENTER_TABS.map(
        (tab, i): Route => ({
          page: "run",
          runId: i % 2 === 0 ? "example-20260928-204625-s1" : "example copy (2)",
          params: {
            tick: i === 0 ? null : i === 1 ? "live" : i * 3,
            tab,
            selection: SELECTIONS[i % SELECTIONS.length]!,
            agent: i % 3 === 0 ? null : "Otter",
            authors: [[], ["Heron"], ["Heron", "Otter", "Wren"]][i % 3]!,
            deliverableMode: i % 2 === 0 ? "text" : "changes",
          },
        }),
      ),
      {
        page: "run",
        runId: "r",
        params: {
          tick: 0,
          tab: "timeline",
          selection: { kind: "doc", id: "odd id: #1 & more/?" },
          agent: "Ibis",
          authors: ["odd, name", "a&b=c", "x@y:z"],
          deliverableMode: "changes",
        },
      },
    ];
    for (const route of routes) expect(parseHash(formatHash(route))).toEqual(route);
  });
});
