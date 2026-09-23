import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Catalog } from "./catalog.js";
import { Database } from "./database.js";
import { DownloadQueue } from "./downloader.js";
import { LibraryDatabase, type Media } from "./library-database.js";
import { resolveMergeSources, startMerge, type MergeDeps } from "./media-merge.js";
import { PluginManager } from "./plugin-manager.js";
import { probeSignature } from "./live-sessions.js";
import { TaskRegistry } from "./tasks.js";

const dirs: string[] = [];
// Windows keeps a temp tree locked for a moment after SQLite handles and spawned children go away,
// so rmSync can throw EPERM; an unclean temp directory must not fail a passing test.
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS temp cleaner gets it later */ }
  }
});
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };

// One tiny real MP4 per geometry (video+audio, encoded once) stand-in for a library video.
const templates = new Map<string, Buffer>();
function clipBytes(size = "64x64"): Buffer {
  const cached = templates.get(size);
  if (cached) return cached;
  const file = path.join(temp("easyx-merge-clip"), `${size}.mp4`);
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", `testsrc=duration=0.6:size=${size}:rate=10`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-shortest", "-movflags", "+faststart", file,
  ], { stdio: "ignore" });
  const bytes = fs.readFileSync(file);
  templates.set(size, bytes);
  return bytes;
}

const mediaId = (relativePath: string) => crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 24);
const FIRST_AT = Date.UTC(2026, 8, 20, 8, 0, 0);
const SECOND_AT = Date.UTC(2026, 8, 20, 9, 0, 0);

type Env = { root: string; dataDir: string; mediaDir: string; library: LibraryDatabase; catalog: Catalog; tasks: TaskRegistry };

function seed(): Env {
  const root = temp("easyx-media-merge");
  const dataDir = path.join(root, "data");
  const mediaDir = path.join(root, "media");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  const library = new LibraryDatabase(dataDir);
  const catalog = new Catalog(library, mediaDir, dataDir, false);
  return { root, dataDir, mediaDir, library, catalog, tasks: new TaskRegistry(() => Date.now(), 120_000) };
}

/** A library video row as the scan leaves it, with the file itself on disk. */
function addVideo(env: Env, relativePath: string, addedAt: number, size = "64x64", title?: string): Media {
  const absolute = path.join(env.mediaDir, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, clipBytes(size));
  const stat = fs.statSync(absolute);
  const stamp = new Date(addedAt).toISOString();
  env.library.upsertMedia({
    id: mediaId(relativePath), relativePath, kind: "video", title: title ?? path.basename(relativePath, path.extname(relativePath)),
    performer: "Alice", source: "chat.test", extension: path.extname(relativePath), mimeType: "video/mp4",
    size: stat.size, modifiedAt: stamp, addedAt: stamp, duration: 0, width: 0, height: 0,
    metadata: {}, scanId: "test-scan",
  });
  return env.library.getMedia(mediaId(relativePath))!;
}

function addImage(env: Env, relativePath: string): Media {
  const absolute = path.join(env.mediaDir, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, Buffer.from([0xff, 0xd8, 0xff, 0xdb]));
  const stamp = new Date(SECOND_AT).toISOString();
  env.library.upsertMedia({
    id: mediaId(relativePath), relativePath, kind: "image", title: "still", performer: "Alice", source: "chat.test",
    extension: ".jpg", mimeType: "image/jpeg", size: 4, modifiedAt: stamp, addedAt: stamp,
    duration: 0, width: 0, height: 0, metadata: {}, scanId: "test-scan",
  });
  return env.library.getMedia(mediaId(relativePath))!;
}

/** The real merge executor: the downloader's shared, load-gated post-process slot. */
async function mergeDeps(env: Env, overrides: Partial<MergeDeps> = {}) {
  let scanCalls = 0;
  const db = new Database(env.dataDir);
  const manager = new PluginManager(db, [temp("easyx-merge-plugins")]);
  await manager.load();
  const queue = new DownloadQueue(db, manager, env.mediaDir);
  const deps: MergeDeps = {
    mediaRoot: env.mediaDir,
    library: env.library,
    scan: () => { scanCalls += 1; return Promise.resolve({ indexed: 0 }); },
    tasks: env.tasks,
    concat: (listPath, output, totalSeconds, totalBytes, onProgress, signal) =>
      queue.mergeMediaFiles(listPath, output, totalSeconds, totalBytes, onProgress, signal),
    removeSource: (media) => env.catalog.deleteMedia(media),
    freeSpace: async () => undefined,
    ...overrides,
  };
  return { deps, scans: () => scanCalls };
}

