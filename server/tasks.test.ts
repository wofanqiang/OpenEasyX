import { describe, expect, it, vi } from "vitest";
import { TaskRegistry, TASK_TTL_MS } from "./tasks.js";

const registry = () => new TaskRegistry();

describe("TaskRegistry", () => {
  it("starts queued and promotes to running on the first update", () => {
    let clock = 1_000;
    const tasks = new TaskRegistry(() => clock);
    const handle = tasks.create({ kind: "merge", label: "Merging 2 videos", total: 2 });

    expect(tasks.get(handle.id)).toMatchObject({ status: "queued", phase: "waiting", progress: null, done: 0, total: 2 });

    clock = 1_500;
    handle.update({ phase: "probing", detail: "Measuring 2 videos" });
    expect(tasks.get(handle.id)).toMatchObject({ status: "running", phase: "probing", startedAt: 1_500, detail: "Measuring 2 videos" });

    handle.update({ phase: "merging", progress: 0.5 });
    expect(tasks.get(handle.id)).toMatchObject({ status: "running", phase: "merging", progress: 0.5 });
  });

  it("lists jobs in creation order and expires settled ones after the grace period", () => {
    let clock = 1_000;
    const tasks = new TaskRegistry(() => clock, 1_000);
    const first = tasks.create({ kind: "recover", label: "Recovering" });
    clock = 1_010;
    const second = tasks.create({ kind: "merge", label: "Merging" });
    clock = 1_020;
    first.finish({ rescued: 1 });

    expect(tasks.list().map((task) => task.id)).toEqual([first.id, second.id]);
    // Still there a moment later: the "done" state has to be observable by the Activity page.
    clock = 1_500;
    expect(tasks.list()).toHaveLength(2);
    clock = 2_021;
    expect(tasks.list().map((task) => task.id)).toEqual([second.id]);
    expect(tasks.get(first.id)).toBeUndefined();
  });

  it("keeps the default grace period when none is configured", () => {
    expect(TASK_TTL_MS).toBeGreaterThan(0);
    const tasks = registry();
    const handle = tasks.create({ kind: "merge", label: "Merging" });
    handle.finish();
    expect(tasks.get(handle.id)?.status).toBe("done");
  });

  it("reports a cancel immediately, runs the executor's hook, and ignores a late finish", () => {
    const tasks = registry();
    const handle = tasks.create({ kind: "merge", label: "Merging 2 videos" });
    const stop = vi.fn();
    handle.setCancel(stop);

    expect(tasks.cancel(handle.id)).toMatchObject({ status: "cancelled" });
    expect(stop).toHaveBeenCalledOnce();
    expect(handle.isCancelled()).toBe(true);

    // The worker's own cleanup ends with `finish`; it must not resurrect a cancelled job.
    handle.update({ phase: "merging", progress: 0.9 });
    handle.finish({ mergedId: "abc" });
    expect(tasks.get(handle.id)).toMatchObject({ status: "cancelled", phase: "finished" });
    expect(tasks.get(handle.id)?.result).toBeUndefined();

    // Cancelling twice is harmless, and an unknown id reports nothing to cancel.
    expect(tasks.cancel(handle.id)).toMatchObject({ status: "cancelled" });
    expect(stop).toHaveBeenCalledOnce();
    expect(tasks.cancel("task-nope")).toBeUndefined();
  });

  it("survives an executor whose cancel hook throws", () => {
    const tasks = registry();
    const handle = tasks.create({ kind: "merge", label: "Merging" });
    handle.setCancel(() => { throw new Error("killed too hard"); });
    expect(tasks.cancel(handle.id)).toMatchObject({ status: "cancelled" });
  });

  it("finishes with 100% only when the job actually reported progress", () => {
    const tasks = registry();
    const measured = tasks.create({ kind: "merge", label: "Merging" });
    measured.update({ phase: "merging", progress: 0.4 });
    measured.finish();
    expect(tasks.get(measured.id)).toMatchObject({ status: "done", progress: 1 });

    const indeterminate = tasks.create({ kind: "merge", label: "Merging" });
    indeterminate.update({ phase: "indexing", progress: null });
    indeterminate.finish();
    expect(tasks.get(indeterminate.id)).toMatchObject({ status: "done", progress: null });

    const failed = tasks.create({ kind: "merge", label: "Merging" });
    failed.update({ phase: "merging", progress: 0.4 });
    failed.fail("the merge produced no output file");
    expect(tasks.get(failed.id)).toMatchObject({ status: "failed", progress: null, error: "the merge produced no output file" });
  });

  it("summarises a result without the per-item lists it carries", () => {
    const tasks = registry();
    const handle = tasks.create({ kind: "recover", label: "Recovering" });
    handle.finish({ scanned: 9, rescued: 2, dryRun: false, leftover: null, items: [{ itemId: "a" }, { itemId: "b" }] });
    expect(tasks.get(handle.id)?.result).toEqual({ scanned: 9, rescued: 2, dryRun: false, leftover: null });
  });

  it("reports the sources of running merge jobs only", () => {
    const tasks = registry();
    const merge = tasks.create({ kind: "merge", label: "Merging", sourceIds: ["a", "b"] });
    tasks.create({ kind: "recover", label: "Recovering" });
    expect(tasks.activeSourceIds().sort()).toEqual(["a", "b"]);

    merge.update({ phase: "merging" });
    expect(tasks.activeSourceIds().sort()).toEqual(["a", "b"]);

    merge.finish({ mergedId: "x" });
    expect(tasks.activeSourceIds()).toEqual([]);
  });
});
