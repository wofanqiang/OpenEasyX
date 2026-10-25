import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";
import type { PluginContext } from "../packages/plugin-sdk/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { concurrentDownloads, parseConcurrentDownloadsLimit } from "./download-limits.js";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("download concurrency ceiling", () => {
  it.each([undefined, "", "bad", "0", "-1", "1.5", "Infinity", "9007199254740992"])("defaults invalid ceiling %s to 8", (value) => {
    expect(parseConcurrentDownloadsLimit(value)).toBe(8);
  });
  it("accepts higher ceilings and clamps malformed persisted settings", () => {
    expect(parseConcurrentDownloadsLimit("32")).toBe(32);
    expect(concurrentDownloads(25, 32)).toBe(25);
    expect(concurrentDownloads(40, 32)).toBe(32);
    expect(concurrentDownloads(2.9, 32)).toBe(2);
    expect(concurrentDownloads("bad", 32)).toBe(2);
    expect(concurrentDownloads(-1, 32)).toBe(1);
  });
  it("actually starts more than eight downloads without exceeding the configured ceiling", async () => {
    vi.stubEnv("EASYX_MAX_CONCURRENT_DOWNLOADS_LIMIT", "12"); vi.resetModules();
    const { DownloadQueue } = await import("./downloader.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-concurrency-")); const db = new Database(root);
    const person = db.createPerformer({ name: "Alice" });
    const source = db.addSource(person.id, "test", { externalId: "s", label: "s", profileUrl: "https://test.test/alice", domain: "test.test" });
    db.updateSettings({ autoQueueDiscovered: true, maxConcurrentDownloads: 24 });
    db.ingestItems(source, Array.from({ length: 15 }, (_, n) => ({ externalId: String(n), mediaType: "video" as const })));
    const plugins = {
      get: () => ({ resolveDownload: (context: PluginContext) => new Promise((_resolve, reject) => context.signal!.addEventListener("abort", () => reject(new Error("Stopped")), { once: true })) }),
      context: (_id: string, signal: AbortSignal) => ({ signal }),
    } as unknown as PluginManager;
    const queue = new DownloadQueue(db, plugins, path.join(root, "media"));
    try {
      queue.start();
      expect(db.listItems().filter((item) => item.status === "downloading")).toHaveLength(12);
      expect(db.listItems().filter((item) => item.status === "queued")).toHaveLength(3);
    } finally {
      queue.stop(); await new Promise((resolve) => setImmediate(resolve)); db.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("uses the environment ceiling for API validation and the queue", async () => {
    vi.stubEnv("EASYX_MAX_CONCURRENT_DOWNLOADS_LIMIT", "24"); vi.resetModules();
    const { settingsSchema } = await import("./output-settings.js");
    const { concurrentDownloads, maxConcurrentDownloadsLimit } = await import("./download-limits.js");
    expect(maxConcurrentDownloadsLimit).toBe(24);
    expect(settingsSchema.safeParse({ maxConcurrentDownloads: 24 }).success).toBe(true);
    for (const value of [0, 25, 2.5]) expect(settingsSchema.safeParse({ maxConcurrentDownloads: value }).success).toBe(false);
    expect(concurrentDownloads(100)).toBe(24);
  });
});

/**
 * The capture pool has its own load gate: starting a capture on a saturated box makes the
 * saturation worse, and the broadcast is still there a second later. It must refuse to start --
 * not stop what is running -- and it must start again the moment the load drops.
 */
describe("capture start gate", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function liveQueue(root: string) {
    const { DownloadQueue } = await import("./downloader.js");
    const db = new Database(root);
    // Three different rooms: the queue allows only one capture per source, so three items on one
    // source would collapse into a duplicate pair before the gate could ever be observed.
    db.updateSettings({ maxConcurrentRecordings: 2 });
    for (const room of ["anna", "bea", "cora"]) {
      const person = db.createPerformer({ name: "Performer " + room });
      const source = db.addSource(person.id, "test", { externalId: room, label: room, profileUrl: "https://test.test/" + room, domain: "test.test" });
      db.updateSource(source.id, { autoDownload: true });
      // ingestItems reads autoDownload off the Source it is handed, so pass the updated row: a live
      // candidate only queues when its own source opted in.
      db.ingestItems(db.getSource(source.id)!, [{ externalId: "live-" + room, mediaType: "video" as const, metadata: { live: true } }]);
    }
    const plugins = {
      get: () => ({ resolveDownload: (context: PluginContext) => new Promise((_resolve, reject) => context.signal!.addEventListener("abort", () => reject(new Error("Stopped")), { once: true })) }),
      context: (_id: string, signal: AbortSignal) => ({ signal }),
    } as unknown as PluginManager;
    const queue = new DownloadQueue(db, plugins, path.join(root, "media"));
    return { db, queue };
  }

  it("starts no capture while the box is overloaded, and starts them once it is not", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-capture-gate-"));
    vi.spyOn(os, "cpus").mockReturnValue(new Array(1).fill({}) as os.CpuInfo[]);
    const load = vi.spyOn(os, "loadavg").mockReturnValue([3, 3, 3]);
    const { db, queue } = await liveQueue(root);
    try {
      queue.start();
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(db.listItems().filter((item) => item.status === "downloading")).toHaveLength(0);
      expect(db.listItems().filter((item) => item.status === "queued")).toHaveLength(3);

      load.mockReturnValue([0.2, 0.2, 0.2]);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(db.listItems().filter((item) => item.status === "downloading")).toHaveLength(2);
    } finally {
      queue.stop(); await new Promise((resolve) => setImmediate(resolve));
      db.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
