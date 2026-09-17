import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "./database.js";
import { LiveCamService } from "./live-cams.js";
import { PluginManager } from "./plugin-manager.js";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* Windows occasionally holds the WAL/db handle; cleanup is best-effort. */ } } });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-live-cams-")); temporaryDirectories.push(root);
  const pluginRoot = path.join(root, "plugins"); fs.mkdirSync(path.join(pluginRoot, "viewer"), { recursive: true }); fs.mkdirSync(path.join(pluginRoot, "live"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "viewer", "index.mjs"), `export default { manifest: { id: "org.easyx.viewer", name: "Viewer", version: "1", description: "Test", author: "Test", capabilities: ["library-hook"] }, acceptLibraryDeletion: async (_context, deletion) => deletion };`);
  fs.writeFileSync(path.join(pluginRoot, "live", "index.mjs"), `export default {
    manifest: { id: "test.live", name: "Test Live", version: "1", description: "Test", author: "Test", capabilities: ["live-cam", "download-resolver"], sourceUrlPatterns: ["https://live.test/*"] },
    listLiveCams: async (_context, query) => ({ cams: [{ id: "alice", username: "alice", title: "Alice live", pageUrl: "https://live.test/alice", viewers: 25 }], total: 1, page: query.page, pageSize: query.pageSize, pages: 1 }),
    resolveLiveStream: async () => ({ url: "https://cdn.test/alice/master.m3u8", headers: { Referer: "https://live.test/" } }),
    resolveDownload: async (_context, item) => ({ url: "https://cdn.test/alice/master.m3u8", filename: item.filename })
  };`);
  const database = new Database(path.join(root, "data")); const plugins = new PluginManager(database, [pluginRoot]); await plugins.load();
  return { database, plugins, service: new LiveCamService(database, plugins) };
}

/** Minimal FastifyReply stand-in so the live proxy can be driven directly in a test. */
function replyStub() {
  const state: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) { state.status = code; return reply; },
    type() { return reply; },
    header() { return reply; },
    send(body: unknown) { state.body = body; return body; },
  };
  return Object.assign(reply, { state });
}

