import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./database.js";
import { retentionPlan } from "./retention.js";

const dirs: string[] = [];
// Windows keeps a temp tree locked for a moment after SQLite handles go away, so rmSync can
// throw EPERM; an unclean temp directory is harmless and the OS temp cleaner gets it later.
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };

function fixture() {
  const dataDir = temp("easyx-retention-data");
  const mediaDir = temp("easyx-retention-media");
  const db = new Database(dataDir);
  const addCompleted = (filename: string, ageDays: number, options: { storagePath?: string; size?: number } = {}) => {
    const performer = db.upsertPerformer({ externalId: "person", name: `Performer ${filename}` }, "test.retention");
    const source = db.addSource(performer.id, "test.retention", { externalId: `source-${filename}`, label: "Source", profileUrl: "https://example.test/profile", domain: "example.test" });
    db.ingestItems(source, [{ externalId: `asset-${filename}`, mediaType: "video", filename, metadata: {} }]);
    const item = db.listItems().find((entry) => entry.externalId === `asset-${filename}`);
    if (!item) throw new Error(`Missing ingested item for ${filename}`);
    const relativePath = options.storagePath ?? `${performer.name}/example.test/${filename}`;
    const absolutePath = path.resolve(mediaDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.alloc(options.size ?? 32, 1));
    db.setItemStatus(item.id, "completed", { progress: 1, storagePath: relativePath });
    if (ageDays > 0) db.sqlite.prepare("UPDATE items SET download_finished_at=? WHERE id=?")
      .run(new Date(Date.now() - ageDays * 86_400_000).toISOString(), item.id);
    return { itemId: item.id, relativePath, absolutePath };
  };
  return { db, mediaDir, addCompleted, cleanup: () => db.close() };
}

describe("retention plan", () => {
  it("does nothing when retentionDays is 0 (the default)", () => {
    const env = fixture();
    try {
      env.addCompleted("old.mp4", 30);
      const report = retentionPlan({ db: env.db, mediaRoot: env.mediaDir, dryRun: true });
      expect(report.retentionDays).toBe(0);
      expect(report.scanned).toBe(0);
      expect(report.candidates).toEqual([]);
    } finally { env.cleanup(); }
  });

  it("lists old completed files as candidates in dry-run without touching anything", () => {
    const env = fixture();
    try {
      env.db.updateSettings({ retentionDays: 14 });
      const old = env.addCompleted("old.mp4", 30, { size: 4096 });
      const young = env.addCompleted("young.mp4", 1);
      const report = retentionPlan({ db: env.db, mediaRoot: env.mediaDir, dryRun: true });
      expect(report.cutoff).not.toBe("");
      expect(report.candidates.map((entry) => entry.itemId)).toEqual([old.itemId]);
      expect(report.candidates[0].bytes).toBe(4096);
      expect(report.candidates[0].ageDays).toBeGreaterThanOrEqual(29);
      // Dry-run never deletes and never rewrites the database.
      expect(fs.existsSync(old.absolutePath)).toBe(true);
      expect(env.db.getItem(old.itemId)?.status).toBe("completed");
      expect(env.db.getItem(young.itemId)?.status).toBe("completed");
      expect(report.deleted).toEqual([]);
    } finally { env.cleanup(); }
  });

  it("deletes the file first and marks the item deleted only after the unlink succeeded", () => {
    const env = fixture();
    try {
      env.db.updateSettings({ retentionDays: 14 });
      const old = env.addCompleted("old.mp4", 30);
      const report = retentionPlan({ db: env.db, mediaRoot: env.mediaDir, dryRun: false });
      expect(report.deleted.map((entry) => entry.itemId)).toEqual([old.itemId]);
      expect(report.failed).toEqual([]);
      expect(fs.existsSync(old.absolutePath)).toBe(false);
      expect(env.db.getItem(old.itemId)?.status).toBe("deleted");
    } finally { env.cleanup(); }
  });

  it("refuses to touch storage paths that escape the media root", () => {
    const env = fixture();
    try {
      env.db.updateSettings({ retentionDays: 14 });
      // A real file in a sibling temp directory stands in for ../../etc/passwd: the stored
      // relative path climbs out of the media root, so retention must skip it entirely.
      const outsideDir = temp("easyx-retention-outside");
      const outside = path.join(outsideDir, "target.txt");
      fs.writeFileSync(outside, "do not delete");
      const escape = env.addCompleted("escape.mp4", 30, { storagePath: path.relative(env.mediaDir, outside) });
      const report = retentionPlan({ db: env.db, mediaRoot: env.mediaDir, dryRun: false });
      expect(report.candidates).toEqual([]);
      expect(report.skipped.some((entry) => entry.itemId === escape.itemId && entry.reason === "storage path escapes the media root")).toBe(true);
      expect(fs.existsSync(outside)).toBe(true);
      expect(env.db.getItem(escape.itemId)?.status).toBe("completed");
    } finally { env.cleanup(); }
  });

  it("skips completed items whose file is missing on disk", () => {
    const env = fixture();
    try {
      env.db.updateSettings({ retentionDays: 14 });
      const ghost = env.addCompleted("ghost.mp4", 30);
      fs.rmSync(ghost.absolutePath);
      const report = retentionPlan({ db: env.db, mediaRoot: env.mediaDir, dryRun: true });
      expect(report.candidates).toEqual([]);
      expect(report.skipped[0]?.itemId).toBe(ghost.itemId);
      expect(report.skipped[0]?.reason).toBe("stored file is missing on disk");
    } finally { env.cleanup(); }
  });

  it("skips items whose completion date cannot be parsed", () => {
    const env = fixture();
    try {
      env.db.updateSettings({ retentionDays: 14 });
      const odd = env.addCompleted("odd.mp4", 30);
      env.db.sqlite.prepare("UPDATE items SET download_finished_at='not-a-date' WHERE id=?").run(odd.itemId);
      const report = retentionPlan({ db: env.db, mediaRoot: env.mediaDir, dryRun: true });
      expect(report.candidates).toEqual([]);
      expect(report.skipped[0]?.reason).toBe("completion date is not a valid timestamp");
    } finally { env.cleanup(); }
  });
});
