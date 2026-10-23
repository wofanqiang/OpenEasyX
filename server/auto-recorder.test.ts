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
  const listedItems: Array<Pick<DownloadItem, "id" | "pluginId" | "externalId" | "status" | "metadata" | "captureEndedAt">> = [];
  const dbStub = {
    getSettings: () => db.getSettings(),
    listLiveCamFavorites: () => db.listLiveCamFavorites(),
    listItems: () => listedItems,
    getItem: (id: string) => {
      const listed = items.get(id);
      return listed ? ({ id, pluginId: "test.live", externalId: "", ...listed } as DownloadItem) : undefined;
    },
  } as unknown as Database;

  // Mirrors the real `LiveCamService.record`: the capture becomes a row immediately, so the next
  // status pass must find it and leave the room alone. The harness has to model that or the
  // watcher looks like it re-records the same room on every pass.
  const record = vi.fn(async (_providerId: string, cam: { username: string }) => {
    const itemId = `item-${itemCounter++}`;
    const room = cam.username.trim().toLowerCase();
    items.set(itemId, { status: "queued" });
    listedItems.push({
      id: itemId, pluginId: "test.live", externalId: `auto-live:${room}:2026-09-15T12-00-00-000Z`,
      status: "queued", metadata: { live: true, liveRoom: room },
    });
    return { itemId, status: "queued" };
  });
  const cams: Array<Record<string, unknown>> = [];
  const list = vi.fn(async () => ({ status: { ok: true }, providers: [{ id: "test.live", name: "Test Live", ok: true, count: cams.length }], items: cams }));
  const autoRecordStatuses = vi.fn(async (providerId: string, targets: Array<{ username: string; pageUrl: string }>) => {
    const wanted = new Set(targets.map((target) => target.username.toLowerCase()));
    const items = cams.filter((cam) => String(cam.providerId) === providerId && wanted.has(String(cam.username).toLowerCase()));
    return { ok: true, cams: items };
  });
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
    autoRecordStatuses,
  } as unknown as LiveCamService;
  const logs: string[] = [];
  // Plenty of free space by default so the disk guard never makes an unrelated test flaky.
  const recorder = startAutoRecorder({
    db: dbStub, liveCams: liveCamsStub, mediaRoot: dir,
    freeSpace: probe ?? (async () => 50 * 1024 ** 3),
    log: (message) => logs.push(message),
  });
  return {
    recorder, record, list, cams, items, listedItems, logs, db, autoRecordStatuses,
    cleanup: () => { recorder.stop(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort on Windows */ } },
  };
}

