import { useCallback, useEffect, useRef, useState } from "react";
import { RunView } from "./components/RunView.tsx";
import { RunsList } from "./components/RunsList.tsx";
import { formatHash, parseHash, type ParamsUpdate, type Route } from "./url.ts";

/**
 * Browsers throttle history.replaceState (Safari allows about 100 calls per 30 s), and scrubbing or
 * playback changes the tick many times a second, so URL writes are throttled to one per interval.
 */
const URL_WRITE_INTERVAL_MS = 400;

/** Both routes show the runs list, or both show the same run. */
function samePage(a: Route, b: Route): boolean {
  if (a.page === "runs" || b.page === "runs") return a.page === b.page;
  return a.runId === b.runId;
}

/** Hash routing. The route is React state; in-run changes are mirrored to the URL with replaceState. */
export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const lastWrite = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingHash = useRef<string | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const hash = pendingHash.current;
    pendingHash.current = null;
    if (hash === null || hash === window.location.hash) return;
    // A navigation whose hashchange hasn't been handled yet (a click on "Runs") wins over this write.
    if (!samePage(parseHash(hash), parseHash(window.location.hash))) return;
    lastWrite.current = Date.now();
    try {
      window.history.replaceState(window.history.state, "", hash);
    } catch {
      // Throttled by the browser; the next change writes the URL again.
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      // Navigation (back, forward, a link, an edited URL) wins over a write still waiting.
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pendingHash.current = null;
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  // Mirror the route into the URL without adding history entries.
  useEffect(() => {
    const hash = formatHash(route);
    if (route.page === "runs" && (window.location.hash === "" || window.location.hash === "#")) return;
    pendingHash.current = hash;
    const wait = lastWrite.current + URL_WRITE_INTERVAL_MS - Date.now();
    if (wait <= 0) flush();
    else if (timer.current === null) timer.current = setTimeout(flush, wait);
  }, [route, flush]);

  useEffect(() => {
    document.title = route.page === "run" ? `${route.runId} · Swarm observer` : "Runs · Swarm observer";
  }, [route]);

  const runId = route.page === "run" ? route.runId : null;
  const setParams = useCallback(
    (update: ParamsUpdate) => {
      setRoute((current) => {
        if (current.page !== "run" || current.runId !== runId) return current;
        const patch = typeof update === "function" ? update(current.params) : update;
        return { ...current, params: { ...current.params, ...patch } };
      });
    },
    [runId],
  );

  if (route.page === "runs") return <RunsList />;
  return <RunView key={route.runId} runId={route.runId} params={route.params} setParams={setParams} />;
}
