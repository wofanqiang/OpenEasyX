import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "./catalog.js";
import { Database } from "./database.js";
import { LibraryDatabase } from "./library-database.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) dispose(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-dates-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, "media"); fs.mkdirSync(mediaRoot);
  const db = new Database(root); cleanup.push(() => db.close());
  const library = new LibraryDatabase(root); cleanup.push(() => library.close());
  const performer = db.createPerformer({ name: "Example" });
  const source = db.addSource(performer.id, "test", { externalId: "s", label: "Site", domain: "example.test", profileUrl: "https://example.test" });
  const catalog = new Catalog(library, mediaRoot, root, false, (file) => db.storedMediaMetadata(file));
  const add = (name: string, publishedAt?: string, live = false) => {
    fs.writeFileSync(path.join(mediaRoot, `${name}.mp4`), name);
    db.ingestItems(source, [{ externalId: name, mediaType: "video", publishedAt, metadata: { live } }]);
    const item = db.getItemBySourceExternalId(source.id, name)!;
    db.setItemStatus(item.id, "completed", { storagePath: `${name}.mp4` });
    return item;
  };
  // Linux/NAS mounts may not expose a file creation time.
  const statSync = fs.statSync;
  vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, ...args: any[]) => {
    const stat = (statSync as any)(file, ...args);
    if (String(file).endsWith(".mp4")) { stat.birthtime = new Date(0); stat.birthtimeMs = 0; }
    return stat;
  }) as typeof fs.statSync);
  return { root, mediaRoot, db, library, catalog, source, add };
}

describe("catalog media dates", () => {
  it("uses site publication and recording start dates for display, ignoring disk birthtime", async () => {
    const { db, library, catalog, add } = fixture();
    const live = add("live", "2020-01-01T00:00:00Z", true);
    db.sqlite.prepare("UPDATE items SET published_at=?,download_started_at=? WHERE id=?")
      .run("1970-01-01T00:00:00Z", "2025-03-04T23:30:00.000Z", live.id);
    add("site", "2024-02-03T10:20:30Z");
    await catalog.scan();
    const items = library.listMedia({ sort: "recent" }).items;
    // This fork keeps "recent/oldest" ordered by ingest time (added_at); media_date stays a
    // per-item value (site publication / recording start), never the library sort key.
    expect(new Set(items.map((item) => item.mediaDate))).toEqual(new Set(["2025-03-04T23:30:00.000Z", "2024-02-03T10:20:30.000Z"]));
    expect(new Date(items[0].addedAt).getTime()).toBeGreaterThanOrEqual(new Date(items[1].addedAt).getTime());
    expect(library.listMedia({ sort: "oldest" }).items.map((item) => item.id)).toEqual(items.map((item) => item.id).reverse());
    expect(items.every((item) => new Date(item.addedAt).getTime() > 0)).toBe(true);
  });

  it("repairs already indexed dates during rescan while preserving favorites and playback", async () => {
    const { db, library, catalog, source, add } = fixture();
    const download = add("site", "2024-02-03T10:20:30Z");
    await catalog.scan();
    const original = library.listMedia().items[0];
    library.setFavorite(original.id, true); library.updateProgress(original.id, 30, 120);
    library.sqlite.prepare("UPDATE media SET added_at=?,media_date=NULL WHERE id=?").run("1970-01-01T00:00:00.000Z", original.id);
    db.sqlite.prepare("UPDATE items SET published_at=? WHERE id=?").run("1970-01-01T00:00:00.000Z", download.id);
    db.ingestItems(source, [{ externalId: "site", mediaType: "video", publishedAt: "2024-02-03T10:20:30Z" }]);
    await catalog.scan();
    expect(library.getMedia(original.id)).toMatchObject({ mediaDate: "2024-02-03T10:20:30.000Z", favorite: true, progressSeconds: 30 });
    expect(library.getMedia(original.id)?.addedAt).not.toBe("1970-01-01T00:00:00.000Z");
  });

  it("reads publication dates from sidecars and falls back to mtime when no source date is available", async () => {
    const { mediaRoot, library, catalog } = fixture();
    fs.writeFileSync(path.join(mediaRoot, "sidecar.mp4"), "sidecar");
    fs.writeFileSync(path.join(mediaRoot, "sidecar.info.json"), JSON.stringify({ timestamp: 0, upload_date: "20240203" }));
    const local = path.join(mediaRoot, "local.mp4"); fs.writeFileSync(local, "local");
    fs.utimesSync(local, new Date("2023-02-01T12:00:00Z"), new Date("2023-02-01T12:00:00Z"));
    await catalog.scan();
    expect(library.listMedia({ sort: "recent" }).items.map((item) => item.mediaDate)).toEqual(["2024-02-03T00:00:00.000Z", "2023-02-01T12:00:00.000Z"]);
  });
});
