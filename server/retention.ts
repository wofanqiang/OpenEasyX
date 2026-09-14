import fs from "node:fs";
import path from "node:path";
import type { Database } from "./database.js";

export type RetentionCandidate = {
  itemId: string; title?: string; relativePath: string; absolutePath: string;
  ageDays: number; bytes: number;
};

export type RetentionSkip = { itemId: string; relativePath: string; reason: string };

export type RetentionReport = {
  retentionDays: number; dryRun: boolean; cutoff: string;
  scanned: number; candidates: RetentionCandidate[]; skipped: RetentionSkip[];
  deleted: RetentionCandidate[]; failed: Array<{ candidate: RetentionCandidate; error: string }>;
};

const DAY_MS = 86_400_000;

// C1 retention: compute what has outlived the configured window. The plan is deliberately
// paranoid — deletion is the highest-risk operation in the app — so the first version ships
// dry-run only (retentionDryRun, default true), refuses retentionDays below 1, only ever
// considers fully completed items, and mirrors prepareOutputDirectory's path rules so a
// poisoned storage path cannot point the cleanup outside the media volume.
export function retentionPlan(options: { db: Database; mediaRoot: string; now?: Date; dryRun?: boolean; limit?: number }): RetentionReport {
  const { db, mediaRoot, now = new Date(), dryRun = true, limit = 5000 } = options;
  const retentionDays = Math.max(0, Math.floor(Number(db.getSettings().retentionDays ?? 0)));
  const root = path.resolve(mediaRoot);
  const report: RetentionReport = { retentionDays, dryRun, cutoff: "", scanned: 0, candidates: [], skipped: [], deleted: [], failed: [] };
  // retentionDays below 1 disables retention entirely: there is no safe "same-day" cleanup.
  if (retentionDays < 1) return report;
  const cutoffMs = now.valueOf() - retentionDays * DAY_MS;
  report.cutoff = new Date(cutoffMs).toISOString();
  for (const item of db.listItems(limit)) {
    if (item.status !== "completed") continue;
    report.scanned += 1;
    if (!item.storagePath) {
      report.skipped.push({ itemId: item.id, relativePath: "", reason: "completed item has no stored file" });
      continue;
    }
    const finishedMs = new Date(item.downloadFinishedAt ?? item.updatedAt ?? 0).valueOf();
    // A malformed timestamp must never read as "infinitely old"; skip instead.
    if (!Number.isFinite(finishedMs)) {
      report.skipped.push({ itemId: item.id, relativePath: item.storagePath, reason: "completion date is not a valid timestamp" });
      continue;
    }
    if (finishedMs > cutoffMs) continue;
    const resolved = path.resolve(root, item.storagePath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      report.skipped.push({ itemId: item.id, relativePath: item.storagePath, reason: "storage path escapes the media root" });
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch {
      report.skipped.push({ itemId: item.id, relativePath: item.storagePath, reason: "stored file is missing on disk" });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      report.skipped.push({ itemId: item.id, relativePath: item.storagePath, reason: "storage path is not a real file" });
      continue;
    }
    report.candidates.push({
      itemId: item.id, title: item.title, relativePath: item.storagePath, absolutePath: resolved,
      ageDays: Math.floor((now.valueOf() - Math.max(finishedMs, 0)) / DAY_MS), bytes: stat.size,
    });
  }
  if (!dryRun) {
    for (const candidate of report.candidates) {
      // Order matters: the file goes first, and the DB entry only after the unlink
      // succeeded, so a failed deletion never leaves a ghost row without its file.
      // Orphaned thumbnails are reclaimed by the scheduled library scan.
      try {
        fs.rmSync(candidate.absolutePath);
      } catch (error) {
        report.failed.push({ candidate, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      db.markStoredItemDeleted(candidate.relativePath);
      report.deleted.push(candidate);
    }
  }
  return report;
}
