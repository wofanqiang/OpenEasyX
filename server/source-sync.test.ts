import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "./database.js";
import { SourceSync } from "./source-sync.js";
import type { MediaCandidate, EasyXPlugin } from "../packages/plugin-sdk/index.js";
const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-rescan-")); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = new Database(root); cleanup.push(() => db.close());
  const performer = db.createPerformer({ name: "Example" });
  const addSource = (name: string) => {
    const source = db.addSource(performer.id, "test", { externalId: name, label: name, profileUrl: `https://site.test/${name}`, domain: "site.test" });
    return db.updateSource(source.id, { scraperPluginId: "test" })!;
  };
  const source = addSource("account");
  const candidates: MediaCandidate[] = ["deleted", "missing", "kept", "active", "excerpt"].map((externalId) => ({ externalId, identityKey: externalId, mediaType: "video", metadata: { fresh: true } }));
  db.ingestItems(source, candidates);
  const item = (name: string) => db.getItemBySourceExternalId(source.id, name)!;
  for (const name of ["deleted", "missing", "kept"]) db.setItemStatus(item(name).id, "completed", { storagePath: `${name}.mp4`, checksum: name });
  db.markStoredItemDeleted("deleted.mp4");
  fs.writeFileSync(path.join(root, "kept.mp4"), "stored");
  db.setItemStatus(item("active").id, "downloading", { progress: .4 });
  db.markVideoExcerpt(item("excerpt").id, item("kept").id, "excerpt-hash");
  const listMedia = vi.fn(async () => candidates);
  const service = new SourceSync(db, root, () => ({ listMedia } as unknown as EasyXPlugin), () => ({ config: {}, fetch, runCommand: vi.fn(), log: vi.fn() }), async () => undefined);
  return { root, db, source, candidates, item, listMedia, service, addSource };
}
describe("source hard refresh", () => {
  it("preserves ordinary deletion history, then recovers only missing files from the selected source", async () => {
    const { root, db, source, item, service, addSource } = fixture();
    const other = addSource("other"); db.ingestItems(other, [{ externalId: "other", mediaType: "video" }]);
    const otherItem = db.getItemBySourceExternalId(other.id, "other")!; db.setItemStatus(otherItem.id, "deleted");
    await service.sync(source.id);
    expect(item("deleted").status).toBe("deleted"); expect(item("missing").status).toBe("completed");
    expect(await service.sync(source.id, true)).toMatchObject({ recovered: 2 });
    for (const name of ["deleted", "missing"]) expect(item(name)).toMatchObject({ status: "queued", progress: 0, metadata: { fresh: true }, storagePath: undefined, checksumSha256: undefined });
    expect(item("active")).toMatchObject({ status: "downloading", progress: .4 });
    expect(item("excerpt")).toMatchObject({ status: "duplicate", duplicateReason: "contained-excerpt" });
    expect(item("kept").status).toBe("completed"); expect(fs.readFileSync(path.join(root, "kept.mp4"), "utf8")).toBe("stored");
    expect(db.getItem(otherItem.id)?.status).toBe("deleted");
    expect(await service.sync(source.id, true)).toMatchObject({ recovered: 0 });
  });
  it("honors review-first settings and bypasses a deleted cross-source identity only on explicit refresh", async () => {
    const { db, source, item, candidates, listMedia, service, addSource } = fixture();
    db.updateSettings({ autoQueueDiscovered: false });
    const other = addSource("other"); db.ingestItems(other, [{ externalId: "old", identityKey: "shared", mediaType: "video" }]);
    db.setItemStatus(db.getItemBySourceExternalId(other.id, "old")!.id, "deleted");
    listMedia.mockResolvedValue([...candidates, { externalId: "new", identityKey: "shared", mediaType: "video" }]);
    await service.sync(source.id);
    expect(db.getItemBySourceExternalId(source.id, "new")).toBeUndefined();
    await service.sync(source.id, true);
    expect(item("deleted").status).toBe("available");
    expect(item("new").status).toBe("available");
  });
  it("keeps deletion history on extraction failure and serializes normal and hard scans", async () => {
    const { source, item, listMedia, service } = fixture();
    let reject!: (reason: Error) => void;
    listMedia.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const first = service.sync(source.id, true);
    await expect(service.sync(source.id)).rejects.toThrow("already being scanned");
    reject(new Error("Site unavailable")); await expect(first).rejects.toThrow("Site unavailable");
    expect(service.active.size).toBe(0); expect(item("deleted").status).toBe("deleted");
  });
});
