import fs from "node:fs";
import path from "node:path";
import type { DownloadItem, Performer } from "./database.js";
import { safeSegment } from "./utils.js";

export function performerDirectory(mediaRoot: string, performerName: string): string {
  return path.join(path.resolve(mediaRoot), safeSegment(performerName));
}

export function ensurePerformerDirectory(mediaRoot: string, performerName: string): string {
  const directory = performerDirectory(mediaRoot, performerName);
  fs.mkdirSync(directory, { recursive: true, mode: 0o775 });
  return directory;
}

export function renamePerformerDirectory(mediaRoot: string, previousName: string, nextName: string): string {
  const previous = performerDirectory(mediaRoot, previousName);
  const next = performerDirectory(mediaRoot, nextName);
  if (previous !== next && fs.existsSync(previous) && !fs.existsSync(next)) fs.renameSync(previous, next);
  else fs.mkdirSync(next, { recursive: true, mode: 0o775 });
  return next;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

// otherPerformerDirs: resolved directories of every other performer. When two performer names
// collapse to the same safeSegment (safeSegment() maps "/ \ : * ? ..." -> "-"), their media
// directories coincide. In that case we must NOT wipe the shared directory — we only remove this
// performer's own managed files (the item storagePaths) so we never destroy another performer's
// media. See audit P2-2.
export function deletePerformerFiles(mediaRoot: string, performer: Performer, items: DownloadItem[], otherPerformerDirs: Iterable<string> = []): number {
  const root = path.resolve(mediaRoot);
  const ownDir = performerDirectory(root, performer.name);
  const others = new Set<string>([...otherPerformerDirs].map((d) => path.resolve(d)));
  const dirShared = others.has(ownDir);
  const targets = new Set<string>();
  for (const item of items) {
    if (!item.storagePath) continue;
    const target = path.resolve(root, item.storagePath);
    if (inside(root, target)) targets.add(target);
  }
  // Only delete the whole performer directory when it is not also another performer's directory.
  if (!dirShared) targets.add(ownDir);
  let removed = 0;
  for (const target of [...targets].sort((a, b) => b.length - a.length)) {
    if (!inside(root, target) || !fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    removed += stat.isDirectory() ? countFiles(target) : 1;
    fs.rmSync(target, { recursive: stat.isDirectory(), force: true });
  }
  return removed;
}

function countFiles(directory: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    count += entry.isDirectory() ? countFiles(target) : 1;
  }
  return count;
}