describe("Open EasyX live cams", () => {
  // A performer can be added by pasting its profile URL. That path writes the placeholder
  // manual plugin into source.plugin_id, records the real scraper in scraper_plugin_id, and
  // stores the URL (not the handle) as external_id. The watcher used to consult plugin_id
  // alone, so those performers stayed armed in the UI but were never polled or recorded.
  it("keeps a performer added by pasting a URL on the auto-record watch list", async () => {
    const { database, plugins, service } = await fixture();
    plugins.install("test.live");
    const performer = database.createPerformer({ name: "Alice" });
    const source = database.addSource(performer.id, "org.easyx.manual", {
      externalId: "https://live.test/alice", label: "alice", profileUrl: "https://live.test/alice", domain: "live.test",
    });
    database.updateSource(source.id, { scraperPluginId: "test.live" });
    database.setPerformerAutoRecord(performer.id, true);
    expect(service.autoRecordTargets()).toMatchObject([
      { providerId: "test.live", username: "alice", pageUrl: "https://live.test/alice" },
    ]);
  });

  it("still watches a performer whose source already names the live plugin", async () => {
    const { database, plugins, service } = await fixture();
    plugins.install("test.live");
    const performer = database.createPerformer({ name: "Alice" });
    database.addSource(performer.id, "test.live", {
      externalId: "alice", label: "alice", profileUrl: "https://live.test/alice", domain: "live.test",
    });
    database.setPerformerAutoRecord(performer.id, true);
    const targets = service.autoRecordTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ providerId: "test.live", username: "alice" });
  });

  it("ignores a performer that was never armed", async () => {
    const { database, plugins, service } = await fixture();
    plugins.install("test.live");
    const performer = database.createPerformer({ name: "Alice" });
    database.addSource(performer.id, "test.live", {
      externalId: "alice", label: "alice", profileUrl: "https://live.test/alice", domain: "live.test",
    });
    expect(service.autoRecordTargets()).toHaveLength(0);
  });

  // Auto-record belongs to the performer: adding someone to the directory is enough, and the
  // watcher must never need a saved live-cam favorite before it will poll a room.
  it("watches an armed performer that has no favorite at all", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const { performer } = service.createPerformer("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" });
    expect(database.listLiveCamFavorites()).toHaveLength(0);
    expect(service.autoRecordTargets()).toHaveLength(0);
    expect(service.setPerformerAutoRecord(performer.id, true).matched).toBe(0);
    expect(service.autoRecordTargets()).toMatchObject([
      { providerId: "test.live", username: "alice", pageUrl: "https://live.test/alice" },
    ]);
  });

  // Favoriting is optional now, so the favorite switch itself must reach the performer that owns
  // it instead of quietly arming a flag nothing reads any more.
  it("arms the owning performer through the favorite switch", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const cam = { id: "alice", username: "alice", pageUrl: "https://live.test/alice" };
    // A favorite is a bookmark and never creates a performer, so the performer must exist first.
    const { performer } = service.createPerformer("test.live", cam);
    await service.setFavorite("test.live", cam, true);
    expect(service.setFavoriteAutoRecord("test.live", "alice", true)).toMatchObject({ autoRecord: true });
    expect(service.performerAutoRecord(database.getPerformer(performer.id)!)).toBe(true);
    expect(service.autoRecordTargets()).toMatchObject([{ providerId: "test.live", username: "alice" }]);
    service.setFavoriteAutoRecord("test.live", "alice", false);
    expect(service.performerAutoRecord(database.getPerformer(performer.id)!)).toBe(false);
    expect(service.autoRecordTargets()).toHaveLength(0);
    expect(service.setFavoriteAutoRecord("test.live", "nobody", true)).toBeUndefined();
  });

  it("adopts a favorite that was armed before auto-record moved to the performer", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const cam = { id: "alice", username: "alice", pageUrl: "https://live.test/alice" };
    // Legacy state: a bookmark favorite plus the performer it used to create under the old rule.
    const { performer } = service.createPerformer("test.live", cam);
    await service.setFavorite("test.live", cam, true);
    database.setLiveCamFavoriteAutoRecord("test.live", "alice", true);
    // A favorite on its own no longer arms anything: the performer switch is the only source.
    expect(service.autoRecordTargets()).toHaveLength(0);
    expect(service.adoptLegacyFavoriteAutoRecord()).toMatchObject({ adopted: 1, orphaned: [] });
    expect(service.performerAutoRecord(database.getPerformer(performer.id)!)).toBe(true);
    expect(service.autoRecordTargets()).toMatchObject([{ providerId: "test.live", username: "alice" }]);
    // The legacy flag is cleared so a later performer-level disable sticks, and a second boot has
    // nothing left to adopt.
    expect(database.listLiveCamFavorites()).toEqual([expect.objectContaining({ username: "alice", autoRecord: false })]);
    service.setPerformerAutoRecord(performer.id, false);
    expect(service.adoptLegacyFavoriteAutoRecord()).toMatchObject({ adopted: 0, orphaned: [] });
    expect(service.autoRecordTargets()).toHaveLength(0);
  });

  // A favorite whose provider plugin is gone has no performer to own the flag. That has to be
  // reported at boot instead of looking armed forever while nothing is ever recorded.
  it("reports an armed favorite that has no performer", async () => {
    const { database, plugins, service } = await fixture();
    database.setLiveCamFavorite("test.live", { camId: "ghost", username: "ghost", pageUrl: "https://live.test/ghost" }, true);
    database.setLiveCamFavoriteAutoRecord("test.live", "ghost", true);
    expect(service.adoptLegacyFavoriteAutoRecord()).toMatchObject({ adopted: 0, orphaned: ["test.live:ghost"] });
    expect(service.autoRecordTargets()).toHaveLength(0);
  });

  it("uses the reconnected account immediately instead of its cached login failure", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    const followed = vi.fn().mockResolvedValueOnce({ authoritative: false, cams: [], skippedReason: "Session expired" })
      .mockResolvedValue({ authoritative: true, cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", online: true }] });
    plugins.get("test.live").listFollowedLiveCams = followed;
    const query = { page: 1, pageSize: 24, favoritesOnly: true };
    expect((await service.list(query)).items).toHaveLength(0);
    service.resetProviderSession("test.live");
    expect(await service.syncFavorites("test.live")).toMatchObject({ authoritative: true, added: 1 });
    expect((await service.list(query)).items).toMatchObject([{ username: "alice", online: true }]);
    expect(followed).toHaveBeenCalledTimes(2);
  });

  it("reuses the live capture already in flight for a room", async () => {
    const { plugins, service, database } = await fixture();
    plugins.install("test.live");
    const cam = { id: "alice", username: "alice", title: "Alice live", pageUrl: "https://live.test/alice" };
    // Manual, automatic and scraper-driven entry points all resolve to this source, and two
    // ffmpeg captures of one broadcast end together, so the second call must reuse the first.
    const first = await service.record("test.live", cam);
    const second = await service.record("test.live", cam);
    expect(second.itemId).toBe(first.itemId);
    expect(database.listItems(50)).toHaveLength(1);
    // The next broadcast of the same room is a new recording, not a duplicate of this one.
    database.setItemStatus(first.itemId, "completed");
    const third = await service.record("test.live", cam);
    expect(third.itemId).not.toBe(first.itemId);
    expect(database.listItems(50)).toHaveLength(2);
  });

  it("does not let an old in-flight account read overwrite a reconnected session", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    let finishOld!: (value: { authoritative: boolean; cams: []; skippedReason: string }) => void;
    let started!: () => void;
    const oldStarted = new Promise<void>((resolve) => { started = resolve; });
    const followed = vi.fn().mockImplementationOnce(() => { started(); return new Promise((resolve) => { finishOld = resolve; }); })
      .mockResolvedValue({ authoritative: true, cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", online: true }] });
    plugins.get("test.live").listFollowedLiveCams = followed;
    const oldSync = service.syncFavorites("test.live"); await oldStarted;
    service.resetProviderSession("test.live");
    expect(await service.syncFavorites("test.live")).toMatchObject({ authoritative: true });
    finishOld({ authoritative: false, cams: [], skippedReason: "Old session expired" }); await oldSync;
    expect((await service.list({ page: 1, pageSize: 24, favoritesOnly: true })).items).toMatchObject([{ username: "alice", online: true }]);
    expect(followed).toHaveBeenCalledTimes(2);
  });

  it("shares account reads across concurrent refreshes and scheduled synchronization", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    const followed = vi.fn(async () => ({ authoritative: true, cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", online: true }] }));
    plugins.get("test.live").listFollowedLiveCams = followed;
    const [all, selected] = await Promise.all([
      service.list({ page: 1, pageSize: 24, favoritesOnly: true }),
      service.list({ page: 1, pageSize: 24, favoritesOnly: true, providerId: "test.live" }),
      service.syncFavorites("test.live"),
    ]);
    expect(all.items).toHaveLength(1); expect(selected.items).toHaveLength(1);
    expect(followed).toHaveBeenCalledTimes(1);
  });

  it("retains 100 favorites without a request storm during 429 failures and automatically recovers", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    for (let i = 0; i < 100; i++) database.setLiveCamFavorite("test.live", { camId: `cam${i}`, username: `cam${i}`, pageUrl: `https://live.test/cam${i}` }, true);
    const snapshot = vi.fn(async () => ({ authoritative: false, cams: [], skippedReason: "HTTP 429" }));
    const lookup = vi.fn(); const plugin = plugins.get("test.live"); plugin.listFollowedLiveCams = snapshot; plugin.getLiveCam = lookup;
    vi.useFakeTimers();
    try {
      const query = { page: 1, pageSize: 24, favoritesOnly: true };
      for (let i = 0; i < 3; i++) {
        const result = await service.list(query);
        expect(result.total).toBe(100); expect(result.items).toHaveLength(24);
        expect(result.items.every((cam) => cam.statusUnavailable)).toBe(true);
        await vi.advanceTimersByTimeAsync(30_001);
      }
      await service.syncFavorites("test.live");
      expect(snapshot).toHaveBeenCalledTimes(1); expect(lookup).not.toHaveBeenCalled();
      expect(database.listLiveCamFavorites()).toHaveLength(100);
      await vi.advanceTimersByTimeAsync(29_000);
      await service.list(query); // A late refresh must not extend the failure cooldown.
      plugin.listFollowedLiveCams = async () => ({ authoritative: true, cams: [{ id: "cam0", username: "cam0", pageUrl: "https://live.test/cam0", online: true }] });
      await vi.advanceTimersByTimeAsync(1_001);
      expect((await service.list(query)).items).toMatchObject([{ username: "cam0", online: true }]);
    } finally { vi.useRealTimers(); }
  });

  it("preserves partial imports and old favorites until a complete account snapshot is available", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "old", username: "old", pageUrl: "https://live.test/old" }, true);
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: false, skippedReason: "HTTP 429", cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", online: true }] });
    const result = await service.list({ page: 1, pageSize: 24, favoritesOnly: true });
    expect(result.items).toMatchObject([{ username: "alice", online: true }, { username: "old", statusUnavailable: true }]);
    expect(database.listLiveCamFavorites()).toHaveLength(2);
  });

  it("does not call unselected providers and reuses public results across tabs", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    const list = vi.fn(plugins.get("test.live").listLiveCams!); plugins.get("test.live").listLiveCams = list;
    const query = { page: 1, pageSize: 24, providerId: "test.live" };
    await Promise.all([service.list(query), service.list(query)]);
    expect(list).toHaveBeenCalledTimes(1);
    await service.list({ ...query, providerId: "other.live" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("retains the public catalogue with an unavailable status when a refresh is rate limited", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    vi.useFakeTimers();
    try {
      const query = { page: 1, pageSize: 24, providerId: "test.live" };
      expect((await service.list(query)).items).toHaveLength(1);
      plugins.get("test.live").listLiveCams = vi.fn(async () => { throw new Error("HTTP 429. Automatic retry shortly."); });
      // Let the 30s success cache expire so the refresh actually runs and fails.
      await vi.advanceTimersByTimeAsync(30_001);
      const result = await service.list(query);
      expect(result.items).toMatchObject([{ username: "alice", statusUnavailable: true }]);
      expect(result.providers).toMatchObject([{ warning: "HTTP 429. Automatic retry shortly." }]);
      // Failure results share the 30s cache window: a later list retries the provider
      // instead of serving the failed snapshot for minutes.
      await vi.advanceTimersByTimeAsync(30_001);
      await service.list(query);
      expect(plugins.get("test.live").listLiveCams).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("saves a favorite as a pure bookmark without creating a performer", async () => {
    const { database, plugins } = await fixture(); plugins.install("test.live");
    const saveImage = vi.fn(); const service = new LiveCamService(database, plugins, fetch, saveImage);
    const cam = { id: "alice", username: "alice", pageUrl: "https://live.test/alice", thumbnailUrl: "https://live.test/alice.jpg" };
    await service.setFavorite("test.live", cam, true);
    // Favoriting is a bookmark only: no performer, no source and no local image are created.
    expect(database.listPerformers()).toHaveLength(0);
    expect(database.listSources()).toHaveLength(0);
    expect(saveImage).not.toHaveBeenCalled();
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
    // Re-favoriting the same room stays idempotent.
    await service.setFavorite("test.live", cam, true);
    expect(database.listPerformers()).toHaveLength(0);
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
  });

  it("aggregates every installed live provider without a Viewer bridge", async () => {
    const { plugins, service } = await fixture();
    plugins.install("test.live");
    await expect(service.list({ page: 1, pageSize: 24 })).resolves.toMatchObject({
      total: 1, items: [{ username: "alice", providerId: "test.live", providerName: "Test Live", viewers: 25 }], providers: [{ id: "test.live", ok: true }],
    });
  });

  it("keeps pages disjoint when live viewer counts reshuffle between requests", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-live-pages-")); temporaryDirectories.push(root);
    const pluginRoot = path.join(root, "plugins");
    fs.mkdirSync(path.join(pluginRoot, "live"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "live2"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "live", "index.mjs"), `export default { manifest: { id: "test.live", name: "Test Live", version: "1", description: "Test", author: "Test", capabilities: ["live-cam"], sourceUrlPatterns: ["https://test.live/*"] }, listLiveCams: async () => ({ cams: [], total: 0, page: 1, pageSize: 24, pages: 1 }), resolveLiveStream: async () => ({ url: "https://cdn.test/master.m3u8", headers: {} }) };`);
    fs.writeFileSync(path.join(pluginRoot, "live2", "index.mjs"), `export default { manifest: { id: "test.live2", name: "Test Live 2", version: "1", description: "Test", author: "Test", capabilities: ["live-cam"], sourceUrlPatterns: ["https://test.live2/*"] }, listLiveCams: async () => ({ cams: [], total: 0, page: 1, pageSize: 24, pages: 1 }), resolveLiveStream: async () => ({ url: "https://cdn.test/master.m3u8", headers: {} }) };`);
    const database = new Database(path.join(root, "data"));
    const plugins = new PluginManager(database, [pluginRoot]); await plugins.load();
    plugins.install("test.live"); plugins.install("test.live2");
    const service = new LiveCamService(database, plugins);

    // When `p1Hot` is true provider 1 dominates the viewer leaderboard; when false the
    // roles swap. The old global sort keyed pages on live `viewers`, so flipping it between
    // requests pushed the same cams onto two pages. Pages must stay disjoint regardless.
    let p1Hot = true;
    const makeList = (prefix: string, host: string, hot: boolean) => async (_context: unknown, query: { page: number; pageSize: number }) => {
      const cams = Array.from({ length: 12 }, (_, index) => {
        const username = `${prefix}${String(index + 1).padStart(2, "0")}`;
        const viewers = hot ? 100 - index : 12 - index;
        return { id: username, username, pageUrl: `https://${host}/${username}`, viewers };
      });
      return { cams, total: cams.length, page: query.page, pageSize: query.pageSize, pages: 1 };
    };
    plugins.get("test.live").listLiveCams = makeList("u", "test.live", p1Hot);
    plugins.get("test.live2").listLiveCams = makeList("v", "test.live2", !p1Hot);

    const pageSize = 12;
    p1Hot = true;
    const page1 = (await service.list({ page: 1, pageSize })).items.map((cam) => cam.username);
    p1Hot = false;
    plugins.get("test.live").listLiveCams = makeList("u", "test.live", p1Hot);
    plugins.get("test.live2").listLiveCams = makeList("v", "test.live2", !p1Hot);
    const page2 = (await service.list({ page: 2, pageSize })).items.map((cam) => cam.username);

    const overlap = (left: string[], right: string[]) => left.filter((value) => right.includes(value));
    expect(overlap(page1, page2)).toEqual([]);
    expect(new Set([...page1, ...page2]).size).toBe(24);
  });

  it("persists favorite creators and lists only favorites that are currently online", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const plugin = plugins.get("test.live");
    plugin.listLiveCams = async (_context, query) => {
      const cams = [
        { id: "alice", username: "alice", pageUrl: "https://live.test/alice", viewers: 25 },
        { id: "bob", username: "bob", pageUrl: "https://live.test/bob", viewers: 10 },
      ].filter((cam) => !query.search || cam.username.includes(query.search));
      return { cams, total: cams.length, page: query.page, pageSize: query.pageSize, pages: 1 };
    };
    const alice = (await service.list({ page: 1, pageSize: 24 })).items[0];
    await expect(service.setFavorite("test.live", alice, true)).resolves.toMatchObject({ favorite: true, item: { username: "alice" } });
    expect(database.listLiveCamFavorites()).toHaveLength(1);
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 1, items: [{ username: "alice", favorite: true }],
    });
    expect(service.listFavorites()).toEqual([expect.objectContaining({ username: "alice" })]);
    await expect(service.setFavorite("test.live", alice, false)).resolves.toEqual({ favorite: false });
  });

  it("reconciles an authoritative account snapshot without touching other providers", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "old", username: "old", pageUrl: "https://live.test/old" }, true);
    database.setLiveCamFavorite("other.live", { camId: "keep", username: "keep", pageUrl: "https://other.test/keep" }, true);
    plugins.get("test.live").listFollowedLiveCams = async () => ({
      authoritative: true,
      cams: [
        { id: "alice", username: "alice", pageUrl: "https://live.test/alice", online: true },
        { id: "bob", username: "bob", pageUrl: "https://live.test/bob", online: false },
      ],
    });

    await expect(service.syncFavorites("test.live")).resolves.toEqual({
      providerId: "test.live", synced: 2, added: 2, removed: 1, authoritative: true,
    });
    expect(database.listLiveCamFavorites("test.live").map((item) => item.username)).toEqual(["alice", "bob"]);
    expect(database.listLiveCamFavorites("other.live").map((item) => item.username)).toEqual(["keep"]);
  });

  it("keeps existing favorites when an account snapshot is not authoritative", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    plugins.get("test.live").listFollowedLiveCams = async () => ({ cams: [], authoritative: false, skippedReason: "Session expired" });
    await expect(service.syncFavorites("test.live")).resolves.toMatchObject({ authoritative: false, skippedReason: "Session expired" });
    expect(database.listLiveCamFavorites("test.live").map((item) => item.username)).toEqual(["alice"]);
  });

  it("uses one followed snapshot to list online favorites without per-creator searches", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    const plugin = plugins.get("test.live");
    plugin.listLiveCams = async () => { throw new Error("Per-creator search should not run"); };
    plugin.listFollowedLiveCams = async () => ({ authoritative: true, cams: [
      { id: "alice", username: "alice", pageUrl: "https://live.test/alice", viewers: 25, online: true },
      { id: "bob", username: "bob", pageUrl: "https://live.test/bob", viewers: 0, online: false },
    ] });
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 2, items: [{ username: "alice", favorite: true, online: true }, { username: "bob", favorite: true, online: false }], providers: [{ ok: true, count: 2 }],
    });
    expect(service.listFavorites().map((favorite) => favorite.username)).toEqual(["alice", "bob"]);
  });

  it("refreshes followed status after 60 seconds even when favorites are consulted repeatedly", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    vi.useFakeTimers();
    try {
      let online = false;
      const followed = vi.fn(async () => ({ authoritative: true, cams: [
        { id: "alice", username: "alice", pageUrl: "https://live.test/alice", online },
      ] }));
      plugins.get("test.live").listFollowedLiveCams = followed;
      const query = { page: 1, pageSize: 24, favoritesOnly: true };
      expect((await service.list(query)).items[0].online).toBe(false);
      online = true;
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await service.list(query)).items[0].online).toBe(false);
      await vi.advanceTimersByTimeAsync(40_001);
      expect((await service.list(query)).items[0].online).toBe(true);
      expect(followed).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it.each(["disconnected", "expired"])("checks public live status for saved favorites when the account is %s", async (state) => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    database.setLiveCamFavorite("test.live", { camId: "bob", username: "bob", pageUrl: "https://live.test/bob" }, true);
    plugins.get("test.live").listFollowedLiveCams = async () => {
      if (state === "failed") throw new Error("Network unreachable");
      return { cams: [], authoritative: false, skippedReason: state };
    };
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 2, items: [{ username: "alice", favorite: true, online: true }, { username: "bob", favorite: true, online: false }],
    });
    expect(database.listLiveCamFavorites("test.live")).toHaveLength(2);
  });

  it("refreshes local favorite status without perpetually reusing the last displayed cam", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    const plugin = plugins.get("test.live");
    plugin.listFollowedLiveCams = async () => ({ cams: [], authoritative: false });
    let online = false;
    plugin.listLiveCams = async (_context, query) => ({
      cams: online ? [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice" }] : [],
      total: online ? 1 : 0, page: query.page, pageSize: query.pageSize, pages: 1,
    });
    vi.useFakeTimers();
    try {
      const query = { page: 1, pageSize: 24, favoritesOnly: true };
      expect((await service.list(query)).items[0].online).toBe(false);
      online = true;
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await service.list(query)).items[0].online).toBe(true);
      online = false;
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await service.list(query)).items[0].online).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("checks a pending local favorite missing from an authoritative followed list", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    const plugin = plugins.get("test.live");
    plugin.setLiveCamFavorite = async () => ({ synchronized: false });
    plugin.listFollowedLiveCams = async () => ({ cams: [], authoritative: true });
    await service.setFavorite("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    await service.flushFavoriteChanges("test.live");
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 1, items: [{ username: "alice", online: true, favorite: true }],
    });
  });

  it("uses exact room status and opens a favorite outside the provider's limited search catalogue", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "outside", username: "outside", pageUrl: "https://live.test/outside" }, true);
    const plugin = plugins.get("test.live");
    plugin.listFollowedLiveCams = async () => ({ cams: [], authoritative: false, skippedReason: "Session expired" });
    const search = vi.fn(plugin.listLiveCams!); plugin.listLiveCams = search;
    plugin.getLiveCam = async (_context, cam) => ({ ...cam, online: true, viewers: 20 });
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 1, items: [{ username: "outside", online: true }], providers: [{ warning: "Session expired" }],
    });
    await expect(service.get("test.live", "outside")).resolves.toMatchObject({ username: "outside", online: true });
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps failed live checks distinguishable from offline rooms and backs off retries", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    const plugin = plugins.get("test.live");
    plugin.listFollowedLiveCams = async () => ({ cams: [], authoritative: false, skippedReason: "Session expired" });
    const lookup = vi.fn(async () => { throw new Error("HTTP 429"); }); plugin.getLiveCam = lookup;
    const query = { page: 1, pageSize: 24, favoritesOnly: true };
    for (let count = 0; count < 2; count++) await expect(service.list(query)).resolves.toMatchObject({
      total: 1, items: [{ username: "alice", statusUnavailable: true }], providers: [{ warning: "Session expired" }],
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(database.listLiveCamFavorites("test.live")).toHaveLength(1);
  });

  it("reports account import failures even before any favorites have been imported", async () => {
    const { plugins, service } = await fixture(); plugins.install("test.live");
    plugins.get("test.live").listFollowedLiveCams = async () => { throw new Error("Reconnect the account"); };
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 0, items: [], providers: [{ warning: "Reconnect the account" }],
    });
  });

  it("isolates failed public lookups and requires an exact creator match", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    for (const username of ["alice", "bob", "carol"]) database.setLiveCamFavorite("test.live", { camId: username, username, pageUrl: `https://live.test/${username}` }, true);
    const plugin = plugins.get("test.live");
    plugin.listFollowedLiveCams = async () => ({ cams: [], authoritative: false });
    plugin.listLiveCams = async (_context, query) => {
      if (query.search === "bob") throw new Error("Temporary error");
      const username = query.search === "carol" ? "carol_other" : "ALICE";
      return { cams: [{ id: username, username, pageUrl: `https://live.test/${username}` }], total: 1, page: 1, pageSize: query.pageSize, pages: 1 };
    };
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({
      total: 3, items: [{ username: "ALICE", online: true }, { username: "bob", online: false }, { username: "carol", online: false }],
    });
  });

  it("saves locally immediately and synchronizes the provider account in the background", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    let remoteFavorite: boolean | undefined;
    plugins.get("test.live").setLiveCamFavorite = async (_context, _cam, favorite) => { remoteFavorite = favorite; return { synchronized: true }; };
    await expect(service.setFavorite("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true))
      .resolves.toMatchObject({ favorite: true, synchronization: "pending" });
    await service.flushFavoriteChanges("test.live");
    expect(remoteFavorite).toBe(true);
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
  });

  it("does not wait for a slow provider and protects the saved favorite from a stale snapshot", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    let finish!: (value: { synchronized: boolean }) => void;
    plugins.get("test.live").setLiveCamFavorite = () => new Promise((resolve) => { finish = resolve; });
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: true, cams: [] });
    const cam = (await service.list({ page: 1, pageSize: 24 })).items[0];
    await expect(service.setFavorite("test.live", cam, true)).resolves.toMatchObject({ favorite: true });
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({ items: [{ username: "alice", favorite: true }], total: 1 });
    finish({ synchronized: true }); await service.flushFavoriteChanges("test.live");
  });

  it("retains failed and disconnected local favorites across service restarts and retries them", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    plugins.get("test.live").setLiveCamFavorite = async () => { throw new Error("Session expired"); };
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: false, cams: [], skippedReason: "Session expired" });
    await service.setFavorite("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    await service.flushFavoriteChanges("test.live");
    expect(service.favoriteChanges()).toEqual([expect.objectContaining({ state: "failed", error: "Session expired" })]);
    const restarted = new LiveCamService(database, plugins);
    await expect(restarted.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({ total: 1, items: [{ username: "alice", favorite: true }] });
    plugins.get("test.live").setLiveCamFavorite = async () => ({ synchronized: true });
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: true, cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", online: true }] });
    await restarted.syncFavorites("test.live");
    expect(restarted.favoriteChanges()).toEqual([]);
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
  });

  it("serializes rapid toggles and never lets an older follow override a newer unfollow", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    let finish!: (value: { synchronized: boolean }) => void; const writes: boolean[] = [];
    plugins.get("test.live").setLiveCamFavorite = async (_context, _cam, favorite) => {
      writes.push(favorite);
      if (favorite) return new Promise((resolve) => { finish = resolve; });
      return { synchronized: true };
    };
    const cam = { id: "alice", username: "alice", pageUrl: "https://live.test/alice" };
    await service.setFavorite("test.live", cam, true);
    await service.setFavorite("test.live", cam, false);
    finish({ synchronized: true }); await service.flushFavoriteChanges("test.live");
    expect(writes).toEqual([true, false]);
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(false);
    plugins.get("test.live").listFollowedLiveCams = async () => ({ authoritative: true, cams: [{ ...cam, online: true }] });
    await service.syncFavorites("test.live");
    expect(database.isLiveCamFavorite("test.live", "alice")).toBe(false);
  });

  it("bounds a stuck provider operation, aborts its context, and preserves the local choice", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      plugins.get("test.live").setLiveCamFavorite = (context) => { signal = context.signal; return new Promise(() => {}); };
      await service.setFavorite("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
      const pending = service.flushFavoriteChanges("test.live");
      await vi.advanceTimersByTimeAsync(45_001); await pending;
      expect(signal?.aborted).toBe(true); expect(database.isLiveCamFavorite("test.live", "alice")).toBe(true);
      expect(service.favoriteChanges()[0]).toMatchObject({ state: "failed", error: expect.stringContaining("timed out") });
    } finally { vi.useRealTimers(); }
  });

  it("still lists saved favorites when the provider's snapshot throws", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    database.setLiveCamFavorite("test.live", { camId: "alice", username: "alice", pageUrl: "https://live.test/alice" }, true);
    plugins.get("test.live").listFollowedLiveCams = async () => { throw new Error("Network unreachable"); };
    await expect(service.list({ page: 1, pageSize: 24, favoritesOnly: true })).resolves.toMatchObject({ total: 1, items: [{ username: "alice", favorite: true }] });
  });

  it("creates one reusable performer profile directly from a live room", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const cam = { id: "alice", username: "alice", pageUrl: "https://live.test/alice", thumbnailUrl: "https://live.test/alice.jpg" };
    expect(service.createPerformer("test.live", cam)).toMatchObject({
      created: true, sourceCreated: true,
      performer: { name: "alice", imageUrl: "https://live.test/alice.jpg", externalRefs: { "test.live": "alice" } },
      source: { pluginId: "test.live", profileUrl: "https://live.test/alice" },
    });
    expect(service.createPerformer("test.live", { ...cam, pageUrl: "https://live.test/alice/" })).toMatchObject({ created: false, sourceCreated: false });
    expect(database.listPerformers()).toHaveLength(1);
    expect(database.listSources()).toHaveLength(1);
    await expect(service.get("test.live", "alice")).resolves.toMatchObject({ performerId: database.listPerformers()[0].id });
  });

  it("toggles auto-record at the performer level across its live-cam favorites", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const cam = { id: "alice", username: "alice", pageUrl: "https://live.test/alice" };
    await service.setFavorite("test.live", cam, true);
    // Favoriting is a bookmark and does not create a performer, so add one explicitly to own the flag.
    const { performer } = service.createPerformer("test.live", cam);
    expect(service.performerAutoRecord(performer)).toBe(false);
    // A performer can arm auto-record even with no saved live-cam favorite: the watcher now
    // polls every performer that has auto-record on, so the flag no longer requires a favorite.
    const lone = database.createPerformer({ name: "lone", aliases: [] });
    expect(service.setPerformerAutoRecord(lone.id, true).matched).toBe(0);
    expect(service.performerAutoRecord(database.getPerformer(lone.id)!)).toBe(true);
    expect(service.setPerformerAutoRecord(performer.id, true).matched).toBe(1);
    expect(database.listLiveCamFavorites("test.live")).toEqual([expect.objectContaining({ username: "alice", autoRecord: true })]);
    // The read path mirrors findPerformer: external refs first, performer name fallback.
    expect(service.performerAutoRecord(database.getPerformerByName("ALICE")!)).toBe(true);
    expect(service.setPerformerAutoRecord(performer.id, false).matched).toBe(1);
    expect(service.performerAutoRecord(database.getPerformer(performer.id)!)).toBe(false);
  });

  it("resolves provider streams behind a short-lived Downloader proxy URL", async () => {
    const { plugins, service } = await fixture(); plugins.install("org.easyx.viewer"); plugins.install("test.live");
    await expect(service.resolve("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" }))
      .resolves.toEqual({ streamUrl: expect.stringMatching(/^\/api\/live-cams\/proxy\/[A-Za-z0-9_-]+\.m3u8$/) });
  });

  it("decrypts anti-leech segment addresses while rewriting a proxied playlist", async () => {
    const { database, plugins } = await fixture(); plugins.install("org.easyx.viewer"); plugins.install("test.live");
    // A real capture from vr.superchat.live: the URI lines carry a decoy, the #EXT-X-MOUFLON:URI
    // hints carry the real but encrypted addresses. `_gFbIS9EhCnNf0nWm_` is what that token
    // decodes to, and the CDN served it with HTTP 200 when this was probed.
    const media = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      "#EXT-X-MOUFLON:PSCH:v2:Ook7quaiNgiyuhai",
      "#EXT-X-TARGETDURATION:2",
      "#EXT-X-MEDIA-SEQUENCE:5385",
      '#EXT-X-MAP:URI="https://cdn.test/alice/1440p60_h264_init_jTdPdxMGUO9mHHRQ.mp4"',
      "#EXT-X-MOUFLON:URI:https://cdn.test/alice/1440p60_h264_5385_Ao5b8oKcwmYOOsIxLlofVy_1789400984_part0.mp4",
      '#EXT-X-PART:DURATION=0.500,URI="https://cdn.test/alice/media.mp4",INDEPENDENT=YES',
      "#EXTINF:2.000",
      "#EXT-X-MOUFLON:URI:https://cdn.test/alice/1440p60_h264_5385_Ao5b8oKcwmYOOsIxLlofVy_1789400984.mp4",
      "https://cdn.test/alice/media.mp4",
      "#EXTINF:2.000",
      "#EXT-X-MOUFLON:URI:https://cdn.test/alice/1440p60_h264_5386_Qv9/c29MAps+NroUJhdD1w_1789400986.mp4",
      "https://cdn.test/alice/media.mp4",
    ].join("\n");

    const fetched: string[] = [];
    const request = vi.fn(async (url: URL | string) => {
      const href = String(url); fetched.push(href);
      return {
        ok: true, status: 200, url: href,
        headers: new Headers({ "content-type": "application/vnd.apple.mpegurl", "cache-control": "max-age=1" }),
        async arrayBuffer() { return new TextEncoder().encode(media).buffer; },
        async text() { return media; },
        body: null,
      };
    });
    const service = new LiveCamService(database, plugins, request as never);
    plugins.get("test.live").resolveLiveStream = async () => ({
      url: "https://cdn.test/alice/1440p60.m3u8?psch=v2&pkey=Ook7quaiNgiyuhai",
      headers: { Referer: "https://live.test/" },
      playlistDecodeKey: "EQueeGh2kaewa3ch",
    });

    const { streamUrl } = await service.resolve("test.live", { id: "alice", username: "alice", pageUrl: "https://live.test/alice" });
    const body = String(await service.proxy(streamUrl.replace("/api/live-cams/proxy/", ""), replyStub() as never, {}, undefined));

    // Every nested address is proxied, so resolve each token and inspect what the proxy fetched.
    const tokens = [...new Set([...body.matchAll(/\/api\/live-cams\/proxy\/([A-Za-z0-9_-]+)/g)].map((match) => match[1]!))];
    expect(tokens.length).toBeGreaterThan(2);
    for (const token of tokens) await service.proxy(token, replyStub() as never, {}, undefined);

    expect(fetched.some((url) => url.includes("/1440p60_h264_5385_gFbIS9EhCnNf0nWm_1789400984_part0.mp4"))).toBe(true);
    expect(fetched.some((url) => url.includes("/1440p60_h264_5386_mAWYzYYTwQJQJgSp_1789400986.mp4"))).toBe(true);
    // The decoy and the still-encrypted form must never reach the CDN.
    expect(fetched.some((url) => url.endsWith("/media.mp4"))).toBe(false);
    expect(fetched.some((url) => url.includes("_Ao5b8oKcwmYOOsIxLlofVy_"))).toBe(false);
    // The init segment is not obfuscated and must pass through unchanged.
    expect(fetched.some((url) => url.includes("1440p60_h264_init_jTdPdxMGUO9mHHRQ.mp4"))).toBe(true);
  });

  it("uses provider totals and returns only the requested aggregate page", async () => {
    const { plugins, service } = await fixture(); plugins.install("org.easyx.viewer"); plugins.install("test.live");
    const plugin = plugins.get("test.live");
    plugin.listLiveCams = async (_context, query) => {
      const matching = Array.from({ length: 125 }, (_, index) => ({
        id: `cam-${index + 1}`, username: `cam-${index + 1}`, pageUrl: `https://live.test/cam-${index + 1}`, viewers: 125 - index,
      })).filter((cam) => !query.search || cam.username.includes(query.search));
      return {
        cams: matching.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
        total: matching.length, page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(matching.length / query.pageSize)),
      };
    };
    const page = await service.list({ page: 3, pageSize: 24 });
    expect(page).toMatchObject({ total: 125, page: 3, pages: 6, providers: [{ id: "test.live", count: 125 }] });
    expect(page.items).toHaveLength(24);
    // Pagination is by a stable identity order, so adjacent windows never overlap even
    // though the live viewer leaderboard reshuffles between requests.
    const page1 = await service.list({ page: 1, pageSize: 24 });
    expect(page1.items).toHaveLength(24);
    const overlap = page1.items.filter((cam) => page.items.some((other) => other.username === cam.username));
    expect(overlap).toEqual([]);
    expect(new Set(page.items.map((cam) => cam.username)).size).toBe(24);
    await expect(service.list({ page: 1, pageSize: 24, search: "cam-12" })).resolves.toMatchObject({
      total: 7, providers: [{ id: "test.live", count: 7 }],
    });
    await expect(service.get("test.live", "cam-125")).resolves.toMatchObject({ id: "cam-125", providerId: "test.live" });
  });

  it("reuses the fresh catalogue entry when opening a room and queues direct recordings", async () => {
    const { database, plugins, service } = await fixture(); plugins.install("test.live");
    const plugin = plugins.get("test.live"); let searched = false;
    plugin.listLiveCams = async (_context, query) => {
      if (query.search) { searched = true; throw new Error("The provider search endpoint rejected the request"); }
      return { cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", thumbnailUrl: "https://live.test/alice.jpg" }], total: 1, page: query.page, pageSize: query.pageSize, pages: 1 };
    };
    await service.list({ page: 1, pageSize: 24 });
    const cam = await service.get("test.live", "alice");
    expect(searched).toBe(false);
    expect(cam).toMatchObject({ username: "alice", providerId: "test.live" });
    const recording = await service.record("test.live", cam);
    expect(recording.status).toBe("queued");
    expect(database.getItem(recording.itemId)).toMatchObject({ status: "queued", mediaType: "video", pageUrl: "https://live.test/alice", filename: expect.stringMatching(/^alice-.*\.mp4$/) });
  });

  it("streams an initial snapshot and then updates as each provider completes", async () => {
    const { plugins, service } = await fixture(); plugins.install("org.easyx.viewer"); plugins.install("test.live");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    plugins.get("test.live").listLiveCams = async (_context, query) => {
      await waiting;
      return { cams: [{ id: "alice", username: "alice", pageUrl: "https://live.test/alice" }], total: 1, page: query.page, pageSize: query.pageSize, pages: 1 };
    };
    const iterator = service.stream({ page: 1, pageSize: 24 });
    await expect(iterator.next()).resolves.toMatchObject({ value: { total: 0, complete: false, providers: [{ id: "test.live", pending: true }] } });
    const completed = iterator.next(); release();
    await expect(completed).resolves.toMatchObject({ value: { total: 1, complete: true, items: [{ username: "alice" }], providers: [{ count: 1 }] } });
  });

  // When a queued capture fails because the provider page itself said the room is offline,
  // the next status poll must report the room offline (the status API lags reality), so the
  // auto-recorder cannot re-queue it. Transient failures must never poison the cache.
  it("forces a confirmed-offline room to report offline until the override lapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
    const { plugins, service } = await fixture();
    plugins.install("test.live");
    try {
      // A transient failure must not poison the cache: alice still reports online.
      const transient = { pluginId: "test.live", externalId: "auto-live:alice:2026-09-16T10-00-00-000Z" } as never;
      service.reportLiveFailure(transient, "ffmpeg was killed by a signal");
      const before = await service.autoRecordStatuses("test.live", [{ username: "alice", pageUrl: "https://live.test/alice" }]);
      expect(before.cams[0]).toMatchObject({ username: "alice", online: true });

      // The provider page itself said offline: the next poll reports the room offline.
      const failed = { pluginId: "test.live", externalId: "auto-live:alice:2026-09-16T11-00-00-000Z" } as never;
      service.reportLiveFailure(failed, "The public room did not expose an HLS host");
      const statuses = await service.autoRecordStatuses("test.live", [{ username: "alice", pageUrl: "https://live.test/alice" }]);
      expect(statuses.ok).toBe(true);
      expect(statuses.cams[0]).toMatchObject({ username: "alice", online: false });

      // Past the override window the status poll reports the room as the API sees it again.
      vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
      const refreshed = await service.autoRecordStatuses("test.live", [{ username: "alice", pageUrl: "https://live.test/alice" }]);
      expect(refreshed.cams[0]).toMatchObject({ username: "alice", online: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
