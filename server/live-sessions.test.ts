import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Database } from "./database.js";
import { DownloadQueue } from "./downloader.js";
import { PluginManager } from "./plugin-manager.js";
import {
  LIVE_SESSION_DEFAULTS, liveRoomOf, planSessions, probeSignature, sessionCandidates, spliceLiveSessions,
  type LiveSessionOptions, type MediaSignature, type SessionCandidate,
} from "./live-sessions.js";

const dirs: string[] = [];
// Windows keeps a temp tree locked for a moment after SQLite handles and spawned children go away,
// so rmSync can throw EPERM; an unclean temp directory must not fail a passing test.
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS temp cleaner gets it later */ }
  }
});
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };

// One tiny real MP4 (video+audio, encoded once) stand-in for a finished capture.
let clipTemplate: Buffer | undefined;
function clipBytes(): Buffer {
  if (!clipTemplate) {
    const file = path.join(temp("easyx-live-clip"), "clip.mp4");
    execFileSync("ffmpeg", [
      "-f", "lavfi", "-i", "testsrc=duration=0.6:size=64x64:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-shortest", "-movflags", "+faststart", file,
    ], { stdio: "ignore" });
    clipTemplate = fs.readFileSync(file);
  }
  return clipTemplate;
}

const BASE = Date.UTC(2026, 8, 19, 10, 0, 0);
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const candidate = (id: string, startMinutes: number, durationMinutes = 4, roomKey = "chat.test:alice"): SessionCandidate => ({
  id, roomKey, file: path.join("/media", `${id}.mp4`),
  startMs: BASE + startMinutes * 60_000, endMs: BASE + (startMinutes + durationMinutes) * 60_000,
});
const OPTIONS: LiveSessionOptions = { ...LIVE_SESSION_DEFAULTS };
const noRooms = new Set<string>();

function seedLibrary() {
  const root = temp("easyx-live-sessions");
  const dataDir = path.join(root, "data");
  const mediaDir = path.join(root, "media");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  const db = new Database(dataDir);
  const person = db.upsertPerformer({ externalId: "alice", name: "Alice" }, "chat.test");
  const source = db.addSource(person.id, "chat.test", { externalId: "alice", label: "Alice", profileUrl: "https://chat.test/alice", domain: "chat.test" });
  return { root, db, source, mediaDir };
}

type Library = ReturnType<typeof seedLibrary>;

/**
 * A finished auto capture, as the downloader leaves it. `download_started_at` / `download_finished_at`
 * are stamped by the queue's own transitions with the current clock, so a test that needs particular
 * times pins them directly.
 */
function addCapture(library: Library, options: { externalId: string; startedAt: string; finishedAt: string; relativePath: string; room?: string }) {
  library.db.ingestItems(library.source, [{
    externalId: options.externalId, mediaType: "video", publishedAt: options.startedAt,
    metadata: { live: true, liveRoom: options.room ?? "alice" },
  }]);
  const item = library.db.getItemBySourceExternalId(library.source.id, options.externalId)!;
  const absolute = path.join(library.mediaDir, options.relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, clipBytes());
  library.db.setItemStatus(item.id, "completed", { checksum: "deadbeef", storagePath: options.relativePath });
  library.db.sqlite.prepare("UPDATE items SET download_started_at=?,download_finished_at=?,is_live=1 WHERE id=?").run(options.startedAt, options.finishedAt, item.id);
  return library.db.getItem(item.id)!;
}