async function settle(tasks: TaskRegistry, taskId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = tasks.get(taskId);
    if (task && task.status !== "queued" && task.status !== "running") return task;
    if (Date.now() > deadline) throw new Error(`task ${taskId} never settled`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("merge request validation", () => {
  it("refuses a selection that cannot become one file", () => {
    const env = seed();
    const one = addVideo(env, "alice/one.mp4", FIRST_AT);
    const two = addVideo(env, "alice/two.mp4", SECOND_AT);
    const deps = { mediaRoot: env.mediaDir, library: env.library };

    expect(() => resolveMergeSources(deps, [one.id])).toThrow(/at least two videos/);
    expect(() => resolveMergeSources(deps, [one.id, mediaId("alice/gone.mp4")])).toThrow(/no longer in the library/);
    // The row is in the library but the bytes are gone: caught before anything is queued.
    fs.rmSync(path.join(env.mediaDir, "alice/two.mp4"));
    expect(() => resolveMergeSources(deps, [one.id, two.id])).toThrow(/no longer on disk/);
  });

  it("orders by ingest time and drops images from a mixed selection", () => {
    const env = seed();
    const later = addVideo(env, "alice/late.mp4", SECOND_AT);
    const earlier = addVideo(env, "alice/early.mp4", FIRST_AT);
    const photo = addImage(env, "alice/still.jpg");

    const resolved = resolveMergeSources({ mediaRoot: env.mediaDir, library: env.library }, [later.id, photo.id, earlier.id]);
    expect(resolved.map((media) => media.relativePath)).toEqual(["alice/early.mp4", "alice/late.mp4"]);
    // A single image among videos is not an error -- it is simply not a video.
    expect(() => resolveMergeSources({ mediaRoot: env.mediaDir, library: env.library }, [photo.id, addImage(env, "alice/two.jpg").id])).toThrow(/at least two videos/);
  });
});

describe("startMerge", () => {
  it("joins the videos into the first source's folder and leaves the sources alone", async () => {
    const env = seed();
    const one = addVideo(env, "alice/one.mp4", FIRST_AT);
    const two = addVideo(env, "alice/two.mp4", SECOND_AT);
    const fractions: number[] = [];
    const { deps, scans } = await mergeDeps(env, {});
    const realConcat = deps.concat;
    deps.concat = (listPath, output, totalSeconds, totalBytes, onProgress, signal) =>
      realConcat(listPath, output, totalSeconds, totalBytes, (fraction) => { fractions.push(fraction); onProgress(fraction); }, signal);

    const { taskId } = startMerge(deps, { ids: [two.id, one.id] });
    // The job protects its inputs from the moment it exists, before any probing has happened.
    expect(env.tasks.activeSourceIds().sort()).toEqual([one.id, two.id].sort());
    const task = await settle(env.tasks, taskId);

    expect(task.status).toBe("done");
    expect(task.progress).toBe(1);
    expect(task.result).toMatchObject({ mergedPath: "alice/one_merged.mp4", targetName: "one_merged.mp4", sources: 2, removed: 0, removeFailed: 0 });
    expect(Number(task.result?.durationSeconds)).toBeGreaterThanOrEqual(1);
    expect(scans()).toBe(1);

    const merged = path.join(env.mediaDir, "alice", "one_merged.mp4");
    expect(fs.existsSync(merged)).toBe(true);
    const measured = await probeSignature(merged);
    expect(measured?.duration).toBeGreaterThan(1.0);
    // It inherits the first source's media date, which is what the library sorts a recording by.
    expect(fs.statSync(merged).mtimeMs).toBe(FIRST_AT);
    // The concat list is scratch and is always removed; the sources are untouched without the flag.
    expect(fs.existsSync(`${merged}.concat.txt`)).toBe(false);
    expect(fs.existsSync(path.join(env.mediaDir, "alice", "one.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(env.mediaDir, "alice", "two.mp4"))).toBe(true);
    expect(env.library.getMedia(one.id)).toBeDefined();

    // ffmpeg's own `-progress` timeline reached us: at least one real fraction, ending near the end.
    const reported = fractions.filter((value) => value >= 0);
    expect(reported.length).toBeGreaterThan(0);
    expect(Math.max(...reported)).toBeGreaterThan(0.5);
    expect(env.tasks.activeSourceIds()).toEqual([]);
  });

  it("refuses videos that do not share one stream layout and leaves no partial file", async () => {
    const env = seed();
    const one = addVideo(env, "alice/one.mp4", FIRST_AT);
    const wide = addVideo(env, "alice/wide.mp4", SECOND_AT, "96x96");
    const { deps } = await mergeDeps(env);

    const task = await settle(env.tasks, startMerge(deps, { ids: [one.id, wide.id] }).taskId);
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(/stream layout/);
    expect(fs.readdirSync(path.join(env.mediaDir, "alice")).sort()).toEqual(["one.mp4", "wide.mp4"]);
    expect(env.library.getMedia(one.id)).toBeDefined();
    expect(env.library.getMedia(wide.id)).toBeDefined();
  });

  it("declines to start when the merge would eat the free-space floor", async () => {
    const env = seed();
    const one = addVideo(env, "alice/one.mp4", FIRST_AT);
    const two = addVideo(env, "alice/two.mp4", SECOND_AT);
    const { deps } = await mergeDeps(env, { freeSpace: async () => 1 });

    const task = await settle(env.tasks, startMerge(deps, { ids: [one.id, two.id] }).taskId);
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(/free/);
    expect(fs.readdirSync(path.join(env.mediaDir, "alice")).sort()).toEqual(["one.mp4", "two.mp4"]);
  });

  it("removes the sources only after the merged copy exists, and reports the ones it could not", async () => {
    const env = seed();
    const one = addVideo(env, "alice/one.mp4", FIRST_AT);
    const two = addVideo(env, "alice/two.mp4", SECOND_AT);
    const { deps } = await mergeDeps(env, {
      removeSource: (media) => {
        if (media.relativePath.endsWith("two.mp4")) throw new Error("the mount is read-only");
        return env.catalog.deleteMedia(media);
      },
    });

    const task = await settle(env.tasks, startMerge(deps, { ids: [one.id, two.id], removeSources: true }).taskId);
    expect(task).toMatchObject({ status: "done" });
    expect(task.result).toMatchObject({ removed: 1, removeFailed: 1 });

    // The one that went is a tombstone: the row stays (by design) but leaves the visible library.
    expect(fs.existsSync(path.join(env.mediaDir, "alice", "one.mp4"))).toBe(false);
    expect(env.library.getMedia(one.id)).toBeUndefined();
    // The one that would not go is untouched, and the merged copy holds everything either way.
    expect(fs.existsSync(path.join(env.mediaDir, "alice", "two.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(env.mediaDir, "alice", "one_merged.mp4"))).toBe(true);
  });

  it("stops a cancelled merge and cleans up its partial output", async () => {
    const env = seed();
    const one = addVideo(env, "alice/one.mp4", FIRST_AT);
    const two = addVideo(env, "alice/two.mp4", SECOND_AT);
    const { deps } = await mergeDeps(env, {
      // Stands in for a long concat: it only settles once the job is cancelled, which is what the
      // real executor does when it SIGKILLs ffmpeg.
      concat: (_listPath, _output, _seconds, _bytes, _onProgress, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Merge cancelled")), { once: true });
      }),
    });

    const merged = path.join(env.mediaDir, "alice", "one_merged.mp4");
    const { taskId } = startMerge(deps, { ids: [one.id, two.id] });
    env.tasks.cancel(taskId);
    expect(env.tasks.get(taskId)?.status).toBe("cancelled");
    await waitFor(() => !fs.existsSync(merged) && !fs.existsSync(`${merged}.concat.txt`));

    expect(fs.readdirSync(path.join(env.mediaDir, "alice")).sort()).toEqual(["one.mp4", "two.mp4"]);
    expect(env.tasks.get(taskId)?.status).toBe("cancelled");
  });

  it("carries the first source's title into a sidecar so the product keeps the original name", async () => {
    const env = seed();
    // The original's title comes from the download job, not the filename -- e.g. a live room name.
    const one = addVideo(env, "alice/one.mp4", FIRST_AT, "64x64", "Welcome to Squirt Fireworks festival");
    const two = addVideo(env, "alice/two.mp4", SECOND_AT, "64x64", "Second Clip");
    const { deps } = await mergeDeps(env);

    const { taskId } = startMerge(deps, { ids: [two.id, one.id] });
    await settle(env.tasks, taskId);

    const merged = path.join(env.mediaDir, "alice", "one_merged.mp4");
    const sidecar = merged.replace(/\.[^.]+$/, ".info.json");
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidecar, "utf8")).title).toBe("Welcome to Squirt Fireworks festival");

    // The sidecar is what the scan reads: the product is titled like the original, not "alice one merged".
    await env.catalog.scan();
    const mergedMedia = env.library.getMedia(mediaId("alice/one_merged.mp4"));
    expect(mergedMedia?.title).toBe("Welcome to Squirt Fireworks festival");
  });
});
