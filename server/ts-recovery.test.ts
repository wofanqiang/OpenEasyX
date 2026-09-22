import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { DownloadQueue } from "./downloader.js";
import { TaskRegistry, type TaskSnapshot } from "./tasks.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // Windows can still hold handles on a just-remuxed file; the directory is disposable.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };

/** Recovery needs a real probe/remux, so the suite is skipped where ffmpeg is unavailable. */
function ffmpegAvailable() {
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}
const hasFfmpeg = ffmpegAvailable();

/** Writes the shape a killed live recording leaves behind: a raw MPEG-TS capture with A/V streams. */
function writePlayableCapture(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1",
    "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-f", "mpegts", file,
  ]);
}
function writeUnplayableCapture(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "definitely not a transport stream");
}
/** A real, decodable MP4: the shape a successful rescue leaves in the recovery folder. */
function writePlayableMp4(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1",
    "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-movflags", "+faststart", file,
  ]);
}

async function harness() {
  const dataDir = temp("easyx-recovery-data"); const mediaDir = temp("easyx-recovery-media"); const pluginDir = temp("easyx-recovery-plugins");
  const db = new Database(dataDir);
  const manager = new PluginManager(db, [pluginDir]); await manager.load();
  const queue = new DownloadQueue(db, manager, mediaDir);
  const person = db.upsertPerformer({ externalId: "person", name: "Recovery Performer" }, "test.recovery");
  const source = db.addSource(person.id, "test.recovery", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
  const item = (externalId: string, status = "failed") => {
    db.ingestItems(source, [{ externalId, mediaType: "video", filename: `${externalId}.mp4`, metadata: {} }]);
    const created = db.listItems().find((entry) => entry.externalId === externalId)!;
    db.setItemStatus(created.id, status);
    return created;
  };
  return { db, queue, mediaDir, item, captureDir: (id: string) => path.join(mediaDir, ".downloads", id), recoveryDir: (id: string) => path.join(mediaDir, ".recording-recovery", id) };
}

/** Polls the registry until the job leaves the queued/running pair, the way the Activity page does. */
async function settle(registry: TaskRegistry, taskId: string): Promise<TaskSnapshot> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const task = registry.get(taskId);
    if (!task) throw new Error(`task ${taskId} vanished`);
    if (task.status !== "queued" && task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`task ${taskId} never settled`);
}