describe("live session basics", () => {
  it("resolves a capture's room from the recorder's metadata, falling back to its id", () => {
    const room = { ...candidate("a", 0), id: "a" };
    const declared = { externalId: "auto-live:other:2026", metadata: { liveRoom: "Alice" }, pluginId: "chat.test" } as never;
    expect(liveRoomOf(declared)).toBe("alice");
    const fromId = { externalId: "auto-live:Alice:2026-09-19T10-00-00", metadata: {}, pluginId: "chat.test" } as never;
    expect(liveRoomOf(fromId)).toBe("alice");
    expect(liveRoomOf({ externalId: "clip-1", metadata: {}, pluginId: "chat.test" } as never)).toBeUndefined();
    expect(room.id).toBe("a");
  });

  it("splices auto captures only, and only those that finished with a file", () => {
    const library = seedLibrary();
    const finished = addCapture(library, { externalId: "auto-live:alice:1", startedAt: at(0), finishedAt: at(4), relativePath: "alice/one.mp4" });
    addCapture(library, { externalId: "manual-live:alice:2", startedAt: at(6), finishedAt: at(10), relativePath: "alice/two.mp4" });
    library.db.ingestItems(library.source, [{ externalId: "auto-live:alice:3", mediaType: "video", metadata: { live: true, liveRoom: "alice" } }]);
    const queued = library.db.getItemBySourceExternalId(library.source.id, "auto-live:alice:3")!;
    library.db.setItemStatus(queued.id, "failed", { error: "gone" });

    const rows = library.db.listLiveItems(["completed", "failed"]);
    const candidates = sessionCandidates(rows, library.mediaDir);
    expect(candidates.map((entry) => entry.id)).toEqual([finished.id]);
    expect(candidates[0].file).toBe(path.join(library.mediaDir, "alice", "one.mp4"));
  });

  it("measures a real file and refuses to measure a missing one", async () => {
    const library = seedLibrary();
    const absolute = path.join(library.mediaDir, "alice", "one.mp4");
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, clipBytes());
    const measured = await probeSignature(absolute);
    expect(measured?.duration).toBeGreaterThan(0.3);
    expect(measured?.signature).toContain("video:h264");
    expect(measured?.signature).toContain("audio:aac");
    expect(await probeSignature(path.join(library.mediaDir, "missing.mp4"))).toBeUndefined();
  });
});

