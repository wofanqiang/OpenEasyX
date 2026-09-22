import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";
import { parseMediaRange, registerLibraryRoutes } from "./library-routes";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function libraryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-thumbnail-route-")); roots.push(root);
  const data = path.join(root, "data"); const media = path.join(root, "media");
  fs.mkdirSync(path.join(media, "Example Performer", "example.com"), { recursive: true });
  return { data, media, db: new LibraryDatabase(data) };
}

describe("media byte ranges", () => {
  it("serves ordinary and open-ended browser ranges", () => {
    expect(parseMediaRange("bytes=100-199", 1_000)).toEqual({ start: 100, end: 199 });
    expect(parseMediaRange("bytes=900-", 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseMediaRange("bytes=900-1200", 1_000)).toEqual({ start: 900, end: 999 });
  });

  it("serves suffix ranges from the end of the media file", () => {
    expect(parseMediaRange("bytes=-200", 1_000)).toEqual({ start: 800, end: 999 });
    expect(parseMediaRange("bytes=-1200", 1_000)).toEqual({ start: 0, end: 999 });
  });

  it("rejects malformed, empty, multiple, and unsatisfiable ranges", () => {
    expect(parseMediaRange("bytes=-0", 1_000)).toBeUndefined();
    expect(parseMediaRange("bytes=1000-", 1_000)).toBeUndefined();
    expect(parseMediaRange("bytes=200-100", 1_000)).toBeUndefined();
    expect(parseMediaRange("bytes=0-10,20-30", 1_000)).toBeUndefined();
  });
});

describe("media thumbnails", () => {
  it("answers an unavailable thumbnail with 404 rather than a payload-type failure", async () => {
    const { data, media, db } = libraryFixture();
    fs.writeFileSync(path.join(media, "Example Performer", "example.com", "clip.mp4"), "video");
    await new Catalog(db, media, data, false).scan();
    const item = db.listMedia().items[0];

    // Declaring image/jpeg before the body existed made Fastify reject the error payload and report
    // 500 -- the browser saw a server fault instead of the 404 this route documents. The catalog is
    // stubbed because the route's own behaviour is what is under test here, not ffmpeg.
    const catalog = { thumbnail: async () => { throw new Error("FFmpeg produced an empty thumbnail"); } } as unknown as Catalog;
    const downloadDb = { markStoredItemDeleted: () => false } as unknown as Parameters<typeof registerLibraryRoutes>[3];
    const app = Fastify();
    registerLibraryRoutes(app, db, catalog, downloadDb, data);

    const response = await app.inject({ method: "GET", url: `/api/media/${item.id}/thumbnail` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Thumbnail is not available" });
    // A poster that cannot be drawn must never cost the item its visibility.
    expect(db.getMedia(item.id)).toBeDefined();
    await app.close();
    db.close();
  });
});

describe("media deletion while a merge is running", () => {
  it("refuses to delete a video a running merge is still streaming from", async () => {
    const { data, media, db } = libraryFixture();
    fs.writeFileSync(path.join(media, "Example Performer", "example.com", "clip.mp4"), "video");
    await new Catalog(db, media, data, false).scan();
    const item = db.listMedia().items[0];

    let deletions = 0;
    const catalog = { deleteMedia: () => { deletions += 1; return { bytes: 6 }; } } as unknown as Catalog;
    const downloadDb = { markStoredItemDeleted: () => false } as unknown as Parameters<typeof registerLibraryRoutes>[3];
    // The Library page stays clickable while a merge runs, so Delete has to know what the job holds.
    const merging: string[] = [item.id];
    const app = Fastify();
    registerLibraryRoutes(app, db, catalog, downloadDb, data, () => merging);

    const refused = await app.inject({ method: "POST", url: "/api/media/delete", payload: { ids: [item.id] } });
    expect(refused.statusCode).toBe(200);
    expect(refused.json().deleted).toEqual([]);
    expect(refused.json().failed[0].error).toContain("merge");
    expect(deletions).toBe(0);
    // Nothing was unlinked, so the item is still exactly where it was.
    expect(db.getMedia(item.id)).toBeDefined();

    // The refusal ends when the job does: the same request then goes through.
    merging.length = 0;
    const allowed = await app.inject({ method: "POST", url: "/api/media/delete", payload: { ids: [item.id] } });
    expect(allowed.json().deleted).toHaveLength(1);
    expect(deletions).toBe(1);

    await app.close();
    db.close();
  });
});
