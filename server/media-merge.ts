import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { freeBytes, GIB, type FreeSpaceProbe } from "./disk-space.js";
import type { LibraryDatabase, Media } from "./library-database.js";
import { probeSignature, type MediaSignature } from "./live-sessions.js";
import type { TaskHandle, TaskRegistry } from "./tasks.js";

/**
 * Join several finished library videos into one file, as a background task.
 *
 * Why it exists: a broadcast that dropped once and resumed, or a set of clips a user wants as one
 * file, arrives in the library as N separate entries. Nothing is broken about them -- they just
 * read as N videos. Merging is a pure `-c copy` through the concat demuxer, so it re-encodes
 * nothing and adds no A/V gap.
 *
 * It runs the same three-phase contract as the live-session splicer (`server/live-sessions.ts`):
 * measure every input, refuse a group whose stream layout is not identical, and only remove the
 * originals after the merged copy is on disk and indexed. That ordering is what makes a crash
 * harmless -- the worst case is an unreferenced copy of bytes that are all still present.
 *
 * The work runs on the downloader's shared, load-gated post-process slot (see `PostProcessGate`),
 * so a merge never competes with a live capture, and it reports a real percentage on the Activity
 * page from ffmpeg's own `-progress` timeline.
 */

export type MergeDeps = {
  mediaRoot: string;
  library: LibraryDatabase;
  /** Rescans the library so the merged file becomes a first-class media row. */
  scan: () => Promise<unknown>;
  tasks: TaskRegistry;
  /** Joins the listed files into `output`, reporting progress and honouring `signal`. */
  concat: (
    listPath: string, output: string, totalSeconds: number, totalBytes: number,
    onProgress: (fraction: number) => void, signal: AbortSignal,
  ) => Promise<void>;
  /** Deletes one source file and tombstones its library row. Only called when the caller asked. */
  removeSource: (media: Media) => { bytes: number };
  probe?: (file: string) => Promise<MediaSignature | undefined>;
  freeSpace?: FreeSpaceProbe;
  minFreeDiskGb?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
};

export type MergeRequest = { ids: string[]; removeSources?: boolean };

export type MergeSummary = {
  mergedId: string;
  mergedPath: string;
  targetName: string;
  sources: number;
  removed: number;
  removeFailed: number;
  durationSeconds: number;
};

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

const labelOf = (media: Media): string => media.title || media.relativePath;
const absolutePath = (mediaRoot: string, media: Media): string => path.join(mediaRoot, media.relativePath);

/** Ingest order, oldest first: the merge reads in the order the files arrived and the first one
 *  decides both the destination folder and the media date the product inherits. */