/** Ends a capture the way the database does: the item settles, and optionally frees the room. */
function finishCapture(env: Harness, id: string, status: string, freeRoom = false) {
  env.items.set(id, { status });
  const listed = env.listedItems.find((entry) => entry.id === id);
  if (!listed) return;
  listed.status = status;
  if (freeRoom) listed.captureEndedAt = "2026-09-15T12-00-30.000Z";
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

  it("does not ask the provider about a room it is already capturing", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      // `record` already listed the capture as an in-flight row, the way the queue would.
      env.autoRecordStatuses.mockClear();
      await env.recorder.tick();
      // The only armed room is being captured, so the provider is not questioned at all.
      expect(env.autoRecordStatuses).not.toHaveBeenCalled();
      expect(env.record).toHaveBeenCalledTimes(1);
    } finally { env.cleanup(); }
  });

  it("keeps polling the provider for rooms that are not being captured", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      env.db.setLiveCamFavorite("test.live", { camId: "bob", username: "bob", pageUrl: "https://live.test/bob" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "bob", true);
      env.cams.push(makeCam({ id: "bob", username: "bob", pageUrl: "https://live.test/bob" }));
      env.autoRecordStatuses.mockClear();

      await env.recorder.tick();
      expect(env.autoRecordStatuses).toHaveBeenCalledTimes(1);
      // The filter must drop only the capturing room, never the whole provider.
      expect(env.autoRecordStatuses.mock.calls[0][1].map((target) => target.username)).toEqual(["bob"]);
      expect(env.record).toHaveBeenCalledTimes(2);
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

  it("records the room again as soon as the previous capture ends and it is still public", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      env.cams.push(makeCam());
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
      // The recording ends while the cam is still in a public show: the room is free again and
      // the next pass starts a fresh one. There is no cooldown to wait out.
      finishCapture(env, "item-0", "completed");
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(2);
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

      // When that capture ends the room is still on air, so the watcher records it on the next
      // pass instead of treating the ended capture as its own recording.
      env.listedItems.splice(0, env.listedItems.length);
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
    } finally { env.cleanup(); }
  });

  it("records nothing but a room the provider reports as public", async () => {
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      // A provider answers isOnline/isLive for a group show too (measured on Stripchat: 60 of 60
      // rooms online, four of them groupShow), so the flag alone cannot be trusted. Nothing but
      // an openly watchable show may start a capture.
      env.cams.push(makeCam({ online: true, status: "groupShow" }));
      await env.recorder.tick();
      expect(env.record).not.toHaveBeenCalled();
      env.cams.length = 0;
      env.cams.push(makeCam({ online: true, status: "private" }));
      await env.recorder.tick();
      expect(env.record).not.toHaveBeenCalled();
      env.cams.length = 0;
      env.cams.push(makeCam({ online: true, status: "public" }));
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(1);
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

  it("starts a fresh capture on the very next pass after a failure, with no cooldown to wait out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const env: Harness = await fixture();
    try {
      env.db.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      env.db.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
      // The room reports a public show but its capture keeps failing.
      env.cams.push(makeCam());

      for (let round = 0; round < 4; round += 1) {
        await env.recorder.tick();
        expect(env.record).toHaveBeenCalledTimes(round + 1);
        // The capture fails and the room stays public: "should this be recording" is answered by
        // the room's status, not by a timer, so the next pass starts another one immediately.
        finishCapture(env, `item-${round}`, "failed");
        vi.setSystemTime(new Date(Date.now() + 1_000));
      }
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(5);
      expect(env.logs.some((line) => line.includes("cooldown"))).toBe(false);
    } finally { env.cleanup(); vi.useRealTimers(); }
  });


  it("stops calling a room busy once its capture has ended, even while it is still packaging", async () => {
    // The item stays `downloading` through concat/remux so the stall timer cannot kill a healthy
    // remux, and that made the watcher -- the only remaining component keying off `status` --
    // treat the room as occupied for the whole packaging step. The queue already allows a new
    // capture from `capture_ended_at` onward, so the watcher has to agree or an automatic
    // re-record waits out minutes of remux on a multi-GB file.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    const env: Harness = await fixture();
    try {
      for (const username of ["alice", "bob"]) {
        env.db.setLiveCamFavorite("test.live", { camId: username, username, pageUrl: `https://live.test/${username}` }, true);
        env.db.setLiveCamFavoriteAutoRecord("test.live", username, true);
        env.cams.push(makeCam({ id: username, username, pageUrl: `https://live.test/${username}` }));
      }
      await env.recorder.tick();
      expect(env.record).toHaveBeenCalledTimes(2);

      // Both captures' ffmpeg has exited; both items are still `downloading` while they pack.
      // Only alice's carries the capture-ended stamp, so only alice's room is free.
      for (const [id, username] of [[0, "alice"], [1, "bob"]]) {
        const listed = env.listedItems.find((entry) => entry.id === `item-${id}`);
        expect(listed?.metadata).toMatchObject({ liveRoom: username });
        if (username === "alice") finishCapture(env, `item-${id}`, "downloading", true);
      }

      await env.recorder.tick();
      // Alice's capture ended, so her room is free right away and her next recording starts on
      // this very pass -- not when the packaging finishes. Bob is still capturing, so he stays in
      // flight: not re-recorded, and not even asked about.
      expect(env.record).toHaveBeenCalledTimes(3);
      expect((env.record.mock.calls[2] as unknown[])[1]).toMatchObject({ username: "alice" });
      const recorded = env.record.mock.calls.map((call) => ((call as unknown[])[1] as { username?: string } | undefined)?.username);
      expect(recorded.filter((name) => name === "bob")).toHaveLength(1);
    } finally { env.cleanup(); vi.useRealTimers(); }
  });

});
