import { afterEach, describe, expect, it, vi } from "vitest";
import { startVisibleInterval } from "./useVisibleInterval";

function fakeDoc(hidden = false) {
  const listeners = new Set<() => void>();
  const state = { hidden };
  return {
    get hidden() { return state.hidden; },
    addEventListener: (_type: "visibilitychange", listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: "visibilitychange", listener: () => void) => { listeners.delete(listener); },
    /** Simulates the browser flipping visibility and firing the event, like a tab switch. */
    setHidden(value: boolean) {
      state.hidden = value;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("startVisibleInterval", () => {
  it("polls on the interval while the tab is visible", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const task = vi.fn();
    const dispose = startVisibleInterval(task, 1_000, doc);

    vi.advanceTimersByTime(3_000);
    expect(task).toHaveBeenCalledTimes(3);

    dispose();
  });

  it("goes silent while the tab is hidden instead of polling it", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const task = vi.fn();
    const dispose = startVisibleInterval(task, 1_000, doc);

    vi.advanceTimersByTime(1_000);
    expect(task).toHaveBeenCalledTimes(1);

    doc.setHidden(true);
    task.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(task).not.toHaveBeenCalled();

    dispose();
  });

  it("does not poll at all when it is created in a hidden tab", () => {
    vi.useFakeTimers();
    const doc = fakeDoc(true);
    const task = vi.fn();
    const dispose = startVisibleInterval(task, 1_000, doc);

    vi.advanceTimersByTime(5_000);
    expect(task).not.toHaveBeenCalled();

    dispose();
  });

  it("catches up once on return, then resumes the interval", () => {
    vi.useFakeTimers();
    const doc = fakeDoc(true);
    const task = vi.fn();
    const dispose = startVisibleInterval(task, 1_000, doc);
    vi.advanceTimersByTime(5_000);
    expect(task).not.toHaveBeenCalled();

    doc.setHidden(false);
    // Waiting a full interval on focus would show stale data for a second; the catch-up run
    // is what makes the visible tab correct immediately.
    expect(task).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(task).toHaveBeenCalledTimes(3);

    dispose();
  });

  it("stops the timer and drops its listener when disposed", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const task = vi.fn();
    const dispose = startVisibleInterval(task, 1_000, doc);
    expect(doc.listenerCount()).toBe(1);

    dispose();
    expect(doc.listenerCount()).toBe(0);

    vi.advanceTimersByTime(5_000);
    expect(task).not.toHaveBeenCalled();
  });

  it("survives a visibility event for an unchanged state without double-starting", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const task = vi.fn();
    const dispose = startVisibleInterval(task, 1_000, doc);

    // Some browsers fire visibilitychange on focus even when nothing changed; a second timer
    // would double the request rate for the whole session.
    doc.setHidden(false);
    vi.advanceTimersByTime(1_000);
    expect(task).toHaveBeenCalledTimes(2); // one catch-up + one tick, not two ticks

    dispose();
  });
});
