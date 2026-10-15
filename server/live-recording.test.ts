import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "./database.js";
import { SourceSync } from "./source-sync.js";
import type { EasyXPlugin, MediaCandidate } from "../packages/plugin-sdk/index.js";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-live-scan-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let db = new Database(root); cleanup.push(() => db.close());
  const person = db.createPerformer({ name: "Alice" });
  const source = db.addSource(person.id, "test", { externalId: "alice", profileUrl: "https://live.test/alice", label: "Alice", domain: "live.test" });
  db.updateSource(source.id, { scraperPluginId: "test", autoDownload: true });
  const candidate: MediaCandidate = { externalId: "room:alice:live", pageUrl: source.profileUrl, filename: "alice.mp4", mediaType: "video", metadata: { live: true } };
  const listMedia = vi.fn(async () => [candidate]);
  const scanner = () => new SourceSync(db, root, () => ({ listMedia } as unknown as EasyXPlugin), () => ({ config: {}, fetch, runCommand: vi.fn(), log: vi.fn() }), async () => {});
  const complete = (id: string, status = "completed", duration = 600_000) => {
    db.setItemStatus(id, status);
    db.sqlite.prepare("UPDATE items SET download_started_at=?,download_finished_at=? WHERE id=?")
      .run(new Date(Date.now() - duration - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), id);
  };
  return { get db() { return db; }, source, candidate, listMedia, scanner, complete,
    reopen() { db.close(); db = new Database(root); } };
}
describe("live scan recording lifecycle", () => {
  it("restarts stable IDs after completion and keeps active and paused recordings unique", async () => {
    const f = fixture(); const sync = f.scanner();
    await sync.sync(f.source.id); const first = f.db.listItems()[0];
    for (const status of ["available", "queued", "downloading", "paused", "stopping", "cancelling"]) {
      f.db.setItemStatus(first.id, status); await sync.sync(f.source.id); expect(f.db.listItems()).toHaveLength(1);
    }
    f.complete(first.id); await sync.sync(f.source.id);
    const items = f.db.listItems(); expect(items).toHaveLength(2);
    const next = items.find((item) => item.id !== first.id)!;
    expect(next.status).toBe("queued"); expect(next.externalId).not.toBe(first.externalId); expect(next.filename).not.toBe(first.filename);
    await sync.sync(f.source.id); expect(f.db.listItems()).toHaveLength(2);
    f.db.setItemStatus(next.id, "downloading");
    await sync.sync(f.source.id, true);
    expect(f.db.getItem(first.id)?.status).toBe("completed");
    expect(f.db.getItem(next.id)?.status).toBe("downloading");
    expect(f.db.listItems()).toHaveLength(2);
  });
  it.each(["completed", "cancelled", "deleted"])("keeps a manual %s suppressed across restart until an offline scan", async (status) => {
    const f = fixture(); await f.scanner().sync(f.source.id); const first = f.db.listItems()[0];
    f.db.suppressLiveRecording(first.id); f.complete(first.id, status);
    if (status === "deleted") f.db.deleteItem(first.id);
    f.reopen(); await f.scanner().sync(f.source.id);
    expect(f.db.listItems().filter((item) => item.status === "queued")).toHaveLength(0);
    f.listMedia.mockRejectedValueOnce(new Error("Network unavailable"));
    await expect(f.scanner().sync(f.source.id)).rejects.toThrow("Network unavailable");
    await f.scanner().sync(f.source.id); expect(f.db.listItems().filter((item) => item.status === "queued")).toHaveLength(0);
    f.listMedia.mockResolvedValueOnce([]); await f.scanner().sync(f.source.id);
    f.reopen(); await f.scanner().sync(f.source.id);
    expect(f.db.listItems().filter((item) => item.status === "queued")).toHaveLength(1);
  });
  it("backs off failed recordings and retains backoff after restart", async () => {
    const f = fixture(); await f.scanner().sync(f.source.id); f.complete(f.db.listItems()[0].id, "failed", 1000);
    await f.scanner().sync(f.source.id); expect(f.db.listItems()).toHaveLength(2);
    f.complete(f.db.listItems().find((item) => item.status === "queued")!.id, "failed", 1000);
    f.reopen(); await f.scanner().sync(f.source.id); expect(f.db.listItems()).toHaveLength(2);
    f.db.sqlite.prepare("UPDATE items SET download_finished_at=? WHERE status='failed'").run(new Date(Date.now() - 100_000).toISOString());
    await f.scanner().sync(f.source.id); expect(f.db.listItems()).toHaveLength(3);
  });
  it("reuses legacy provider IDs and scopes sessions to their source", async () => {
    const f = fixture(); f.db.ingestItems(f.source, [{ ...f.candidate, externalId: "bongacams:alice:old-hash" }]);
    await f.scanner().sync(f.source.id); expect(f.db.listItems()).toHaveLength(1);
    f.complete(f.db.listItems()[0].id); await f.scanner().sync(f.source.id); expect(f.db.listItems()).toHaveLength(2);
    const other = f.db.addSource(f.source.performerId, "test", { externalId: "other", profileUrl: f.source.profileUrl, label: "Other", domain: "live.test" });
    expect(f.db.liveScanCandidates(other, [f.candidate])).toHaveLength(1);
  });
});
