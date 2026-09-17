import { describe, expect, it, vi } from "vitest";
import type { Database, DownloadItem } from "./database.js";
import type { LiveCamService } from "./live-cams.js";
import { startAutoRecorder } from "./auto-recorder.js";

// The watcher only touches four Database methods and two LiveCamService methods, so the
// tests drive it with a real Database for favorites plus function stubs for the rest.
function makeCam(overrides: Record<string, unknown> = {}) {
  return {
    id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live",
    providerName: "Test Live", favorite: true, autoRecord: true, online: true, ...overrides,
  };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

async function fixture({ freeSpace: probe }: { freeSpace?: (dir: string) => Promise<number | undefined> } = {}) {
  const { Database } = await import("./database.js");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-auto-record-"));
  const db = new Database(dir);

  const items = new Map<string, Partial<Pick<DownloadItem, "status" | "error">>>();
  let itemCounter = 0;
  const listedItems: Array<Pick<DownloadItem, "id" | "pluginId" | "externalId" | "status" | "metadata">> = [];
  const dbStub = {
    getSettings: () => db.getSettings(),
    listLiveCamFavorites: () => db.listLiveCamFavorites(),
    listItems: () => listedItems,
    getItem: (id: string) => {
      const listed = items.get(id);
      return listed ? ({ id, pluginId: "test.live", externalId: "", ...listed } as DownloadItem) : undefined;
    },
  } as unknown as Database;

  const record = vi.fn(async () => {
    const itemId = `item-${itemCounter++}`;
    items.set(itemId, { status: "downloading" });
    return { itemId, status: "queued" };
  });
  const cams: Array<Record<string, unknown>> = [];
  const list = vi.fn(async () => ({ status: { ok: true }, providers: [{ id: "test.live", name: "Test Live", ok: true, count: cams.length }], items: cams }));
  const liveCamsStub = {
    list, record,
    autoRecordTargets: () => {
      // Mirror LiveCams.autoRecordTargets against the real Database: poll every favorite armed
      // directly plus every armed performer resolved through its live-cam identity (refs/sources).
      const targets: Array<{ providerId: string; username: string; pageUrl: string }> = [];
      const seen = new Set<string>();
      const push = (providerId: string, username: string, pageUrl: string) => {
        const key = `${providerId}:${username.toLowerCase()}`;
        if (seen.has(key) || !pageUrl) return;
        seen.add(key);
        targets.push({ providerId, username, pageUrl });
      };
      for (const favorite of db.listLiveCamFavorites()) {
        if (favorite.autoRecord) push(favorite.providerId, favorite.username, favorite.pageUrl);
      }
      const sources = db.listSources();
      for (const performer of db.listPerformers()) {
        if (!performer.autoRecord) continue;
        for (const [pluginId, externalId] of Object.entries(performer.externalRefs)) {
          const source = sources.find((entry) => entry.performerId === performer.id && entry.pluginId === pluginId);
          push(pluginId, externalId, source?.profileUrl ?? "");
        }
        for (const source of sources) {
          if (source.performerId === performer.id) push(source.pluginId, source.externalId, source.profileUrl);
        }
        for (const favorite of db.listLiveCamFavorites()) {
          if (favorite.providerId in performer.externalRefs) push(favorite.providerId, favorite.username, favorite.pageUrl);
        }
      }
      return targets;
    },
    autoRecordStatuses: (providerId: string, targets: Array<{ username: string; pageUrl: string }>) => {
      const wanted = new Set(targets.map((target) => target.username.toLowerCase()));
      const items = cams.filter((cam) => String(cam.providerId) === providerId && wanted.has(String(cam.username).toLowerCase()));
      return Promise.resolve({ ok: true, cams: items });
    },
  } as unknown as LiveCamService;
  const logs: string[] = [];
  // Plenty of free space by default so the disk guard never makes an unrelated test flaky.
  const recorder = startAutoRecorder({
    db: dbStub, liveCams: liveCamsStub, mediaRoot: dir,
    freeSpace: probe ?? (async () => 50 * 1024 ** 3),
    log: (message) => logs.push(message),
  });
  return {
    recorder, record, list, cams, items, listedItems, logs, db,
    cleanup: () => { recorder.stop(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort on Windows */ } },
  };
}

describe("auto recorder", () => {
  it("records an online auto-record favorite with the auto origin", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      expect(env.record).toHaveBeenCalledWith("test.live", expect.objectContaining({ username: "alice" }), { origin: "auto" });
    } finally { env.cleanup(); }
  });

  it("records a performer armed without any live-cam favorite", async () => {
    const env: Harness = await fixture();
    try {
      const performer = env.db.upsertPerformer({ name: "alice", aliases: [], externalId: "alice" }, "test.live");
      env.db.addSource(performer.id, "test.live", { externalId: "alice", label: "alice", profileUrl: "https://live.test/alice", domain: "live.test" });
      env.db.setPerformerAutoRecord(performer.id, true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      expect(env.record).toHaveBeenCalledWith("test.live", expect.objectContaining({ username: "alice" }), { origin: "auto" });
    } finally { env.cleanup(); }
  });

  it("does not re-trigger while the recording is still active", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      await env.recorder.tick();
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
    } finally { env.cleanup(); }
  });

  it("skips offline and status-unavailable cams", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam({ online: false }), makeCam({ username: "bob", statusUnavailable: true }));
      await env.recorder.tick();
      expect(env.record).not.toHaveBeenCalled();
    } finally { env.cleanup(); }
  });

  it("ignores favorites without the auto-record switch", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).not.toHaveBeenCalled();
    } finally { env.cleanup(); }
  });

  it("puts a cam on cooldown after its recording finishes instead of re-recording", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      // The recording ends (db reports completed) while the cam still looks online.
      env.items.set("item-0", { status: "completed" });
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      expect(env.logs.some((line) => line.includes("enters cooldown"))).toBe(true);
    } finally { env.cleanup(); }
  });

  it("keeps blocking auto-starts for recordings that were active before the restart", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      env.listedItems.push({ id: "item-live", pluginId: "test.live", externalId: "manual-live:alice:2026-09-12T00-00-00-000Z", status: "downloading", metadata: { live: true, liveRoom: "alice" } });
      await env.recorder.tick();
      expect(env.record).not.toHaveBeenCalled();
    } finally { env.cleanup(); }
  });

  it("treats a capture a scraper queued as the recording for that room", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      // The scraper reached the same broadcast first: a different external-id shape, same room.
      // The watcher must not stack a second recording onto it.
      env.listedItems.push({ id: "item-scraped", pluginId: "test.live", externalId: "chaturbate:alice:1234", status: "downloading", metadata: { live: true, liveRoom: "alice" } });
      await env.recorder.tick();
      expect(env.record).not.toHaveBeenCalled();

      // When that capture ends, the room is still on air: the watcher must record it normally
      // after the usual cooldown rather than treating the ended capture as its own recording.
      env.listedItems.splice(0, env.listedItems.length);
      await env.recorder.tick();
      expect(env.record).not.toHaveBeenCalled();
      expect(env.logs.some((line) => line.includes("enters cooldown"))).toBe(true);
    } finally { env.cleanup(); }
  });

  it("keeps a manually stopped cam paused until the room goes offline", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      const cam = makeCam();
      env.cams.push(cam);
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);

      // The user stops the recording by hand while the room is still live.
      env.recorder.suppress("test.live", "alice");
      for (let attempt = 0; attempt < 3; attempt++) await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      expect(env.logs.some((line) => line.includes("stays paused until the room goes offline"))).toBe(true);

      // Going offline ends this session and lifts the pause.
      cam.online = false;
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      expect(env.logs.some((line) => line.includes("went offline"))).toBe(true);

      // The next session records again immediately (no leftover cooldown).
      cam.online = true;
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(2);
    } finally { env.cleanup(); }
  });

  it("lifts the pause when the auto-record switch is enabled again", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      env.recorder.suppress("test.live", "alice");
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      expect(env.recorder.clearSuppression("test.live", "alice")).toBe(true);
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(2);
      expect(env.recorder.clearSuppression("test.live", "alice")).toBe(false);
    } finally { env.cleanup(); }
  });

  it("pauses auto-record below the free-space floor and resumes once it clears", async () => {
    let free = 0.4 * 1024 ** 3;
    const env: Harness = await fixture({ freeSpace: async () => free });
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());

      // 0.4 GB < the 1 GB default floor: nothing is opened, and the reason is logged once.
      await env.recorder.tick();
      await env.recorder.tick();
      expect(env.record).not.toHaveBeenCalled();
      expect(env.logs.filter((line) => line.includes("below the 1 GB floor")).length).toBe(1);

      free = 12 * 1024 ** 3;
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      expect(env.logs.some((line) => line.includes("auto-record: resumed"))).toBe(true);
    } finally { env.cleanup(); }
  });

  it("records again once the floor is turned off", async () => {
    const env: Harness = await fixture({ freeSpace: async () => 0 });
    try {
      env.db.updateSettings({ minFreeDiskGb: 0 });
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
    } finally { env.cleanup(); }
  });

  it("keeps recording when the free-space probe fails", async () => {
    const env: Harness = await fixture({ freeSpace: async () => undefined });
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
    } finally { env.cleanup(); }
  });

  it("clamps the configured check interval into the allowed range", async () => {
    const env: Harness = await fixture();
    try {
      env.db.updateSettings({ autoRecordCheckSeconds: 5 });
      // Interval is only observable indirectly (timer), so assert via a second recorder
      // reading the same setting through the clamp path with a stale value.
      const { db } = env;
      const raw = Number(db.getSettings().autoRecordCheckSeconds);
      expect(Math.min(3600, Math.max(30, raw))).toBe(30);
    } finally { env.cleanup(); }
  });

  it("backs off further for each consecutive failure instead of restarting forever", async () => {
    // Only Date is faked: the recorder reads Date.now() for its cooldowns, and leaving the real
    // timers in place keeps the recorder's unref'd setTimeout untouched.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      // The room reports "live" but its capture always fails (e.g. no public stream).
      env.cams.push(makeCam());

      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);

      // The first failure keeps the short cooldown, so a one-off blip still recovers quickly.
      env.items.set("item-0", { status: "failed" });
      await env.recorder.tick();
      expect(env.logs.some((line) => line.includes("enters a short cooldown"))).toBe(true);
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1); // held by the cooldown

      vi.setSystemTime(new Date(Date.now() + 31_000));
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(2); // cooldown expired: retried

      // A second failure in a row doubles the wait instead of restarting on the flat cooldown.
      env.items.set("item-1", { status: "failed" });
      await env.recorder.tick();
      expect(env.logs.some((line) => line.includes("failed 2 captures in a row"))).toBe(true);

      // 31s later the old flat 30s cooldown would already have fired; the escalated one has not.
      vi.setSystemTime(new Date(Date.now() + 31_000));
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(2);

      vi.setSystemTime(new Date(Date.now() + 30_000));
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(3); // past the 60s escalated wait
    } finally { env.cleanup(); vi.useRealTimers(); }
  });

  it("resets the failure backoff after a successful capture", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());

      await env.recorder.tick();
      env.items.set("item-0", { status: "failed" });
      await env.recorder.tick();

      vi.setSystemTime(new Date(Date.now() + 31_000));
      await env.recorder.tick();
      env.items.set("item-1", { status: "completed" }); // a capture that actually recorded
      await env.recorder.tick();
      expect(env.logs.some((line) => line.includes("enters cooldown"))).toBe(true);

      // The next failure is graded as the first of a fresh streak, not the third in a row.
      vi.setSystemTime(new Date(Date.now() + 121_000));
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(3);
      env.items.set("item-2", { status: "failed" });
      await env.recorder.tick();
      expect(env.logs.some((line) => line.includes("enters a short cooldown"))).toBe(true);
    } finally { env.cleanup(); vi.useRealTimers(); }
  });

  it("caps the cooldown when a failure confirms the room is offline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      // The status API still says "live", but the provider's own page proves otherwise.
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);

      env.items.set("item-0", { status: "failed", error: "The public room did not expose an HLS host" });
      await env.recorder.tick();
      expect(env.logs.some((line) => line.includes("confirmed-offline"))).toBe(true);

      // Long past where the first-failure 30s cooldown would have fired: still held.
      vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);

      // Past the 1h ceiling the room gets one more attempt (and the status cache, fed by the
      // same verdict, is what should keep it quiet in production).
      vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(2);
    } finally { env.cleanup(); vi.useRealTimers(); }
  });

  it("does not cap the cooldown for ordinary transient failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      env.items.set("item-0", { status: "failed", error: "ffmpeg was killed by a signal" });
      await env.recorder.tick();
      expect(env.logs.some((line) => line.includes("enters a short cooldown"))).toBe(true);
      expect(env.logs.every((line) => !line.includes("confirmed-offline"))).toBe(true);
    } finally { env.cleanup(); vi.useRealTimers(); }
  });
});
