import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { DownloadQueue, concurrentLimit, httpStatusFromError, postProcessDeadlineMs, retryDisposition, slotPlan, stalledDownload } from "./downloader.js";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";
import { safeSegment } from "./utils.js";

const dirs: string[] = [];
// Windows keeps a temp tree locked for a moment after SQLite handles and spawned children go
// away, so rmSync can throw EPERM. An unclean temp directory is harmless while a throwing
// afterEach would mark a passing test as failed and hide the result that matters.
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS temp cleaner gets it later */ }
  }
});
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

describe("DownloadQueue", () => {
  it("keeps an active download under media/.downloads until it is complete", async () => {
    const dataDir = temp("easyx-staging-data"); const mediaDir = temp("easyx-staging-media"); const pluginDir = temp("easyx-staging-plugins");
    let finishResponse: (() => void) | undefined;
    const server = http.createServer((_request, response) => {
      response.setHeader("content-length", "10");
      response.write("first");
      finishResponse = () => response.end("last!");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.staging", name: "Staging", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.staging", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Staging Performer" }, "test.staging");
    const source = db.addSource(person.id, "test.staging", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "asset", mediaType: "video", filename: "asset.mp4", metadata: { url: `http://127.0.0.1:${address.port}/asset.mp4` } }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    const staged = path.join(mediaDir, ".downloads", item.id, "asset.mp4");
    const completed = path.join(mediaDir, "Staging Performer", "example.test", "asset.mp4");
    await waitFor(() => fs.existsSync(staged) && fs.statSync(staged).size === 5);
    expect(fs.existsSync(completed)).toBe(false);
    finishResponse?.();
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop(); server.close();
    expect(fs.readFileSync(completed, "utf8")).toBe("firstlast!");
    expect(fs.existsSync(path.dirname(staged))).toBe(false);
  });

  it("restarts an interrupted download after the server starts again", async () => {
    const dataDir = temp("easyx-restart-data"); const mediaDir = temp("easyx-restart-media"); const pluginDir = temp("easyx-restart-plugins");
    const server = http.createServer((_request, response) => response.end("fresh media"));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.restart", name: "Restart", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.restart", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Restart Performer" }, "test.restart");
    const source = db.addSource(person.id, "test.restart", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "asset", mediaType: "video", filename: "asset.mp4", metadata: { url: `http://127.0.0.1:${address.port}/asset.mp4` } }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "downloading", { progress: 0.5 });
    const staleDirectory = path.join(mediaDir, ".downloads", item.id);
    fs.mkdirSync(staleDirectory, { recursive: true }); fs.writeFileSync(path.join(staleDirectory, "asset.mp4"), "stale partial media");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop(); server.close();
    expect(fs.readFileSync(path.join(mediaDir, "Restart Performer", "example.test", "asset.mp4"), "utf8")).toBe("fresh media");
    expect(fs.existsSync(staleDirectory)).toBe(false);
  });

  // A9 scaffolding: a plugin that serves the item from a scripted local HTTP server, with a
  // fast retry base so a scheduled retry lands inside the waitFor window.
  async function resumeFixture(serverHandler: (request: http.IncomingMessage, response: http.ServerResponse, attempt: number) => void) {
    const dataDir = temp("easyx-resume-data"); const mediaDir = temp("easyx-resume-media"); const pluginDir = temp("easyx-resume-plugins");
    let attempt = 0;
    const server = http.createServer((request, response) => { attempt += 1; serverHandler(request, response, attempt); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.resume", name: "Resume", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.resume", { installed: true, enabled: true });
    db.updateSettings({ downloadRetryBaseSeconds: 1 });
    const person = db.upsertPerformer({ externalId: "person", name: "Resume Performer" }, "test.resume");
    const source = db.addSource(person.id, "test.resume", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "asset", mediaType: "video", filename: "asset.mp4", metadata: { url: `http://127.0.0.1:${address.port}/asset.mp4` } }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    return { db, queue, server, item, mediaDir, address };
  }

  it("resumes an interrupted download with a Range request instead of starting over", async () => {
    const ranges: Array<string | undefined> = [];
    const { db, queue, server, item, mediaDir } = await resumeFixture((request, response, attempt) => {
      ranges.push(request.headers.range);
      if (attempt === 1) {
        // Die mid-body: 5 of 10 bytes delivered, then the connection drops.
        response.setHeader("content-length", "10");
        response.write("first");
        setTimeout(() => response.destroy(), 30);
      } else {
        response.writeHead(206, { "content-length": "5", "content-range": "bytes 5-10/10" });
        response.end("last!");
      }
    });
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop(); server.close();
    // First attempt carried no Range, the retry continued from the 5 staged bytes, and the
    // final file is byte-identical to the full resource.
    expect(ranges[0]).toBeUndefined();
    expect(ranges[1]).toBe("bytes=5-");
    expect(fs.readFileSync(path.join(mediaDir, "Resume Performer", "example.test", "asset.mp4"), "utf8")).toBe("firstlast!");
    expect(fs.existsSync(path.join(mediaDir, ".downloads", item.id))).toBe(false);
  });

  it("falls back to a full download when the server ignores the Range header", async () => {
    const { db, queue, server, item, mediaDir } = await resumeFixture((request, response, attempt) => {
      void request.headers.range; // sent, but the server answers 200 with the whole body
      if (attempt === 1) {
        response.setHeader("content-length", "10");
        response.write("first");
        setTimeout(() => response.destroy(), 30);
      } else {
        response.writeHead(200, { "content-length": String("fresh media!".length) });
        response.end("fresh media!");
      }
    });
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop(); server.close();
    // The 200 truncated the partial file and replaced it wholesale -- no stitched bytes.
    expect(fs.readFileSync(path.join(mediaDir, "Resume Performer", "example.test", "asset.mp4"), "utf8")).toBe("fresh media!");
  });

  it("refuses a 206 that starts beyond the staged bytes instead of writing a gapped file", async () => {
    const { db, queue, server, item } = await resumeFixture((request, response, attempt) => {
      if (attempt === 1) {
        response.setHeader("content-length", "10");
        response.write("first");
        setTimeout(() => response.destroy(), 30);
      } else {
        // The server claims to resume from byte 7 while staging holds 5: appending would
        // leave a hole. The queue must fail the item rather than corrupt the media.
        response.writeHead(206, { "content-length": "3", "content-range": "bytes 7-10/10" });
        response.end("st!");
      }
    });
    // Two attempts: the first stages 5 bytes and dies, the second gets the unusable 206.
    db.updateSettings({ downloadRetryAttempts: 2 });
    await waitFor(() => (db.getItem(item.id)?.error ?? "").includes("cannot be filled"));
    queue.stop(); server.close();
    expect(db.getItem(item.id)?.status).toBe("failed");
    expect(db.getItem(item.id)?.error ?? "").toContain("cannot be filled");
  });

  it("stores by performer/domain and removes byte-identical duplicates", async () => {
    const dataDir = temp("easyx-data"); const mediaDir = temp("easyx-media"); const pluginDir = temp("easyx-plugins");
    const server = http.createServer((_request, response) => { response.setHeader("content-length", "11"); response.end("hello media"); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
    const url = `http://127.0.0.1:${address.port}/asset.jpg`;
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.download", name: "Test", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.download", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "A/B Performer" }, "test.download");
    const source = db.addSource(person.id, "test.download", { externalId: "source", label: "Source", profileUrl: "https://www.Example.test/profile", domain: "example.test" });
    db.ingestItems(source, [
      { externalId: "one", mediaType: "image", filename: "one.jpg", publishedAt: "2024-01-01T00:00:00Z", metadata: { url } },
      { externalId: "two", mediaType: "image", filename: "two.jpg", publishedAt: "2020-01-01T00:00:00Z", metadata: { url } },
    ]);
    for (const item of db.listItems()) db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => db.listItems().every((item) => ["completed", "duplicate"].includes(item.status)));
    queue.stop(); server.close();
    expect(db.listItems().filter((item) => item.status === "completed")).toHaveLength(1);
    expect(db.listItems().filter((item) => item.status === "duplicate")).toHaveLength(1);
    const completed = db.listItems().find((item) => item.status === "completed")!;
    expect(completed.publishedAt).toBe("2020-01-01T00:00:00.000Z");
    const files = fs.readdirSync(path.join(mediaDir, "A-B Performer", "example.test"));
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(mediaDir, "A-B Performer", "example.test", files[0])).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(fs.readdirSync(path.join(mediaDir, ".downloads"))).toEqual([]);
  });

  it("accepts trusted command-based extractor downloads", async () => {
    const dataDir = temp("easyx-command-data"); const mediaDir = temp("easyx-command-media"); const pluginDir = temp("easyx-command-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.command", name: "Command", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload() { return { kind: "command", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'command media')", "{output}"], filename: "clip.mp4" }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.command", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Command Performer" }, "test.command");
    const source = db.addSource(person.id, "test.command", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "clip", pageUrl: "https://example.test/clip", mediaType: "video", filename: "clip.mp4", publishedAt: "2021-03-04T12:30:00Z" }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop();
    const completed = path.join(mediaDir, "Command Performer", "example.test", "clip.mp4");
    expect(fs.readFileSync(completed, "utf8")).toBe("command media");
    expect(fs.statSync(completed).mtime.toISOString()).toBe("2021-03-04T12:30:00.000Z");
  });

  it("persists command extractor percentage and downloaded bytes while running", async () => {
    const dataDir = temp("easyx-progress-data"); const mediaDir = temp("easyx-progress-media"); const pluginDir = temp("easyx-progress-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.progress", name: "Progress", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload() { return { kind: "command", command: process.execPath, args: ["-e", "const fs=require('node:fs'),file=process.argv[1];process.stdout.write('easyx-bytes:5:10');setTimeout(()=>{fs.writeFileSync(file,'1234567890');process.stdout.write('easyx-progress: 100%')},700)", "{output}"], filename: "progress.mp4" }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.progress", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Progress Performer" }, "test.progress");
    const source = db.addSource(person.id, "test.progress", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "progress", pageUrl: "https://example.test/progress", mediaType: "video", filename: "progress.mp4", expectedBytes: 10 }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => { const active = db.getItem(item.id); return active?.status === "downloading" && active.progress >= 0.5 && active.downloadedBytes >= 5; });
    const active = db.getItem(item.id)!;
    expect(active.progress).toBeGreaterThanOrEqual(0.5); expect(active.progress).toBeLessThan(1); expect(active.downloadedBytes).toBe(5);
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop();
    expect(db.getItem(item.id)).toMatchObject({ progress: 1, downloadedBytes: 10 });
  });

  it("expands command output directory and filename placeholders", async () => {
    const dataDir = temp("easyx-command-parts-data"); const mediaDir = temp("easyx-command-parts-media"); const pluginDir = temp("easyx-command-parts-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.command-parts", name: "Command parts", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload() { return { kind: "command", command: process.execPath, args: ["-e", "const fs=require('node:fs'),p=require('node:path');fs.writeFileSync(p.join(process.argv[1],process.argv[2]),'parts media')", "{outputDir}", "{outputName}"], filename: "parts.mp4" }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.command-parts", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Parts Performer" }, "test.command-parts");
    const source = db.addSource(person.id, "test.command-parts", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "parts", pageUrl: "https://example.test/parts", mediaType: "video", filename: "parts.mp4" }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    await waitFor(() => db.getItem(item.id)?.status === "completed"); queue.stop();
    expect(fs.readFileSync(path.join(mediaDir, "Parts Performer", "example.test", "parts.mp4"), "utf8")).toBe("parts media");
  });

  it("pauses, resumes, stops, and deletes an active recording", async () => {
    const dataDir = temp("easyx-controls-data"); const mediaDir = temp("easyx-controls-media"); const pluginDir = temp("easyx-controls-plugins");
    const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
    const recorder = "const fs=require('node:fs'),file=process.argv[1];fs.writeFileSync(file,'start');const timer=setInterval(()=>fs.appendFileSync(file,'x'),50);process.on('SIGINT',()=>{clearInterval(timer);process.exit(0)})";
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.controls", name: "Controls", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload() { return { kind: "command", command: process.execPath, args: ["-e", ${JSON.stringify(recorder)}, "{output}"], filename: "recording.mp4" }; } };`);
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    db.setPluginState("test.controls", { installed: true, enabled: true });
    const person = db.upsertPerformer({ externalId: "person", name: "Live Performer" }, "test.controls");
    const source = db.addSource(person.id, "test.controls", { externalId: "source", label: "Live", profileUrl: "https://example.test/live", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "recording", pageUrl: "https://example.test/live", mediaType: "video", filename: "recording.mp4" }]);
    const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
    const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
    const staged = path.join(mediaDir, ".downloads", item.id, "recording.mp4");
    await waitFor(() => fs.existsSync(staged) && fs.statSync(staged).size > 5);
    queue.pause(item.id); expect(db.getItem(item.id)?.status).toBe("paused");
    const pausedSize = fs.statSync(staged).size; await new Promise((resolve) => setTimeout(resolve, 180));
    // Windows has no SIGSTOP/SIGCONT, so a paused child keeps running there; only assert
    // the freeze where the signal is actually honoured (Linux deployment target).
    if (process.platform !== "win32") expect(fs.statSync(staged).size).toBe(pausedSize);
    queue.resume(item.id); await waitFor(() => fs.statSync(staged).size > pausedSize); expect(db.getItem(item.id)?.status).toBe("downloading");
    queue.stopRecording(item.id); expect(db.getItem(item.id)?.status).toBe("stopping");
    await waitFor(() => db.getItem(item.id)?.status === "completed");
    expect(fs.statSync(path.join(mediaDir, "Live Performer", "example.test", "recording.mp4")).size).toBeGreaterThan(pausedSize);

    db.ingestItems(source, [{ externalId: "delete-me", pageUrl: "https://example.test/live", mediaType: "video", filename: "delete-me.mp4" }]);
    const doomed = db.getItemBySourceExternalId(source.id, "delete-me")!; db.setItemStatus(doomed.id, "queued");
    await waitFor(() => db.getItem(doomed.id)?.status === "downloading"); queue.delete(doomed.id);
    await waitFor(() => db.getItem(doomed.id) === undefined); queue.stop();
    expect(fs.existsSync(path.join(mediaDir, ".downloads", doomed.id))).toBe(false);
  });

  it("deletes both a completed item and its recorded media file", async () => {
    const dataDir = temp("easyx-completed-delete-data"); const mediaDir = temp("easyx-completed-delete-media"); const pluginDir = temp("easyx-completed-delete-plugins");
    const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
    const person = db.upsertPerformer({ externalId: "person", name: "Recorded Performer" }, "test.completed-delete");
    const source = db.addSource(person.id, "test.completed-delete", { externalId: "source", label: "Live", profileUrl: "https://example.test/live", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "recording", mediaType: "video", filename: "recording.mp4" }]);
    const item = db.listItems()[0]; const relativePath = "Recorded Performer/example.test/recording.mp4";
    db.setItemStatus(item.id, "completed", { progress: 1, storagePath: relativePath });
    const file = path.join(mediaDir, ...relativePath.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "recording");
    const libraryDb = new LibraryDatabase(dataDir); const catalog = new Catalog(libraryDb, mediaDir, dataDir, false); await catalog.scan();
    const queue = new DownloadQueue(db, manager, mediaDir, undefined, undefined, (completed) => catalog.deleteStoredMedia(completed.storagePath!));

    expect(queue.delete(item.id)).toMatchObject({ deleted: true, id: item.id, bytes: 9, missing: false });
    expect(db.getItem(item.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    expect(libraryDb.listMedia().total).toBe(0);
    libraryDb.close();
  });
});

describe("stalledDownload", () => {
  const idle = { encoding: false, paused: false } as const;
  const timeout = 120_000;

  it("never reports a stall while a live capture is being remuxed or re-encoded", () => {
    // Post-processing reports no progress for minutes on end: ffmpeg frame counters are not
    // relayed as download progress, so `lastActivity` is frozen for the whole step.
    expect(stalledDownload({ ...idle, encoding: true }, 0, 60 * 60_000, timeout)).toBe(false);
  });

  it("still reports a stall for a download that has gone quiet", () => {
    expect(stalledDownload(idle, 0, timeout, timeout)).toBe(false);
    expect(stalledDownload(idle, 0, timeout + 1, timeout)).toBe(true);
  });

  it("leaves paused, stopped and cancelled items to their own handling", () => {
    const now = timeout * 2;
    expect(stalledDownload({ ...idle, paused: true }, 0, now, timeout)).toBe(false);
    expect(stalledDownload({ ...idle, action: "stop" }, 0, now, timeout)).toBe(false);
    expect(stalledDownload({ ...idle, action: "cancel" }, 0, now, timeout)).toBe(false);
  });
});

describe("postProcessDeadlineMs", () => {
  it("scales with the capture size, with an 8 minute floor and a 45 minute cap", () => {
    expect(postProcessDeadlineMs(0)).toBe(8 * 60_000);
    expect(postProcessDeadlineMs(2 * 1024 ** 3)).toBe(512_000);       // 2 GiB at 4 MiB/s
    expect(postProcessDeadlineMs(100 * 1024 ** 3)).toBe(45 * 60_000); // capped
  });

  it("gives a multi-GB remux far more room than the download stall timeout", () => {
    // The regression: a ~2 GB capture was SIGKILLed mid-remux at ~122s, i.e. right on the
    // 120s download stall timeout, and the whole recording was written off as failed.
    expect(postProcessDeadlineMs(2 * 1024 ** 3)).toBeGreaterThan(120_000 * 2);
  });
});

describe("retryDisposition", () => {
  it("reads the HTTP status out of the shapes the download paths actually emit", () => {
    expect(httpStatusFromError("Download returned HTTP 404")).toBe(404);
    expect(httpStatusFromError("ffmpeg: Server returned 403 Forbidden")).toBe(403);
    expect(httpStatusFromError("ERROR: unable to download video data: HTTP Error 410: Gone")).toBe(410);
    expect(httpStatusFromError("Download failed: status code 500")).toBe(500);
    expect(httpStatusFromError("ETIMEDOUT: connection timed out")).toBeUndefined();
    expect(httpStatusFromError("got 200 OK")).toBeUndefined(); // a 2xx is not a failure status
  });

  it("fails a gone media URL immediately, never retrying it", () => {
    expect(retryDisposition("Download returned HTTP 404", 1)).toBe("permanent");
    expect(retryDisposition("Server returned 410 Gone", 1)).toBe("permanent");
  });

  it("gives a 403 exactly one retry before giving up", () => {
    // First failure: many CDNs 403 an expired signed URL, which a fresh resolve fixes.
    expect(retryDisposition("Server returned 403 Forbidden", 1)).toBe("retry");
    // Second failure: it is genuinely forbidden, so stop burning a slot.
    expect(retryDisposition("Server returned 403 Forbidden", 2)).toBe("permanent");
  });

  it("keeps network errors, 5xx and stalls retryable", () => {
    expect(retryDisposition("Download timed out (no progress received within the configured stall timeout).", 1)).toBe("retry");
    expect(retryDisposition("ECONNRESET", 1)).toBe("retry");
    expect(retryDisposition("Server returned 503 Service Unavailable", 1)).toBe("retry");
    expect(retryDisposition("Server returned 500", 4)).toBe("retry");
    // A message with no status at all must never be judged permanent.
    expect(retryDisposition("Extractor completed without producing a media file", 5)).toBe("retry");
  });
});

it("runs a recording and a download side by side, one slot per pool", async () => {
  const dataDir = temp("easyx-pools-data"); const mediaDir = temp("easyx-pools-media"); const pluginDir = temp("easyx-pools-plugins");
  const releases: Array<() => void> = [];
  const server = http.createServer((request, response) => {
    response.setHeader("content-length", "10");
    response.write("first");
    // Different tail per endpoint so the two finished files are not byte-identical
    // (identical content would be stored as a duplicate rather than completed).
    releases.push(() => response.end(request.url?.includes("live") ? "live!" : "last!"));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
  const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.pools", name: "Pools", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
  const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
  db.setPluginState("test.pools", { installed: true, enabled: true });
  // One slot per pool. While both pools shared a single counter, the second item here
  // stayed queued until the first finished, which is exactly the starvation this fixes.
  db.updateSettings({ maxConcurrentDownloads: 1, maxConcurrentRecordings: 1, autoRecordMinBytes: 0 });
  const person = db.upsertPerformer({ externalId: "person", name: "Pool Performer" }, "test.pools");
  const source = db.addSource(person.id, "test.pools", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
  db.ingestItems(source, [
    { externalId: "live-asset", mediaType: "video", filename: "live-asset.mp4", metadata: { url: `http://127.0.0.1:${address.port}/live.mp4`, live: true } },
    { externalId: "plain-asset", mediaType: "video", filename: "plain-asset.mp4", metadata: { url: `http://127.0.0.1:${address.port}/plain.mp4` } },
  ]);
  const items = db.listItems();
  const recording = items.find((entry) => entry.externalId === "live-asset"); const download = items.find((entry) => entry.externalId === "plain-asset");
  if (!recording || !download) throw new Error("Missing ingested items");
  for (const item of items) db.setItemStatus(item.id, "queued");
  const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
  const staged = (item: { id: string; filename?: string }) => path.join(mediaDir, ".downloads", item.id, item.filename ?? "");
  try {
    await waitFor(() => fs.existsSync(staged(recording)) && fs.existsSync(staged(download)));
    expect(db.getItem(recording.id)?.status).toBe("downloading");
    expect(db.getItem(download.id)?.status).toBe("downloading");
    for (const release of releases) release();
    await waitFor(() => db.getItem(recording.id)?.status === "completed" && db.getItem(download.id)?.status === "completed");
    expect(fs.readFileSync(path.join(mediaDir, "Pool Performer", "example.test", "live-asset.mp4"), "utf8")).toBe("firstlive!");
    expect(fs.readFileSync(path.join(mediaDir, "Pool Performer", "example.test", "plain-asset.mp4"), "utf8")).toBe("firstlast!");
  } finally { queue.stop(); server.close(); }
});

it("moves a tiny auto-ended live recording to recovery as a fragment (C3)", async () => {
  const dataDir = temp("easyx-fragment-data"); const mediaDir = temp("easyx-fragment-media"); const pluginDir = temp("easyx-fragment-plugins");
  const releases: Array<() => void> = [];
  const server = http.createServer((request, response) => {
    response.setHeader("content-length", "10");
    response.write("first");
    releases.push(() => response.end(request.url?.includes("live") ? "live!" : "last!"));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
  const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default { manifest: { id: "test.frag", name: "Frag", version: "1", description: "Test", author: "Test", capabilities: ["download-resolver"] }, async resolveDownload(_context, item) { return { url: item.metadata.url, filename: item.filename }; } };`);
  const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load();
  db.setPluginState("test.frag", { installed: true, enabled: true });
  // A small threshold so the tiny test capture is treated as a fragment rather than a real clip.
  db.updateSettings({ maxConcurrentRecordings: 1, autoRecordMinBytes: 100 });
  const person = db.upsertPerformer({ externalId: "person", name: "Frag Performer" }, "test.frag");
  const source = db.addSource(person.id, "test.frag", { externalId: "source", label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
  db.ingestItems(source, [{ externalId: "live-asset", mediaType: "video", filename: "live-asset.mp4", metadata: { url: `http://127.0.0.1:${address.port}/live.mp4`, live: true } }]);
  const item = db.listItems()[0]; db.setItemStatus(item.id, "queued");
  const queue = new DownloadQueue(db, manager, mediaDir); queue.start();
  const recovery = path.join(mediaDir, ".recording-recovery", safeSegment(item.id), "recovered.mp4");
  const staged = path.join(mediaDir, ".downloads", item.id, "live-asset.mp4");
  try {
    // Let the request reach the server first, then let the response finish.
    await waitFor(() => fs.existsSync(staged));
    for (const release of releases) release();
    // The capture ended on its own below the size floor: flagged as a fragment and moved to
    // recovery, never cataloged as a finished download.
    await waitFor(() => db.getItem(item.id)?.metadata.fragment === true);
    expect(db.getItem(item.id)?.status).toBe("failed");
    expect(fs.existsSync(recovery)).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, "Frag Performer", "example.test", "live-asset.mp4"))).toBe(false);
  } finally { queue.stop(); server.close(); }
});

describe("concurrentLimit", () => {
  it("keeps downloads inside their historical 1..8 range", () => {
    expect(concurrentLimit(2, 2, 8)).toBe(2);
    expect(concurrentLimit(99, 2, 8)).toBe(8);
    expect(concurrentLimit(0, 2, 8)).toBe(1);
    expect(concurrentLimit(-4, 2, 8)).toBe(1);
  });

  it("lets recordings reach 32 but never beyond", () => {
    expect(concurrentLimit(8, 8, 32)).toBe(8);
    expect(concurrentLimit(32, 8, 32)).toBe(32);
    expect(concurrentLimit(1000, 8, 32)).toBe(32);
  });

  it("falls back and truncates for values that are not whole numbers", () => {
    expect(concurrentLimit(undefined, 8, 32)).toBe(8);
    expect(concurrentLimit(Number.NaN, 2, 8)).toBe(2);
    expect(concurrentLimit("6", 2, 8)).toBe(6);
    expect(concurrentLimit(3.7, 2, 8)).toBe(3);
  });
});

describe("slotPlan", () => {
  it("offers every free slot in both pools", () => {
    expect(slotPlan({ recordings: 0, downloads: 0 }, { recordings: 2, downloads: 2 }))
      .toEqual(["recording", "recording", "download", "download"]);
  });

  it("keeps a saturated recording pool from consuming download slots", () => {
    // The regression: one shared pool meant eight running broadcasts left no room for
    // anything else, and equally a backfill could keep a live room unrecorded.
    expect(slotPlan({ recordings: 8, downloads: 0 }, { recordings: 8, downloads: 2 }))
      .toEqual(["download", "download"]);
    expect(slotPlan({ recordings: 0, downloads: 2 }, { recordings: 8, downloads: 2 }))
      .toEqual(["recording", "recording", "recording", "recording", "recording", "recording", "recording", "recording"]);
  });

  it("offers nothing once both pools are full", () => {
    expect(slotPlan({ recordings: 32, downloads: 8 }, { recordings: 32, downloads: 8 })).toEqual([]);
  });
});
