import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";
import { parseMediaRange, registerLibraryRoutes } from "./library-routes";
import { authorizedMediaLink, mediaLinkUrl } from "./media-links.js";

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

describe("media link payload", () => {
  it("hands out a stream URL the session gate accepts without a session", async () => {
    const { data, media, db } = libraryFixture();
    fs.writeFileSync(path.join(media, "Example Performer", "example.com", "clip.mp4"), "video");
    await new Catalog(db, media, data, false).scan();
    const item = db.listMedia().items[0];

    const secret = "payload-test-secret-0123456789";
    const catalog = { thumbnail: async () => { throw new Error("FFmpeg produced an empty thumbnail"); } } as unknown as Catalog;
    const downloadDb = { markStoredItemDeleted: () => false } as unknown as Parameters<typeof registerLibraryRoutes>[3];
    const app = Fastify();
    // The production wiring passes the signer; this asserts the two halves agree.
    registerLibraryRoutes(app, db, catalog, downloadDb, data, () => [], (id, name) => mediaLinkUrl(id, secret, name));

    const streamUrl: string = (await app.inject({ method: "GET", url: `/api/media/${item.id}` })).json().streamUrl;
    // The name rides in the path so a download manager sees a file, not an extension-less endpoint.
    expect(streamUrl.startsWith(`/api/media/${item.id}/stream/clip.mp4?exp=`)).toBe(true);
    expect(authorizedMediaLink({ url: streamUrl }, secret)).toBe(item.id);
    await app.close();
    db.close();
  });
});

