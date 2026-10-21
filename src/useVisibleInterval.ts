import { useEffect, useRef } from "react";

/** The slice of Document the poller needs, so tests can drive it without a DOM. */
export type VisibilitySource = {
  hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

/**
 * Runs `task` every `intervalMs`, but only while the tab is visible.
 *
 * A hidden tab costs the server exactly as much as a visible one and nobody is reading the
 * result, so polling it is pure waste on a box that is also encoding video. Coming back to the
 * tab fires one immediate catch-up run, so the UI is never stale after a focus.
 *
 * Split out from the hook so the policy itself is testable: this project's front-end tests run
 * through renderToStaticMarkup and have no DOM to mount a hook into.
 *
 * Returns a disposer. Use this for purely presentational polls only -- anything that has to
 * observe a transition into a terminal state must keep polling while hidden.
 */
export function startVisibleInterval(task: () => void, intervalMs: number, doc: VisibilitySource): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  };
  const start = () => {
    if (timer !== undefined) return;
    // One rule only: a live timer means "keep polling". Keeping a second `document.hidden` check
    // inside the callback as well would make the two layers mask each other, so neither could be
    // tested -- and it would leave a timer spinning every interval doing nothing while hidden.
    timer = setInterval(task, intervalMs);
  };
  const onVisibilityChange = () => {
    if (doc.hidden) { stop(); return; }
    task();
    start();
  };
  if (!doc.hidden) start();
  doc.addEventListener("visibilitychange", onVisibilityChange);
  return () => { stop(); doc.removeEventListener("visibilitychange", onVisibilityChange); };
}

/**
 * React binding for {@link startVisibleInterval}.
 *
 * Latest-ref pattern: the caller passes a fresh closure on every render, which must not restart
 * the timer -- otherwise a page that re-renders often would never poll at all.
 */
export function useVisibleInterval(task: () => void, intervalMs: number): void {
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => startVisibleInterval(() => latest.current(), intervalMs, document), [intervalMs]);
}
