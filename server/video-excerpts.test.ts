import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { DownloadQueue } from "./downloader.js";
import { PluginManager } from "./plugin-manager.js";
import { fingerprintVideo, videoFileStamp } from "./video-matching.js";

const assets = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-excerpt-assets-"));
const fullFile = path.join(assets, "full.mp4"); const clipFile = path.join(assets, "clip.mp4");
const cleanup: Array<() => void> = [];
beforeAll(() => {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=40", "-vf", "hue=h=6*t,rotate=0.07*t", "-c:v", "libx264", "-preset", "ultrafast", fullFile]);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", "7.25", "-i", fullFile, "-t", "16", "-vf", "scale=160:120", "-c:v", "libx264", "-crf", "26", clipFile]);
}, 30_000);
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
afterAll(() => fs.rmSync(assets, { recursive: true, force: true }));

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-excerpts-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const media = path.join(root, "media"); fs.mkdirSync(media);
  const pluginRoot = path.join(root, "plugins", "test"); fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "index.mjs"), `export default { manifest: { id: 'test.excerpts', name: 'Excerpts', version: '1', description: 'Test', author: 'Test', capabilities: ['download-resolver'] }, resolveDownload: async (_context,item) => ({kind:'command', command: process.execPath, args: ['-e', 'require("node:fs").copyFileSync(process.argv[1],process.argv[2])', item.metadata.file, '{output}'], filename:item.filename}) };`);
  const db = new Database(root); cleanup.push(() => db.close());
  const plugins = new PluginManager(db, [path.join(root, "plugins")]); await plugins.load(); plugins.install("test.excerpts");
  db.updateSettings({ autoQueueDiscovered: false });
  const performer = db.createPerformer({ name: "Example" });
  const source = db.addSource(performer.id, "test.excerpts", { externalId: "s", label: "Source", profileUrl: "https://example.test", domain: "example.test" });
  const add = (id: string, file: string, qualityScore = 0) => {
    db.ingestItems(source, [{ externalId: id, filename: `${id}.mp4`, mediaType: "video", qualityScore, publishedAt: "2020-01-01T00:00:00Z", metadata: { file } }]);
    return db.getItemBySourceExternalId(source.id, id)!;
  };
  const queue = new DownloadQueue(db, plugins, media); cleanup.push(() => queue.stop());
  const download = async (id: string) => {
    db.setItemStatus(id, "queued"); queue.start();
    try {
      const deadline = Date.now() + 15_000;
      while (!["completed", "duplicate", "failed"].includes(db.getItem(id)!.status)) {
        if (Date.now() > deadline) throw new Error("Video finalization timed out");
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      const done = db.getItem(id)!; expect(done.error).toBeUndefined(); return done;
    } finally { queue.stop(); }
  };
  return { root, media, db, performer, source, add, download };
}

describe("downloaded video excerpts", () => {
  it("discards a new excerpt, retains the original unchanged, and remembers it across rediscovery/restart", async () => {
    const { root, media, db, source, add, download } = await fixture();
    const original = add("full", fullFile, 100);
    const saved = path.join(media, "full.mp4"); fs.copyFileSync(fullFile, saved);
    db.setItemStatus(original.id, "completed", { storagePath: "full.mp4" });
    const stamp = videoFileStamp(saved); const bytes = fs.readFileSync(saved);
    // Deliberately higher advertised quality: an excerpt must not replace the full video.
    const clip = add("excerpt", clipFile, 100_000);
    const done = await download(clip.id);
    expect(done).toMatchObject({ status: "duplicate", duplicateOf: original.id, duplicateReason: "contained-excerpt", progress: 1 });
    expect(done.storagePath).toBeUndefined();
    expect(videoFileStamp(saved)).toBe(stamp); expect(fs.readFileSync(saved).equals(bytes)).toBe(true);
    expect(db.getItem(original.id)).toMatchObject({ status: "completed", publishedAt: "2020-01-01T00:00:00.000Z" });
    expect(db.getVideoFingerprint(original.id, stamp)?.duration).toBe(40);
    expect(fs.readdirSync(path.join(media, ".downloads"))).toEqual([]);
    expect(db.ingestItems(source, [{ externalId: "excerpt", mediaType: "video" }])).toEqual({ added: 0, upgraded: 0, skipped: 1 });
    const reopened = new Database(root);
    expect(reopened.getItem(clip.id)?.duplicateReason).toBe("contained-excerpt");
    expect(reopened.getVideoFingerprint(original.id, stamp)?.duration).toBe(40);
    reopened.close();
  }, 20_000);
  it("keeps the clip if the supposed full video is missing or belongs to another performer", async () => {
    const { media, db, add, download } = await fixture();
    const missing = add("missing", fullFile);
    db.setItemStatus(missing.id, "completed", { storagePath: "missing.mp4" });
    const other = db.createPerformer({ name: "Other" });
    const source = db.addSource(other.id, "test.excerpts", { externalId: "other", label: "Other", profileUrl: "https://example.test/other", domain: "example.test" });
    db.ingestItems(source, [{ externalId: "full", mediaType: "video" }]);
    const original = db.getItemBySourceExternalId(source.id, "full")!;
    fs.copyFileSync(fullFile, path.join(media, "other.mp4"));
    db.setItemStatus(original.id, "completed", { storagePath: "other.mp4" });
    const clip = add("excerpt", clipFile);
    const done = await download(clip.id);
    expect(done.status).toBe("completed");
    expect(fs.existsSync(path.join(media, done.storagePath!))).toBe(true);
    expect(db.getVideoFingerprint(done.id, videoFileStamp(path.join(media, done.storagePath!)))?.duration).toBe(16);
  });
  it("invalidates fingerprints when a stored file changes and clears an excerpt marker on an explicit retry", async () => {
    const { media, db, add, download } = await fixture();
    const original = add("full", fullFile);
    const saved = path.join(media, "full.mp4"); fs.copyFileSync(fullFile, saved);
    db.setItemStatus(original.id, "completed", { storagePath: "full.mp4" });
    const stamp = videoFileStamp(saved);
    db.setVideoFingerprint(original.id, stamp, await fingerprintVideo(saved, AbortSignal.timeout(10_000)));
    fs.copyFileSync(clipFile, saved);
    expect(db.getVideoFingerprint(original.id, videoFileStamp(saved))).toBeUndefined();
    const clip = add("excerpt", clipFile);
    db.markVideoExcerpt(clip.id, original.id, "previous-checksum");
    const done = await download(clip.id);
    expect(done.status).toBe("completed");
    expect(done.duplicateReason).toBeUndefined(); expect(done.duplicateOf).toBeUndefined();
    expect(db.getVideoFingerprint(original.id, videoFileStamp(saved))?.duration).toBe(16);
  }, 20_000);
  it("keeps unsupported videos instead of failing a successful download", async () => {
    const { root, media, add, download } = await fixture();
    const broken = path.join(root, "opaque.mp4"); fs.writeFileSync(broken, "opaque data");
    const done = await download(add("opaque", broken).id);
    expect(done.status).toBe("completed");
    expect(fs.readFileSync(path.join(media, done.storagePath!), "utf8")).toBe("opaque data");
  });
});