describe("downloading a media file", () => {
  it("answers a download request with a file, and leaves the player stream alone", async () => {
    const { data, media, db } = libraryFixture();
    const relative = path.join("Example Performer", "example.com", "clip one.mp4");
    fs.writeFileSync(path.join(media, relative), "video");
    await new Catalog(db, media, data, false).scan();
    const item = db.listMedia().items[0];

    const catalog = { playbackFile: async () => ({ file: path.join(media, relative), mimeType: "video/mp4" }) } as unknown as Catalog;
    const downloadDb = { markStoredItemDeleted: () => false } as unknown as Parameters<typeof registerLibraryRoutes>[3];
    const app = Fastify();
    registerLibraryRoutes(app, db, catalog, downloadDb, data, () => [], (id, name) => mediaLinkUrl(id, "download-secret", name));

    // The player asks for a stream: it must stay inline, or the video opens in the tab.
    const stream = await app.inject({ method: "GET", url: `/api/media/${item.id}/stream` });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-disposition"]).toBeUndefined();
    // ...and it keeps the connection open, because a player asks for range after range.
    expect(stream.headers["connection"]).not.toBe("close");

    // A link exported for a download manager asks for a file, and gets one with a name.
    const download = await app.inject({ method: "GET", url: `/api/media/${item.id}/stream?download=1` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect(download.headers["content-disposition"]).toContain('filename="clip one.mp4"');
    // A client that reads until the connection ends must not be left waiting for one: the file
    // arrives, the socket closes, the download manager files it.
    expect(download.headers["connection"]).toBe("close");
    // The named form serves the same bytes and the same headers; only the path looks like a file.
    const named = await app.inject({ method: "GET", url: `/api/media/${item.id}/stream/clip%20one.mp4?download=1` });
    expect(named.statusCode).toBe(200);
    expect(named.headers["content-disposition"]).toContain('filename="clip one.mp4"');

    // The token in the query string is not part of what the signature covers, so adding the
    // download flag cannot invalidate it.
    const signed = (await app.inject({ method: "GET", url: `/api/media/${item.id}` })).json().streamUrl as string;
    expect(authorizedMediaLink({ url: `${signed}&download=1` }, "download-secret")).toBe(item.id);

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

describe("hidden entries", () => {
  /** An image keeps the fixture off ffmpeg: `playbackFile` only remuxes videos. */
  async function hiddenFixture() {
    const fixture = libraryFixture();
    const file = path.join(fixture.media, "Example Performer", "example.com", "portrait.jpg");
    fs.writeFileSync(file, "image-bytes");
    const catalog = new Catalog(fixture.db, fixture.media, fixture.data, false);
    await catalog.scan();
    const item = fixture.db.listMedia().items[0];
    fixture.db.markMediaUnplayable(item.id);
    const downloadDb = { markStoredItemDeleted: () => false } as unknown as Parameters<typeof registerLibraryRoutes>[3];
    const app = Fastify();
    registerLibraryRoutes(app, fixture.db, catalog, downloadDb, fixture.data);
    return { ...fixture, file, catalog, app, item };
  }

  it("lists an entry every other view filters out", async () => {
    const { app, db, item } = await hiddenFixture();
    // This is the whole complaint: the row is invisible everywhere and had no surface at all.
    expect(db.listMedia().total).toBe(0);
    const response = await app.inject({ method: "GET", url: "/api/library/hidden" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([expect.objectContaining({ id: item.id, title: item.title })]);
    await app.close();
    db.close();
  });

  it("refuses to restore an entry whose file still cannot be read", async () => {
    const { app, db, item, file } = await hiddenFixture();
    fs.rmSync(file);
    const response = await app.inject({ method: "POST", url: `/api/library/hidden/${item.id}/restore` });
    // Restoring on trust would put the entry back into every listing and hide it again the first
    // time somebody opened it, which is the loop this page exists to break.
    expect(response.statusCode).toBe(409);
    // A bare Fastify reports the thrown message as `message`; the production error handler maps it
    // onto `error` for the client. Either way the reason has to survive to the caller.
    expect(response.json().message).toContain("still unreadable");
    expect(db.getMedia(item.id)).toBeUndefined();
    await app.close();
    db.close();
  });

  it("restores an entry once its file reads again", async () => {
    const { app, db, item, file } = await hiddenFixture();
    fs.rmSync(file);
    fs.writeFileSync(file, "image-bytes");
    const response = await app.inject({ method: "POST", url: `/api/library/hidden/${item.id}/restore` });
    expect(response.statusCode).toBe(200);
    expect(db.getMedia(item.id)).toBeDefined();
    expect(db.listMedia().total).toBe(1);
    // And it leaves the hidden list, so the page cannot offer it twice.
    expect((await app.inject({ method: "GET", url: "/api/library/hidden" })).json().items).toEqual([]);
    await app.close();
    db.close();
  });

  it("clears a hidden entry whose file is already gone", async () => {
    const { app, db, item, file } = await hiddenFixture();
    fs.rmSync(file);
    // `deleteMedia` requires the file to exist, so this used to be a dead end: the row could not
    // even be deleted, because being hidden usually means the file vanished.
    const response = await app.inject({ method: "DELETE", url: `/api/library/hidden/${item.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: item.id, bytes: 0, fileDeleted: false });
    expect(db.getMedia(item.id, { includeHidden: true })).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/api/library/hidden" })).json().items).toEqual([]);
    await app.close();
    db.close();
  });

  it("deletes the file as well when a hidden entry still has one", async () => {
    const { app, db, item, file } = await hiddenFixture();
    const response = await app.inject({ method: "DELETE", url: `/api/library/hidden/${item.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().fileDeleted).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(db.getMedia(item.id, { includeHidden: true })).toBeUndefined();
    await app.close();
    db.close();
  });
});

describe("hidden list paging", () => {
  it("pages the list instead of truncating the tail", async () => {
    const { data, media, db } = libraryFixture();
    const directory = path.join(media, "Example Performer", "example.com");
    for (const name of ["one.jpg", "two.jpg", "three.jpg"]) fs.writeFileSync(path.join(directory, name), "image-bytes");
    const catalog = new Catalog(db, media, data, false);
    await catalog.scan();
    for (const item of db.listMedia({ pageSize: 100 }).items) db.markMediaUnplayable(item.id);

    const app = Fastify();
    registerLibraryRoutes(app, db, catalog, { markStoredItemDeleted: () => false } as unknown as Parameters<typeof registerLibraryRoutes>[3], data);

    const first = await app.inject({ method: "GET", url: "/api/library/hidden?page=1&pageSize=2" });
    expect(first.json()).toMatchObject({ total: 3, page: 1, pageSize: 2, pages: 2 });
    expect(first.json().items).toHaveLength(2);

    const second = await app.inject({ method: "GET", url: "/api/library/hidden?page=2&pageSize=2" });
    expect(second.json().items).toHaveLength(1);
    // Every row is reachable, which is the point: a silent cap leaves the tail invisible.
    const ids = new Set([...first.json().items, ...second.json().items].map((item: { id: string }) => item.id));
    expect(ids.size).toBe(3);
    await app.close();
    db.close();
  });

  it("searches the whole set, not just the page in hand", async () => {
    const { data, media, db } = libraryFixture();
    const directory = path.join(media, "Example Performer", "example.com");
    fs.writeFileSync(path.join(directory, "needle.jpg"), "image-bytes");
    fs.writeFileSync(path.join(directory, "other.jpg"), "image-bytes");
    const catalog = new Catalog(db, media, data, false);
    await catalog.scan();
    for (const item of db.listMedia({ pageSize: 100 }).items) db.markMediaUnplayable(item.id);

    const app = Fastify();
    registerLibraryRoutes(app, db, catalog, { markStoredItemDeleted: () => false } as unknown as Parameters<typeof registerLibraryRoutes>[3], data);
    const found = await app.inject({ method: "GET", url: "/api/library/hidden?q=needle" });
    expect(found.json().total).toBe(1);
    expect(found.json().items[0].title).toContain("needle");
    await app.close();
    db.close();
  });
});

describe("hidden restore does not wait on ffmpeg", () => {
  it("restores a readable video whose file only needs a remux at playback time", async () => {
    const { data, media, db } = libraryFixture();
    // A readable file that is not a faststart MP4: the player remuxes it on demand, which is not a
    // reason to keep the entry hidden -- and verifying that must not run ffmpeg inside the request.
    const file = path.join(media, "Example Performer", "example.com", "clip.mp4");
    fs.writeFileSync(file, "readable but not a faststart mp4");
    const catalog = new Catalog(db, media, data, false);
    await catalog.scan();
    const item = db.listMedia().items[0];
    db.markMediaUnplayable(item.id);

    const app = Fastify();
    registerLibraryRoutes(app, db, catalog, { markStoredItemDeleted: () => false } as unknown as Parameters<typeof registerLibraryRoutes>[3], data);
    const response = await app.inject({ method: "POST", url: `/api/library/hidden/${item.id}/restore` });
    expect(response.statusCode).toBe(200);
    expect(db.getMedia(item.id)).toBeDefined();
    await app.close();
    db.close();
  });
});
