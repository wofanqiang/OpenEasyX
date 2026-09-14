import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "./database.js";
import { LiveCamImages } from "./live-cam-images.js";
import { isSafeImageUrl } from "./live-cam-images.js";
import type { PluginManager } from "./plugin-manager.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-portraits-")); roots.push(root);
  const db = new Database(root); const performer = db.createPerformer({ name: "alice", imageUrl: "https://provider.test/logo.jpg" });
  const image = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=128x128", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
  const request = vi.fn(async (url: string) => url.endsWith("/alice")
    ? new Response('<meta property="og:image" content="https://images.test/alice.png">')
    : new Response(image, { headers: { "content-type": "image/png" } }));
  const plugins = { context: () => ({ fetch: request, config: {} }) } as unknown as PluginManager;
  const directory = path.join(root, "performer-images");
  return { db, performer, request, directory, images: new LiveCamImages(db, plugins, directory), cam: { id: "alice", username: "alice", pageUrl: "https://provider.test/alice" } };
}

describe("Locally stored live performer portraits", () => {
  it("fetches and decodes a provider portrait once and persists it across restarts", async () => {
    const { db, performer, request, directory, images, cam } = fixture();
    await Promise.all([images.ensure("test", cam, performer), images.ensure("test", cam, performer)]);
    const stored = db.getPerformer(performer.id)!;
    expect(stored.imageUrl).toBe(`/api/performers/${performer.id}/image`);
    expect(fs.readFileSync(path.join(directory, `${performer.id}.jpg`)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await images.ensure("test", cam, stored);
    expect(request).toHaveBeenCalledTimes(2);
    const restarted = new Database(path.dirname(directory));
    expect(restarted.getPerformer(performer.id)?.imageUrl).toBe(stored.imageUrl);
    restarted.close(); db.close();
  });

  it("keeps a user-selected local portrait and backs off unavailable images", async () => {
    const { db, performer, request, images, cam } = fixture();
    await images.ensure("test", cam, { ...performer, imageUrl: "/api/media/123/thumbnail" });
    expect(request).not.toHaveBeenCalled();
    request.mockImplementation(async () => new Response("unavailable", { status: 429 }));
    await images.ensure("test", cam, performer);
    await images.ensure("test", cam, performer);
    expect(request).toHaveBeenCalledTimes(1);
    expect(db.getPerformer(performer.id)?.imageUrl).toBe(performer.imageUrl);
    db.close();
  });
});


describe("Portrait URL safety", () => {
  it("accepts ordinary public image URLs", () => {
    for (const url of ["https://cdn.example.com/a/b.jpg", "http://images.test/alice.png", "https://8.8.8.8/pic.jpg", "https://1.1.1.1:8443/x.jpg"]) {
      expect(isSafeImageUrl(url)).toBe(true);
    }
  });

  it("rejects internal, loopback and metadata targets", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",   // cloud metadata
      "http://127.0.0.1:8080/admin",
      "https://localhost/x.jpg",
      "http://10.1.2.3/a.jpg",
      "http://192.168.1.1/a.jpg",
      "http://172.16.0.5/a.jpg",
      "http://172.31.255.255/a.jpg",
      "http://100.64.0.1/x.jpg",                    // carrier-grade NAT / docker
      "http://[::1]/a.jpg",
      "http://[fd00::1]/a.jpg",
      "http://[fe80::1]/a.jpg",
      "http://printer.local/x.jpg",
      "http://nas.internal/x.jpg",
    ]) expect(isSafeImageUrl(url)).toBe(false);
  });

  it("rejects anything that is not an http(s) URL", () => {
    for (const url of ["file:///etc/passwd", "gopher://internal/", "data:image/png;base64,AAAA", "not a url"]) {
      expect(isSafeImageUrl(url)).toBe(false);
    }
  });

  it("never requests an unsafe portrait URL", async () => {
    const { db, performer, request, directory, images } = fixture();
    const cam = { id: "alice", username: "alice", pageUrl: "https://provider.test/alice", profileImageUrl: "http://169.254.169.254/latest/meta-data/" };
    await images.ensure("test", cam, performer);
    expect(request).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, `${performer.id}.jpg`))).toBe(false);
    db.close();
  });
});
