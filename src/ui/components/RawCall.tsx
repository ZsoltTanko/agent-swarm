import { useEffect, useState } from "react";
import type { CachedCall } from "../../shared/api.ts";
import { formatDuration } from "../../shared/derive.ts";
import { errorMessage, isNotFound, loadCachedCall } from "../api.ts";
import { JsonView } from "./JsonView.tsx";
import "./RawCall.css";

type RawState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; call: CachedCall };

/** A step's raw request and response, from the harness's response cache. */
export function RawCall({ cacheKey }: { cacheKey: string }) {
  const [raw, setRaw] = useState<RawState>({ kind: "loading" });
  useEffect(() => {
    let alive = true;
    setRaw({ kind: "loading" });
    loadCachedCall(cacheKey).then(
      (call) => alive && setRaw({ kind: "loaded", call }),
      (error: unknown) =>
        alive && setRaw(isNotFound(error) ? { kind: "missing" } : { kind: "error", message: errorMessage(error) }),
    );
    return () => {
      alive = false;
    };
  }, [cacheKey]);

  switch (raw.kind) {
    case "loading":
      return (
        <p className="raw-call-note" role="status">
          Loading the cache entry…
        </p>
      );
    case "missing":
      return <p className="raw-call-note">Not in the response cache. That's normal for scripted runs, which cache nothing.</p>;
    case "error":
      return (
        <p className="raw-call-note raw-call-error" role="alert">
          Couldn't load the cache entry: {raw.message}
        </p>
      );
    case "loaded": {
      const { call } = raw;
      return (
        <div className="raw-call">
          <p className="raw-call-note num">
            {formatDuration(call.latency_ms)} · {call.attempts} {call.attempts === 1 ? "attempt" : "attempts"} · cached{" "}
            {new Date(call.created_at).toLocaleString()}
          </p>
          {call.error && (
            <p className="raw-call-note raw-call-error">
              {call.error.kind}: {call.error.message}
            </p>
          )}
          <JsonView value={call.request} label="request" defaultDepth={1} />
          <JsonView value={call.response} label="response" defaultDepth={2} />
          <JsonView value={call.headers} label="headers" defaultDepth={0} />
        </div>
      );
    }
  }
}