describe.skipIf(!hasFfmpeg)("residual TS recovery", () => {
  it("reports a dry run, then rescues playable captures and deletes unplayable ones", async () => {
    const env = await harness();
    const playable = env.item("playable"); const broken = env.item("broken");
    writePlayableCapture(path.join(env.captureDir(playable.id), "capture.ts"));
    writeUnplayableCapture(path.join(env.captureDir(broken.id), "capture.ts"));

    const dry = await env.queue.recoverResidualTs({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.scanned).toBe(2);
    expect(dry.rescued).toBe(1);
    expect(dry.deleted).toBe(1);
    // A dry run must not touch the disk.
    expect(fs.existsSync(path.join(env.captureDir(playable.id), "capture.ts"))).toBe(true);
    expect(fs.existsSync(path.join(env.captureDir(broken.id), "capture.ts"))).toBe(true);
    expect(fs.existsSync(env.recoveryDir(playable.id))).toBe(false);

    // Calling with no options is a dry run too, so the UI never mutates by accident.
    const implicit = await env.queue.recoverResidualTs();
    expect(implicit.dryRun).toBe(true);
    expect(fs.existsSync(path.join(env.captureDir(playable.id), "capture.ts"))).toBe(true);

    const report = await env.queue.recoverResidualTs({ execute: true });
    expect(report.dryRun).toBe(false);
    expect(report.rescued).toBe(1);
    expect(report.deleted).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.leftover).toBe(0);

    const recovered = path.join(env.recoveryDir(playable.id), "recovered.mp4");
    expect(fs.existsSync(recovered)).toBe(true);
    expect(fs.statSync(recovered).size).toBeGreaterThan(0);
    // The leftover TS is consumed, and the unplayable staging folder is gone.
    expect(fs.existsSync(path.join(env.captureDir(playable.id), "capture.ts"))).toBe(false);
    expect(fs.existsSync(env.captureDir(broken.id))).toBe(false);

    // A finished rescue is not a residual capture, so a second pass never touches it again.
    const again = await env.queue.recoverResidualTs({ execute: true });
    expect(again.rescued).toBe(0);
    expect(again.deleted).toBe(0);
    expect(again.failed).toBe(0);
    expect(fs.existsSync(recovered)).toBe(true);

    const listed = await env.queue.listRecovered();
    expect(listed.map((entry) => entry.itemId)).toEqual([playable.id]);
    expect(listed[0].size).toBeGreaterThan(0);
    expect(listed[0].performer).toBe("Recovery Performer");
    expect(listed[0].source).toBe("example.test");
    expect(listed[0].cataloged).toBe(false);
  });

  it("skips a capture whose recording is still active", async () => {
    const env = await harness();
    const active = env.item("active", "downloading");
    writePlayableCapture(path.join(env.captureDir(active.id), "capture.ts"));

    const report = await env.queue.recoverResidualTs({ execute: true });
    expect(report.scanned).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.rescued).toBe(0);
    expect(report.items[0]).toEqual({ itemId: active.id, action: "skipped" });
    expect(fs.existsSync(path.join(env.captureDir(active.id), "capture.ts"))).toBe(true);
    expect(fs.existsSync(env.recoveryDir(active.id))).toBe(false);
    expect(await env.queue.listRecovered()).toEqual([]);
  });

  it("archives a recovered recording into its canonical library path", async () => {
    const env = await harness();
    const rescued = env.item("archive-me");
    writePlayableCapture(path.join(env.captureDir(rescued.id), "capture.ts"));
    await env.queue.recoverResidualTs({ execute: true });

    const result = await env.queue.catalogRecovered(rescued.id);
    expect(result.cataloged).toBe(true);
    expect(result.storagePath).toBeTruthy();
    const stored = path.join(env.mediaDir, result.storagePath!);
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.statSync(stored).size).toBeGreaterThan(0);

    // The recovered copy is consumed and the item becomes a normal library entry.
    expect(fs.existsSync(env.recoveryDir(rescued.id))).toBe(false);
    expect(env.db.getItem(rescued.id)?.status).toBe("completed");
    expect(await env.queue.listRecovered()).toEqual([]);
  });

  it("never overwrites a completed library recording and keeps the salvage for the operator", async () => {
    const env = await harness();
    const completed = env.item("already-done");
    writePlayableCapture(path.join(env.captureDir(completed.id), "capture.ts"));
    await env.queue.recoverResidualTs({ execute: true });

    // Pretend the item finished normally and its file is already in the library.
    const libraryFile = path.join(env.mediaDir, "Recovery Performer", "example.test", "already-done.mp4");
    fs.mkdirSync(path.dirname(libraryFile), { recursive: true });
    fs.writeFileSync(libraryFile, "the original library copy");
    env.db.setItemStatus(completed.id, "completed", { progress: 1, storagePath: path.join("Recovery Performer", "example.test", "already-done.mp4") });

    const result = await env.queue.catalogRecovered(completed.id);
    expect(result).toEqual({ cataloged: false, reason: "already-completed" });
    expect(fs.readFileSync(libraryFile, "utf8")).toBe("the original library copy");
    // Deleting footage on the user's behalf is not ours to decide: the salvage stays put and
    // the operator removes it from the Recovery page.
    expect(fs.existsSync(path.join(env.recoveryDir(completed.id), "recovered.mp4"))).toBe(true);
    expect(await env.queue.listRecovered()).toHaveLength(1);
  });

  it("deletes recovered recordings in bulk and reports failures per id", async () => {
    const env = await harness();
    const first = env.item("bulk-one"); const second = env.item("bulk-two");
    writePlayableCapture(path.join(env.captureDir(first.id), "capture.ts"));
    writePlayableCapture(path.join(env.captureDir(second.id), "capture.ts"));
    await env.queue.recoverResidualTs({ execute: true });
    expect((await env.queue.listRecovered()).length).toBe(2);

    const removal = await env.queue.deleteRecovered([first.id, second.id]);
    expect(removal.deleted.sort()).toEqual([first.id, second.id].sort());
    expect(removal.failed).toEqual([]);
    expect(fs.existsSync(env.recoveryDir(first.id))).toBe(false);
    expect(fs.existsSync(env.recoveryDir(second.id))).toBe(false);
    expect(await env.queue.listRecovered()).toEqual([]);
  });

  it("serves stream and poster paths only while a recovered file exists", async () => {
    const env = await harness();
    const rescued = env.item("stream-me");
    writePlayableCapture(path.join(env.captureDir(rescued.id), "capture.ts"));

    expect(env.queue.recoveredStreamPath(rescued.id)).toBeNull();
    await env.queue.recoverResidualTs({ execute: true });
    expect(env.queue.recoveredStreamPath(rescued.id)).toBe(path.join(env.recoveryDir(rescued.id), "recovered.mp4"));

    await env.queue.catalogRecovered(rescued.id);
    expect(env.queue.recoveredStreamPath(rescued.id)).toBeNull();
  });

  it("keeps an earlier salvage in the recovery folder when a later one is cataloged", async () => {
    const env = await harness();
    const rescued = env.item("keep-earlier");
    writePlayableCapture(path.join(env.captureDir(rescued.id), "capture.ts"));
    await env.queue.recoverResidualTs({ execute: true });

    // An EARLIER salvage covering a different slice of the broadcast is still in the folder.
    const dir = env.recoveryDir(rescued.id);
    fs.writeFileSync(path.join(dir, "capture_part000.ts"), "earlier slice, still raw");
    fs.writeFileSync(path.join(dir, "recovered.parts.json"), JSON.stringify({ parts: 1 }));

    const result = await env.queue.catalogRecovered(rescued.id);
    expect(result.cataloged).toBe(true);
    // Only what the catalog consumed is unlinked; the earlier footage survives.
    expect(fs.existsSync(path.join(dir, "recovered.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "capture_part000.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "recovered.parts.json"))).toBe(true);
    expect(result.leftovers?.slice().sort()).toEqual(["capture_part000.ts", "recovered.parts.json"]);
  });

  it("reports a residual capture as superseded instead of remuxing an unfillable file", async () => {
    const env = await harness();
    const done = env.item("superseded");
    writePlayableCapture(path.join(env.captureDir(done.id), "capture.ts"));

    // The item finished normally and its file is already in the library, so nothing folded
    // here could ever be filed: report it rather than burn the box on a useless remux.
    const libraryFile = path.join(env.mediaDir, "Recovery Performer", "example.test", "superseded.mp4");
    fs.mkdirSync(path.dirname(libraryFile), { recursive: true });
    fs.writeFileSync(libraryFile, "the original library copy");
    env.db.setItemStatus(done.id, "completed", { progress: 1, storagePath: path.join("Recovery Performer", "example.test", "superseded.mp4") });

    const report = await env.queue.recoverResidualTs({ execute: true });
    expect(report.superseded).toBe(1);
    expect(report.rescued).toBe(0);
    expect(report.items).toEqual([{ itemId: done.id, action: "superseded" }]);
    // The bytes are left exactly where they were.
    expect(fs.existsSync(path.join(env.captureDir(done.id), "capture.ts"))).toBe(true);
    expect(fs.existsSync(env.recoveryDir(done.id))).toBe(false);
  });

  it("deletes a recovered MP4 that nothing can decode, and leaves a playable one alone", async () => {
    const env = await harness();
    const broken = env.item("broken-rescue");
    const good = env.item("good-rescue");
    // A rescue that produced a file no player can open: the Recovery page would list it as
    // rescuable forever, and this pass is the only thing that can ever remove it without the
    // operator having to click through entries guessing which one will not play.
    fs.mkdirSync(env.recoveryDir(broken.id), { recursive: true });
    fs.writeFileSync(path.join(env.recoveryDir(broken.id), "recovered.mp4"), "not a video at all");
    fs.writeFileSync(path.join(env.recoveryDir(broken.id), "recovered.json"), JSON.stringify({ itemId: broken.id }));
    writePlayableMp4(path.join(env.recoveryDir(good.id), "recovered.mp4"));

    const dry = await env.queue.recoverResidualTs({ dryRun: true });
    expect(dry.deleted).toBe(1);
    // A dry run must not touch the disk.
    expect(fs.existsSync(path.join(env.recoveryDir(broken.id), "recovered.mp4"))).toBe(true);

    const report = await env.queue.recoverResidualTs({ execute: true });
    expect(report.deleted).toBe(1);
    expect(report.failed).toBe(0);
    expect(fs.existsSync(env.recoveryDir(broken.id))).toBe(false);
    // The playable rescue survives untouched and is still offered in the Recovery list.
    expect(fs.existsSync(path.join(env.recoveryDir(good.id), "recovered.mp4"))).toBe(true);
    expect((await env.queue.listRecovered()).map((entry) => entry.itemId)).toEqual([good.id]);
  });

  it("keeps raw parts beside an unplayable recovered MP4 instead of discarding the folder", async () => {
    const env = await harness();
    const item = env.item("broken-with-parts");
    const dir = env.recoveryDir(item.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "recovered.mp4"), "header only, no stream");
    // An earlier salvage covering a different slice of the broadcast: footage nobody asked to lose.
    fs.writeFileSync(path.join(dir, "capture_part000.ts"), "earlier slice, still raw");

    await env.queue.recoverResidualTs({ execute: true });
    expect(fs.existsSync(path.join(dir, "recovered.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "capture_part000.ts"))).toBe(true);
  });

  it("reports a recovered MP4 it could not remove as failed instead of claiming a deletion", async () => {
    const env = await harness();
    const item = env.item("stuck-rescue");
    const dir = env.recoveryDir(item.id);
    // Something that cannot be unlinked sitting where the file should be. The pass must not report
    // this as a deletion: an operator who reads "deleted" would never go looking for the file again,
    // and this one is still on disk.
    fs.mkdirSync(path.join(dir, "recovered.mp4", "blocker"), { recursive: true });
    fs.writeFileSync(path.join(dir, "recovered.mp4", "blocker", "x.ts"), "junk");

    const report = await env.queue.recoverResidualTs({ execute: true });
    expect(report.deleted).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.items).toEqual([{ itemId: item.id, action: "failed" }]);
    expect(fs.existsSync(path.join(dir, "recovered.mp4"))).toBe(true);
  });

  it("archives a rescue whose item row was deleted, rebuilding the owner from the sidecar", async () => {
    const env = await harness();
    const rescued = env.item("orphan");
    writePlayableCapture(path.join(env.captureDir(rescued.id), "capture.ts"));
    await env.queue.recoverResidualTs({ execute: true });
    const dir = env.recoveryDir(rescued.id);
    fs.writeFileSync(path.join(dir, "recovered.json"), JSON.stringify({
      itemId: rescued.id, title: "Orphaned broadcast", performer: "Recovery Performer", source: "example.test",
      duration: 60, recoveredAt: "2026-09-21T23:11:11.076Z",
    }));

    // Deleting a queue entry removes its row outright, so the folder outlives its owner and the
    // archive action used to answer 404 for every click on an entry the page keeps listing.
    expect(env.db.deleteItem(rescued.id)).toBe(true);
    expect(env.db.getItem(rescued.id)).toBeUndefined();
    expect((await env.queue.listRecovered()).map((entry) => entry.itemId)).toEqual([rescued.id]);

    const result = await env.queue.catalogRecovered(rescued.id);
    expect(result.cataloged).toBe(true);
    const stored = path.join(env.mediaDir, result.storagePath!);
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.statSync(stored).size).toBeGreaterThan(0);
    expect(fs.existsSync(dir)).toBe(false);
    expect(await env.queue.listRecovered()).toEqual([]);

    // A fresh completed row owns the file, filed under the performer and source the sidecar named.
    const adopted = env.db.listItems().find((entry) => entry.externalId === `recovered:${rescued.id}`);
    expect(adopted?.status).toBe("completed");
    expect(env.db.getPerformer(adopted!.performerId)?.name).toBe("Recovery Performer");
    expect(path.dirname(stored).endsWith(path.join("Recovery Performer", "example.test"))).toBe(true);
    // The rebuild reuses the existing owner instead of duplicating it.
    expect(env.db.listPerformers().filter((entry) => entry.name === "Recovery Performer")).toHaveLength(1);
  });

  it("files a rescue with no sidecar at all under a neutral owner instead of refusing it", async () => {
    const env = await harness();
    const rescued = env.item("no-sidecar");
    writePlayableMp4(path.join(env.recoveryDir(rescued.id), "recovered.mp4"));
    env.db.deleteItem(rescued.id);

    // Nothing on disk names an owner. Footage the operator can see must still be archivable, so it
    // lands in the neutral bucket rather than an action that can never succeed.
    const result = await env.queue.catalogRecovered(rescued.id);
    expect(result.cataloged).toBe(true);
    const stored = path.join(env.mediaDir, result.storagePath!);
    expect(fs.existsSync(stored)).toBe(true);
    expect(path.dirname(stored).endsWith(path.join("Unsorted", "recovered"))).toBe(true);
    expect(env.db.listItems().find((entry) => entry.externalId === `recovered:${rescued.id}`)?.status).toBe("completed");
  });

  it("does not keep a rebuilt row when the rescue cannot be moved", async () => {
    const env = await harness();
    const rescued = env.item("adopt-fail");
    writePlayableMp4(path.join(env.recoveryDir(rescued.id), "recovered.mp4"));
    fs.writeFileSync(path.join(env.recoveryDir(rescued.id), "recovered.json"), JSON.stringify({ performer: "Recovery Performer", source: "example.test" }));
    env.db.deleteItem(rescued.id);
    // A plain file sitting where the destination folder has to be: the move cannot succeed.
    const blocked = path.join(env.mediaDir, "Recovery Performer");
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(path.join(blocked, "example.test"), "not a directory");

    await expect(env.queue.catalogRecovered(rescued.id)).rejects.toThrow();
    // The row exists only because this call created it, so a failed move must not leave a completed
    // library entry pointing at a file that never arrived; the footage stays where it can be seen.
    expect(env.db.listItems().some((entry) => entry.externalId === `recovered:${rescued.id}`)).toBe(false);
    expect(fs.existsSync(path.join(env.recoveryDir(rescued.id), "recovered.mp4"))).toBe(true);
  });

  it("runs the sweep as a background task whose progress climbs to its total", async () => {
    const env = await harness();
    const first = env.item("sweep-one"); const second = env.item("sweep-two");
    writePlayableCapture(path.join(env.captureDir(first.id), "capture.ts"));
    writePlayableCapture(path.join(env.captureDir(second.id), "capture.ts"));
    const registry = new TaskRegistry();

    const started = env.queue.startRecovery(registry);
    // The request answers with an id at once: the sweep has registered, not finished. That is the
    // whole point of the rewrite -- the Recovery page no longer holds an HTTP request open.
    expect(started.taskId).toBeTruthy();
    expect(started.reused).toBeUndefined();
    expect(["queued", "running"]).toContain(registry.get(started.taskId)!.status);

    const settled = await settle(registry, started.taskId);
    expect(settled.kind).toBe("recover");
    expect(settled.status).toBe("done");
    expect(settled.total).toBe(2);
    expect(settled.done).toBe(2);
    // A sweep reports per-item progress, so it ends measured: the Activity row can retire its bar.
    expect(settled.progress).toBe(1);
    // `detail` is only ever set by the item-level progress callback, so a folder name here proves the
    // sweep's per-item updates reached the record rather than only its summary.
    expect([first.id, second.id]).toContain(settled.detail);
    expect(settled.result).toMatchObject({ scanned: 2, rescued: 2, failed: 0, leftover: 0 });
    expect(fs.existsSync(path.join(env.recoveryDir(first.id), "recovered.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(env.recoveryDir(second.id), "recovered.mp4"))).toBe(true);
  });

  it("joins a sweep that is already running instead of starting a rival over the same folders", async () => {
    const env = await harness();
    const item = env.item("sweep-exclusive");
    writePlayableCapture(path.join(env.captureDir(item.id), "capture.ts"));
    const registry = new TaskRegistry();

    const first = env.queue.startRecovery(registry);
    const second = env.queue.startRecovery(registry);
    // The registry is checked and populated in a single tick, so a double click can only ever see the
    // first job. Two overlapping sweeps would remux the same bytes and race each other's cleanup.
    expect(second.taskId).toBe(first.taskId);
    expect(second.reused).toBe(true);
    expect(registry.list()).toHaveLength(1);

    await settle(registry, first.taskId);
    // Once the sweep is terminal a fresh run is allowed again.
    const third = env.queue.startRecovery(registry);
    expect(third.taskId).not.toBe(first.taskId);
    expect(third.reused).toBeUndefined();
    await settle(registry, third.taskId);
    expect(registry.list()).toHaveLength(2);
  });
});