function ingestMs(media: Media): number {
  const stamp = Date.parse(media.addedAt);
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Resolve and validate the request synchronously, so an operator mistake comes back as a 400 from
 * the POST rather than as a failed job they have to go find on the Activity page. This covers
 * everything that can be answered without opening a file; the geometric/space checks need ffprobe
 * and stay in the worker.
 */
export function resolveMergeSources(deps: Pick<MergeDeps, "mediaRoot" | "library">, ids: string[]): Media[] {
  const unique = [...new Set(ids)];
  if (unique.length < 2) throw badRequest("Select at least two videos to merge");
  const videos: Media[] = [];
  for (const id of unique) {
    const media = deps.library.getMedia(id);
    if (!media) throw badRequest(`A selected item (${id}) is no longer in the library`);
    // Images cannot be concatenated into a video. Filter rather than fail: the operator selected a
    // page worth of files and one photo should not sink the whole merge.
    if (media.kind === "video") videos.push(media);
  }
  if (videos.length < 2) throw badRequest("Merging needs at least two videos; images cannot be concatenated");
  for (const media of videos) {
    let size = 0;
    try { size = fs.statSync(absolutePath(deps.mediaRoot, media)).size; } catch { /* reported below */ }
    if (size <= 0) throw badRequest(`${labelOf(media)} is no longer on disk`);
  }
  return videos.sort((left, right) => ingestMs(left) - ingestMs(right) || left.relativePath.localeCompare(right.relativePath));
}

/**
 * Where the merged file lands: beside the first source, so the product sits in the same performer
 * folder as the recording it came from. The extension follows the first source -- the concat muxer
 * is chosen from it, and forcing `.mp4` would make merging two Matroska or WebM videos fail on a
 * codec the MP4 container cannot hold. For the ordinary case of MP4 recordings the name is exactly
 * `<stem>_merged.mp4`.
 */
function mergedTarget(mediaRoot: string, first: Media): string {
  const source = absolutePath(mediaRoot, first);
  const directory = path.dirname(source);
  const extension = path.extname(source) || ".mp4";
  const stem = path.basename(source, path.extname(source));
  for (let index = 1; ; index++) {
    const candidate = path.join(directory, `${stem}${index === 1 ? "_merged" : `_merged-${index}`}${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function cleanup(leftovers: string[], log?: MergeDeps["log"], reason?: string): void {
  for (const file of leftovers) {
    try { fs.rmSync(file, { force: true }); }
    catch (error) { log?.("A partial merge file could not be removed", { path: file, reason, error: String(error) }); }
  }
}

/**
 * Start a merge. Validation errors throw synchronously (400); everything after that is reported on
 * the task, which is what the Activity page renders.
 */
export function startMerge(deps: MergeDeps, request: MergeRequest): { taskId: string } {
  const media = resolveMergeSources(deps, request.ids);
  const removeSources = request.removeSources === true;
  const handle = deps.tasks.create({
    kind: "merge",
    label: `Merging ${media.length} videos`,
    detail: media.map(labelOf).slice(0, 2).join(" + ") + (media.length > 2 ? ` +${media.length - 2} more` : ""),
    total: media.length,
    sourceIds: media.map((item) => item.id),
  });
  void runMerge(deps, handle, media, removeSources).catch((error) => {
    // `runMerge` reports its own failures; this only catches a bug in the reporting path itself,
    // so a merge can never escape as an unhandled rejection and take the process down.
    handle.fail(error instanceof Error ? error.message : String(error));
  });
  return { taskId: handle.id };
}

async function runMerge(deps: MergeDeps, handle: TaskHandle, media: Media[], removeSources: boolean): Promise<void> {
  const probe = deps.probe ?? probeSignature;
  const probeFreeSpace = deps.freeSpace ?? freeBytes;
  const minFreeDiskGb = Number(deps.minFreeDiskGb);
  const minFreeBytes = (Number.isFinite(minFreeDiskGb) && minFreeDiskGb > 0 ? minFreeDiskGb : 1) * GIB;
  const target = mergedTarget(deps.mediaRoot, media[0]);
  const relativeTarget = path.relative(deps.mediaRoot, target).split(path.sep).join("/");
  const listPath = `${target}.concat.txt`;
  const sizes = media.map((item) => { try { return fs.statSync(absolutePath(deps.mediaRoot, item)).size; } catch { return 0; } });
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const controller = new AbortController();
  let published = false;

  try {
    // 1. Measure every source. The concat demuxer keeps the FIRST input's streams, so a group that
    //    does not share one codec + geometry would silently drop or corrupt tracks after the first
    //    file -- refused outright rather than merged into a broken product.
    handle.update({ phase: "probing", detail: `Measuring ${media.length} videos`, progress: 0, done: 0 });
    const signatures: MediaSignature[] = [];
    for (const [index, item] of media.entries()) {
      const signature = await probe(absolutePath(deps.mediaRoot, item));
      if (!signature || !(signature.duration > 0)) throw new Error(`${labelOf(item)} could not be measured with ffprobe`);
      signatures.push(signature);
      if (controller.signal.aborted) throw new Error("Merge cancelled");
      handle.update({ done: index + 1, progress: media.length ? (index + 1) / media.length : 0 });
    }
    const expectedSeconds = signatures.reduce((sum, signature) => sum + signature.duration, 0);
    const layouts = new Set(signatures.map((signature) => signature.signature));
    if (layouts.size > 1) {
      throw new Error(`The selected videos do not share one stream layout (${[...layouts].join(" | ")}) — merging them would produce a broken file`);
    }

    // 2. The merged copy lands beside the sources before any of them is removed, so the pass needs
    //    room for both. Below the floor the job fails instead of filling the disk a capture needs.
    const free = await probeFreeSpace(deps.mediaRoot);
    if (free !== undefined && free < totalBytes + minFreeBytes) {
      throw new Error(`Only ${(free / GIB).toFixed(2)} GB free; merging ${(totalBytes / GIB).toFixed(2)} GB would leave less than the ${(minFreeBytes / GIB).toFixed(2)} GB floor`);
    }

    // 3. Concatenate on the shared post-process slot, at the lowest CPU/I/O priority, reporting the
    //    operator a real percentage from ffmpeg's own timeline.
    handle.setCancel(() => controller.abort());
    handle.update({ phase: "merging", detail: path.basename(target), progress: 0, done: 0 });
    fs.writeFileSync(listPath, media.map((item) => `file '${absolutePath(deps.mediaRoot, item).replaceAll("'", "'\\''")}'`).join("\n") + "\n");
    await deps.concat(listPath, target, expectedSeconds, totalBytes, (fraction) => handle.update({ progress: fraction }), controller.signal);
    if (controller.signal.aborted) throw new Error("Merge cancelled");
    if (!fs.existsSync(target) || fs.statSync(target).size <= 0) throw new Error("The merge produced no output file");

    // 4. Post-condition: the product must hold what its inputs measured. `-c copy` is exact, so a
    //    shortfall means a source was unreadable or vanishing -- never filed.
    const merged = await probe(target);
    const tolerance = Math.max(5, expectedSeconds * 0.02);
    if (!merged || !(merged.duration > 0) || merged.duration < expectedSeconds - tolerance) {
      throw new Error(`The merged file holds ${(merged?.duration ?? 0).toFixed(1)}s of the ${expectedSeconds.toFixed(1)}s its sources measured`);
    }

    // 5. Stamp the product with the first source's media date BEFORE the scan, so the library
    //    records the same content date a recording would. Its ingest time stays "now", which is
    //    what the "recently added" order reads.
    const date = new Date(ingestMs(media[0]) || (deps.now?.() ?? Date.now()));
    if (!Number.isNaN(date.valueOf())) { try { fs.utimesSync(target, date, date); } catch { /* mtime is cosmetic */ } }

    handle.update({ phase: "indexing", detail: path.basename(target), progress: null });
    await deps.scan();
    published = true;

    // 6. Only now, with the merged copy on disk and indexed, may the originals go.
    let removed = 0;
    let removeFailed = 0;
    if (removeSources) {
      handle.update({ phase: "removing", detail: `Removing ${media.length} source files` });
      for (const item of media) {
        try { deps.removeSource(item); removed += 1; }
        catch (error) {
          removeFailed += 1;
          deps.log?.("A merged source could not be deleted", { id: item.id, path: item.relativePath, error: String(error) });
        }
      }
    }

    const summary: MergeSummary = {
      mergedId: crypto.createHash("sha256").update(relativeTarget).digest("hex").slice(0, 24),
      mergedPath: relativeTarget,
      targetName: path.basename(target),
      sources: media.length,
      removed,
      removeFailed,
      durationSeconds: Math.round(merged.duration),
    };
    handle.finish({ ...summary });
    deps.log?.(`media-merge: joined ${media.length} videos into ${summary.targetName}`, {
      mergedId: summary.mergedId, bytes: totalBytes, removed, removeFailed, durationSeconds: summary.durationSeconds,
    });
  } finally {
    // Nothing here is a no-op: on success the list file is scratch, and on any failure the partial
    // output goes too. A cancelled merge leaves the sources exactly as they were.
    cleanup(
      published ? [listPath] : [target, listPath],
      deps.log,
      handle.isCancelled() ? "cancelled" : undefined,
    );
  }
}