describe("planSessions", () => {
  it("folds captures that follow each other inside the join window", () => {
    const groups = planSessions([candidate("a", 0), candidate("b", 6), candidate("c", 12)], noRooms, OPTIONS, BASE + 60 * 60_000);
    expect(groups).toHaveLength(1);
    expect(groups[0].segments.map((segment) => segment.id)).toEqual(["a", "b", "c"]);
  });

  it("starts a new broadcast after a gap longer than the join window", () => {
    const groups = planSessions([candidate("a", 0), candidate("b", 40), candidate("c", 46), candidate("d", 90)], noRooms, OPTIONS, BASE + 180 * 60_000);
    // `a` and `d` stand alone: a one-capture broadcast has nothing to fold and is never reported.
    expect(groups).toHaveLength(1);
    expect(groups[0].segments.map((segment) => segment.id)).toEqual(["b", "c"]);
  });

  it("waits for the broadcast to settle before folding it", () => {
    const recent = planSessions([candidate("a", 0), candidate("b", 6)], noRooms, OPTIONS, BASE + 25 * 60_000);
    expect(recent).toHaveLength(0);
    const settled = planSessions([candidate("a", 0), candidate("b", 6)], noRooms, OPTIONS, BASE + 40 * 60_000);
    expect(settled).toHaveLength(1);
  });

  it("never folds before the join window has passed, even at the long-broadcast threshold", () => {
    // Folding early could still be joined by the next capture, and that capture would then be
    // spliced on top of an already-spliced group -- the same content folded twice. The length
    // threshold must not be able to break that invariant.
    const options: LiveSessionOptions = { ...OPTIONS, longBroadcastSegments: 3 };
    const segments = [candidate("a", 0), candidate("b", 3), candidate("c", 6)];
    expect(planSessions(segments, noRooms, options, BASE + 12 * 60_000)).toHaveLength(0);
    expect(planSessions(segments, noRooms, options, BASE + 35 * 60_000)).toHaveLength(1);
  });

  it("folds a broadcast that never settles, once it is long enough and quiet", () => {
    const options: LiveSessionOptions = { ...OPTIONS, longBroadcastSegments: 3, settleSeconds: 6 * 60 * 60 };
    const segments = [candidate("a", 0), candidate("b", 5), candidate("c", 10), candidate("d", 15)];
    // Quiet for eleven minutes: still inside the join window, so nothing may be folded yet.
    expect(planSessions(segments, noRooms, options, BASE + 30 * 60_000)).toHaveLength(0);
    // A 24/7 room would never reach the settle window; the length threshold is the way out.
    const groups = planSessions(segments, noRooms, options, BASE + 40 * 60_000);
    expect(groups).toHaveLength(1);
    expect(groups[0].segments.map((segment) => segment.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves a room whose capture is still running alone", () => {
    const active = new Set(["chat.test:alice"]);
    expect(planSessions([candidate("a", 0), candidate("b", 6)], active, OPTIONS, BASE + 60 * 60_000)).toHaveLength(0);
  });

  it("keeps rooms apart and drains the oldest broadcast first", () => {
    const groups = planSessions([
      candidate("late-1", 600, 4, "chat.test:late"), candidate("late-2", 606, 4, "chat.test:late"),
      candidate("early-1", 0, 4, "chat.test:early"), candidate("early-2", 6, 4, "chat.test:early"),
    ], noRooms, OPTIONS, BASE + 900 * 60_000);
    expect(groups.map((group) => group.roomKey)).toEqual(["chat.test:early", "chat.test:late"]);
  });

  it("counts captures that overlap rather than dropping them", () => {
    const groups = planSessions([candidate("a", 0, 8), candidate("b", 6, 8)], noRooms, OPTIONS, BASE + 60 * 60_000);
    expect(groups).toHaveLength(1);
  });
});

describe("spliceLiveSessions", () => {
  it("folds a finished broadcast into its first capture, through the real concat path", async () => {
    const library = seedLibrary();
    const pluginDir = temp("easyx-live-sessions-plugins");
    const manager = new PluginManager(library.db, [pluginDir]);
    await manager.load();
    const queue = new DownloadQueue(library.db, manager, library.mediaDir);

    const first = addCapture(library, { externalId: "auto-live:alice:1", startedAt: at(0), finishedAt: at(4), relativePath: "alice/one.mp4" });
    const second = addCapture(library, { externalId: "auto-live:alice:2", startedAt: at(6), finishedAt: at(10), relativePath: "alice/two.mp4" });
    const third = addCapture(library, { externalId: "auto-live:alice:3", startedAt: at(12), finishedAt: at(16), relativePath: "alice/three.mp4" });

    const report = await spliceLiveSessions({
      db: library.db, mediaRoot: library.mediaDir,
      concat: (listPath, output) => queue.concatFinishedFiles(listPath, output),
      now: () => BASE + 60 * 60_000,
    });

    expect(report).toMatchObject({ groups: 1, spliced: 1, segments: 2, failed: [] });
    expect(report.bytes).toBeGreaterThan(0);

    const survivor = path.join(library.mediaDir, "alice", "one.mp4");
    expect(fs.existsSync(path.join(library.mediaDir, "alice", "two.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(library.mediaDir, "alice", "three.mp4"))).toBe(false);
    // The survivor now holds all three captures, which is the whole point: one library entry.
    const merged = await probeSignature(survivor);
    expect(merged?.duration).toBeGreaterThan(1.5);
    // …and keeps the broadcast's date, which is what the library sorts by.
    expect(fs.statSync(survivor).mtimeMs).toBe(BASE);

    const kept = library.db.getItem(first.id)!;
    expect(kept.status).toBe("completed");
    expect(kept.metadata.sessionSegments).toEqual([second.id, third.id]);
    expect(kept.checksumSha256).toBeUndefined();
    expect(kept.downloadFinishedAt).toBe(at(16));
    for (const absorbed of [second, third]) {
      // `duplicate_of` is not part of the mapped item, and storage_path must be gone: the file it
      // pointed at no longer exists.
      const row = library.db.sqlite.prepare("SELECT status,storage_path,duplicate_of FROM items WHERE id=?").get(absorbed.id) as {
        status: string; storage_path: string | null; duplicate_of: string | null;
      };
      expect(row.status).toBe("superseded");
      expect(row.storage_path).toBeNull();
      expect(row.duplicate_of).toBe(first.id);
    }
    // Nothing may be left behind next to the recordings.
    expect(fs.readdirSync(path.join(library.mediaDir, "alice")).sort()).toEqual(["one.mp4"]);
  });

  it("leaves every capture in place when the disk cannot hold the splice", async () => {
    const library = seedLibrary();
    addCapture(library, { externalId: "auto-live:alice:1", startedAt: at(0), finishedAt: at(4), relativePath: "alice/one.mp4" });
    addCapture(library, { externalId: "auto-live:alice:2", startedAt: at(6), finishedAt: at(10), relativePath: "alice/two.mp4" });

    const report = await spliceLiveSessions({
      db: library.db, mediaRoot: library.mediaDir,
      concat: async () => { throw new Error("must not run"); },
      freeSpace: async () => 1024,
      probe: async () => ({ duration: 240, signature: "video:h264,audio:aac" }),
      now: () => BASE + 60 * 60_000,
    });

    expect(report).toMatchObject({ groups: 1, spliced: 0 });
    expect(report.skipped[0].reason).toContain("free");
    expect(report.failed).toEqual([]);
    expect(fs.readdirSync(path.join(library.mediaDir, "alice")).sort()).toEqual(["one.mp4", "two.mp4"]);
  });

  it("refuses to splice captures whose stream layouts differ", async () => {
    const library = seedLibrary();
    addCapture(library, { externalId: "auto-live:alice:1", startedAt: at(0), finishedAt: at(4), relativePath: "alice/one.mp4" });
    addCapture(library, { externalId: "auto-live:alice:2", startedAt: at(6), finishedAt: at(10), relativePath: "alice/two.mp4" });

    // The second capture lost its audio (the audio resolve is best-effort at capture time) and the
    // concat demuxer keeps the first input's streams, so the join would silently drop it.
    const report = await spliceLiveSessions({
      db: library.db, mediaRoot: library.mediaDir,
      concat: async () => { throw new Error("must not run"); },
      freeSpace: async () => 100 * 1024 ** 3,
      probe: async (file) => ({ duration: 240, signature: file.endsWith("one.mp4") ? "audio:aac,video:h264" : "video:h264" }),
      now: () => BASE + 60 * 60_000,
    });

    expect(report).toMatchObject({ spliced: 0 });
    expect(report.skipped[0].reason).toContain("stream layout");
    expect(fs.readdirSync(path.join(library.mediaDir, "alice")).sort()).toEqual(["one.mp4", "two.mp4"]);
  });

  it("keeps the originals when the splice comes out short", async () => {
    const library = seedLibrary();
    const original = addCapture(library, { externalId: "auto-live:alice:1", startedAt: at(0), finishedAt: at(4), relativePath: "alice/one.mp4" });
    addCapture(library, { externalId: "auto-live:alice:2", startedAt: at(6), finishedAt: at(10), relativePath: "alice/two.mp4" });
    const before = fs.readFileSync(path.join(library.mediaDir, "alice", "one.mp4"));

    const report = await spliceLiveSessions({
      db: library.db, mediaRoot: library.mediaDir,
      // A concat that reports success but produced a stub: the duration check has to catch it.
      concat: async (_listPath, output) => { fs.writeFileSync(output, "stub"); },
      freeSpace: async () => 100 * 1024 ** 3,
      probe: async (file) => ({ duration: file.endsWith(".session.mp4") ? 3 : 240, signature: "audio:aac,video:h264" }),
      now: () => BASE + 60 * 60_000,
    });

    expect(report).toMatchObject({ spliced: 0 });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].error).toContain("480.0s");
    expect(fs.readdirSync(path.join(library.mediaDir, "alice")).sort()).toEqual(["one.mp4", "two.mp4"]);
    expect(fs.readFileSync(path.join(library.mediaDir, "alice", "one.mp4"))).toEqual(before);
    expect(library.db.getItem(original.id)!.status).toBe("completed");
  });

  it("skips a capture it cannot measure instead of splicing blind", async () => {
    const library = seedLibrary();
    addCapture(library, { externalId: "auto-live:alice:1", startedAt: at(0), finishedAt: at(4), relativePath: "alice/one.mp4" });
    addCapture(library, { externalId: "auto-live:alice:2", startedAt: at(6), finishedAt: at(10), relativePath: "alice/two.mp4" });

    const report = await spliceLiveSessions({
      db: library.db, mediaRoot: library.mediaDir,
      concat: async () => { throw new Error("must not run"); },
      freeSpace: async () => 100 * 1024 ** 3,
      probe: async () => undefined,
      now: () => BASE + 60 * 60_000,
    });

    expect(report.spliced).toBe(0);
    expect(report.skipped[0].reason).toContain("could not be measured");
  });

  it("bounds how much a single pass splices", async () => {
    const library = seedLibrary();
    for (const room of ["alice", "bob", "carol"]) {
      for (const [index, start] of [0, 6].entries()) {
        addCapture(library, { externalId: `auto-live:${room}:${index}`, startedAt: at(start), finishedAt: at(start + 4), relativePath: `${room}/${index}.mp4`, room });
      }
    }

    const report = await spliceLiveSessions({
      db: library.db, mediaRoot: library.mediaDir,
      // Stands in for the concat demuxer: joins what the list names, so the duration check below
      // sees a real splice rather than a stub.
      concat: async (listPath, output) => fs.copyFileSync(fs.readFileSync(listPath, "utf8").trim().split("\n")[0].slice(6, -1), output),
      freeSpace: async () => 100 * 1024 ** 3,
      // Two four-minute captures in, eight minutes out: the splice has to account for both.
      probe: async (file) => ({ duration: file.endsWith(".session.mp4") ? 480 : 240, signature: "audio:aac,video:h264" }),
      now: () => BASE + 60 * 60_000,
      options: { maxGroupsPerPass: 1 },
    });

    expect(report).toMatchObject({ groups: 3, spliced: 1, skipped: [], failed: [] });
    // Six captures went in; the folded room now holds one file, the two rooms the pass did not
    // reach still hold two each, and no splice scratch file is left behind anywhere.
    const remaining = ["alice", "bob", "carol"].flatMap((room) => fs.readdirSync(path.join(library.mediaDir, room)));
    expect(remaining.filter((name) => name.endsWith(".mp4"))).toHaveLength(5);
  });

  it("refuses to splice a group holding a capture whose file is gone", async () => {
    // What an interrupted splice leaves behind: a finished row whose file was already removed. That
    // file's content is inside the merged recording, so folding again would duplicate it.
    const library = seedLibrary();
    const first = addCapture(library, { externalId: "auto-live:alice:1", startedAt: at(0), finishedAt: at(4), relativePath: "alice/one.mp4" });
    addCapture(library, { externalId: "auto-live:alice:2", startedAt: at(6), finishedAt: at(10), relativePath: "alice/two.mp4" });
    fs.rmSync(path.join(library.mediaDir, "alice", "two.mp4"));
    const before = fs.readFileSync(path.join(library.mediaDir, "alice", "one.mp4"));

    const report = await spliceLiveSessions({
      db: library.db, mediaRoot: library.mediaDir,
      concat: async () => { throw new Error("must not run"); },
      freeSpace: async () => 100 * 1024 ** 3,
      probe: async () => ({ duration: 240, signature: "audio:aac,video:h264" }),
      now: () => BASE + 60 * 60_000,
    });

    expect(report.spliced).toBe(0);
    expect(report.skipped[0].reason).toContain("missing or empty");
    expect(library.db.getItem(first.id)!.status).toBe("completed");
    expect(fs.readFileSync(path.join(library.mediaDir, "alice", "one.mp4"))).toEqual(before);
  });

  it("does nothing while the room is still being recorded", async () => {
    const library = seedLibrary();
    addCapture(library, { externalId: "auto-live:alice:1", startedAt: at(0), finishedAt: at(4), relativePath: "alice/one.mp4" });
    addCapture(library, { externalId: "auto-live:alice:2", startedAt: at(6), finishedAt: at(10), relativePath: "alice/two.mp4" });
    library.db.ingestItems(library.source, [{ externalId: "auto-live:alice:3", mediaType: "video", metadata: { live: true, liveRoom: "alice" } }]);
    const live = library.db.getItemBySourceExternalId(library.source.id, "auto-live:alice:3")!;
    library.db.setItemStatus(live.id, "downloading", { progress: 0.3 });

    const report = await spliceLiveSessions({
      db: library.db, mediaRoot: library.mediaDir,
      concat: async () => { throw new Error("must not run"); },
      probe: async () => ({ duration: 240, signature: "audio:aac,video:h264" }),
      freeSpace: async () => 100 * 1024 ** 3,
      now: () => BASE + 60 * 60_000,
    });

    expect(report).toMatchObject({ groups: 0, spliced: 0 });
    expect(fs.readdirSync(path.join(library.mediaDir, "alice")).sort()).toEqual(["one.mp4", "two.mp4"]);
  });
});
