import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ACTIVE_ITEM_STATUSES, type Database, type DownloadItem } from "./database.js";
import { freeBytes, GIB, type FreeSpaceProbe } from "./disk-space.js";

/**
 * One broadcast, many files.
 *
 * When a room's upstream playlist disappears for a minute, ffmpeg exits, the watcher waits out its
 * cooldown and opens a fresh capture -- a new item, a new file, a new library entry. Nothing is
 * wrong with any of those recordings; a five-hour show simply arrives as eight files of a few
 * minutes each, and the library reads as eight separate broadcasts.
 *
 * This pass puts them back together. Once a room has been quiet long enough that the broadcast is
 * over, its finished captures are spliced into ONE file with a single `-c copy` pass through the
 * concat demuxer, the absorbed rows are retired, and the library's next scan re-measures the
 * replaced path (see LibraryDatabase.upsertMedia) while the files that went away drop out of the
 * listing (see finishScan).
 *
 * The recording path is deliberately untouched: this only ever reads items that already finished,
 * and it never re-encodes. Every step that could lose recorded minutes is ordered so that the
 * merged copy exists before any original is removed.
 */

/** Captures that open within this long of the previous one still belong to the same broadcast. */
const JOIN_GAP_SECONDS = 20 * 60;
/**
 * A group is only spliced once its last capture has been quiet for this long. It has to exceed the
 * join window: that is what makes the pass idempotent. A capture opening after this much silence
 * cannot belong to a group that has already been folded, so no content is ever spliced twice and
 * the work stays linear in the number of segments.
 */
const SETTLE_SECONDS = 30 * 60;
/**
 * Length at which a broadcast is folded even though it never went quiet for the whole settle
 * window -- a room that is on the air around the clock would otherwise never be published at all.
 * A trigger, not a ceiling: the group is folded whole, because one broadcast becoming one file is
 * the point. A group too large to copy safely is held back by the free-space guard instead.
 */
const LONG_BROADCAST_SEGMENTS = 24;
/**
 * Splicing is a full read and write of the session, so a pass deliberately leaves work for the
 * next one instead of draining a large backlog in a single burst -- especially right after a
 * deployment, when every group the library accumulated becomes eligible at once.
 */
const MAX_GROUPS_PER_PASS = 2;
/** How long one ffprobe call may take. Measuring a finished recording is a header read, not a scan. */
const PROBE_TIMEOUT_MS = 30_000;

export type LiveSessionOptions = {
  joinGapSeconds: number;
  settleSeconds: number;
  longBroadcastSegments: number;
  maxGroupsPerPass: number;
};

export const LIVE_SESSION_DEFAULTS: LiveSessionOptions = {
  joinGapSeconds: JOIN_GAP_SECONDS,
  settleSeconds: SETTLE_SECONDS,
  longBroadcastSegments: LONG_BROADCAST_SEGMENTS,
  maxGroupsPerPass: MAX_GROUPS_PER_PASS,
};

/** An auto capture that finished and could be folded into a longer recording. */
export type SessionCandidate = {
  id: string;
  /** `pluginId:room`, the identity two captures must share to be the same broadcast. */
  roomKey: string;
  /** Absolute path of the finished file. */
  file: string;
  /** The capture's canonical media date, which the spliced file inherits. */
  publishedAt?: string;
  startMs: number;
  endMs: number;
};

export type SessionGroup = { roomKey: string; segments: SessionCandidate[] };

export type SpliceReport = {
  groups: number;
  spliced: number;
  /** Files that were folded into a session and removed. */
  segments: number;
  /** Bytes those files held, now free. */
  bytes: number;
  skipped: Array<{ roomKey: string; reason: string }>;
  failed: Array<{ roomKey: string; error: string }>;
};

export type MediaSignature = { duration: number; signature: string };

export type LiveSessionDeps = {
  db: Database;
  mediaRoot: string;
  /** Splices `listPath` into `output`. Wired to the downloader's shared, load-gated post-process slot. */
  concat: (listPath: string, output: string) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  options?: Partial<LiveSessionOptions>;
  now?: () => number;
  freeSpace?: FreeSpaceProbe;
  probe?: (file: string) => Promise<MediaSignature | undefined>;
};

const AUTO_LIVE = /^auto-live:([^:]+):/;

/**
 * The room a capture belongs to: the metadata the recorder writes, falling back to the id it
 * builds. Mirrors the resolver in auto-recorder.ts so both agree on which captures are one room.
 */
export function liveRoomOf(item: DownloadItem): string | undefined {
  const meta = item.metadata as Record<string, unknown> | undefined;
  const declared = typeof meta?.liveRoom === "string" ? meta.liveRoom : undefined;
  const room = (declared ?? AUTO_LIVE.exec(item.externalId)?.[1] ?? "").trim().toLowerCase();
  return room || undefined;
}

/**
 * Auto captures that finished and are still on disk. Manual recordings are excluded on purpose:
 * a manual stop is a deliberate end, and the user may well have wanted a short clip -- it is the
 * unattended captures that pile up.
 */
export function sessionCandidates(rows: DownloadItem[], mediaRoot: string): SessionCandidate[] {
  const candidates: SessionCandidate[] = [];
  for (const item of rows) {
    if (item.status !== "completed" || !item.storagePath) continue;
    if (!item.externalId.startsWith("auto-live:")) continue;
    if ((item.metadata as Record<string, unknown> | undefined)?.live !== true) continue;
    const room = liveRoomOf(item);
    if (!room) continue;
    const startMs = Date.parse(item.downloadStartedAt ?? item.publishedAt ?? "");
    const endMs = Date.parse(item.downloadFinishedAt ?? "");
    // Without both ends the pass cannot tell how long the room has been quiet, and guessing would
    // risk folding a broadcast that is still on the air.
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    candidates.push({
      id: item.id, roomKey: `${item.pluginId}:${room}`, file: path.join(mediaRoot, item.storagePath),
      publishedAt: item.publishedAt, startMs, endMs,
    });
  }
  return candidates;
}

/** Rooms with a capture in flight, which the splicer must leave entirely alone. */
export function activeRoomKeys(rows: DownloadItem[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!ACTIVE_ITEM_STATUSES.includes(row.status)) continue;
    const room = liveRoomOf(row);
    if (room) keys.add(`${row.pluginId}:${room}`);
  }
  return keys;
}

/**
 * Group finished captures into broadcasts. A capture joins the open group while it starts within
 * the join window of the group's last end; a longer gap starts a new group. A group is handed back
 * only when it is provably over -- quiet for the settle window, or long enough that waiting for
 * that much quiet would never come -- and only ever when the quiet already exceeds the join window,
 * which is what keeps the pass idempotent.
 */
export function planSessions(candidates: SessionCandidate[], activeRooms: ReadonlySet<string>, options: LiveSessionOptions, now: number): SessionGroup[] {
  const byRoom = new Map<string, SessionCandidate[]>();
  for (const candidate of candidates) {
    const list = byRoom.get(candidate.roomKey);
    if (list) list.push(candidate);
    else byRoom.set(candidate.roomKey, [candidate]);
  }
  const groups: SessionGroup[] = [];
  for (const [roomKey, list] of byRoom) {
    // A capture still running means the broadcast is not over: its remaining segments have not
    // been written yet, so folding what is on disk would only have to be redone.
    if (activeRooms.has(roomKey)) continue;
    const sorted = [...list].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    let open: SessionCandidate[] = [];
    let openEnd = 0;
    const flush = () => {
      const quietMs = now - openEnd;
      const settled = quietMs >= options.settleSeconds * 1000;
      const tooLong = open.length >= options.longBroadcastSegments;
      if (open.length >= 2 && quietMs >= options.joinGapSeconds * 1000 && (settled || tooLong)) {
        groups.push({ roomKey, segments: open });
      }
      open = [];
    };
    for (const candidate of sorted) {
      if (open.length && candidate.startMs - openEnd > options.joinGapSeconds * 1000) flush();
      openEnd = open.length ? Math.max(openEnd, candidate.endMs) : candidate.endMs;
      open.push(candidate);
    }
    flush();
  }
  // Soonest broadcast first, so a backlog is drained in the order it was recorded.
  return groups.sort((left, right) => lastEnd(left) - lastEnd(right));
}

const lastEnd = (group: SessionGroup): number => Math.max(...group.segments.map((segment) => segment.endMs));

/**
 * Duration plus stream layout of a finished recording. The layout is not decoration: the concat
 * demuxer keeps the FIRST input's streams, so splicing a segment that was captured without audio
 * (the audio resolve is best-effort at capture time) would silently drop that track from the join
 * onwards. Comparing layouts keeps the splice to segments that provably fit together.
 */
export async function probeSignature(file: string): Promise<MediaSignature | undefined> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name", "-of", "json", file], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(undefined); }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => { clearTimeout(timer); resolve(undefined); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(undefined);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          format?: { duration?: string };
          streams?: Array<{ codec_type?: string; codec_name?: string }>;
        };
        const duration = Number(parsed.format?.duration ?? 0);
        const signature = (parsed.streams ?? [])
          .map((stream) => `${stream.codec_type ?? "?"}:${stream.codec_name ?? "?"}`)
          .filter((entry) => !entry.startsWith("data:") && !entry.startsWith("attachment:"))
          .sort()
          .join(",");
        resolve({ duration: Number.isFinite(duration) && duration > 0 ? duration : 0, signature });
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** Windows refuses to rename onto an existing file; POSIX does it atomically. */
function replaceFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
  }
}

type SpliceOutcome = { spliced: true; segments: number; bytes: number } | { spliced: false; reason: string };

type SpliceContext = {
  db: Database;
  mediaRoot: string;
  concat: (listPath: string, output: string) => Promise<void>;
  probe: (file: string) => Promise<MediaSignature | undefined>;
  freeSpace: FreeSpaceProbe;
  /** Free space that must survive the splice. */
  minFreeBytes: number;
  log?: LiveSessionDeps["log"];
};

async function spliceGroup(group: SessionGroup, deps: SpliceContext): Promise<SpliceOutcome> {
  const segments = group.segments;
  const sizes: number[] = [];
  for (const segment of segments) {
    let size = 0;
    try { size = fs.statSync(segment.file).size; } catch { /* reported below */ }
    if (size <= 0) return { spliced: false, reason: `capture ${segment.id} is missing or empty on disk` };
    sizes.push(size);
  }
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const free = await deps.freeSpace(deps.mediaRoot);
  // The merged copy lands beside the segments before any of them is removed, so the pass briefly
  // needs room for both. Below the floor the group simply waits for a later pass.
  if (free !== undefined && free < totalBytes + deps.minFreeBytes) {
    return { spliced: false, reason: `only ${(free / GIB).toFixed(2)} GB free; splicing ${(totalBytes / GIB).toFixed(2)} GB would leave less than the ${(deps.minFreeBytes / GIB).toFixed(2)} GB floor` };
  }

  const signatures: MediaSignature[] = [];
  for (const segment of segments) {
    const signature = await deps.probe(segment.file);
    if (!signature || !(signature.duration > 0)) return { spliced: false, reason: `capture ${segment.id} could not be measured` };
    signatures.push(signature);
  }
  const expectedSeconds = signatures.reduce((sum, signature) => sum + signature.duration, 0);
  const layouts = new Set(signatures.map((signature) => signature.signature));
  if (layouts.size > 1) {
    return { spliced: false, reason: `captures do not share one stream layout (${[...layouts].join(" | ")})` };
  }

  const output = `${segments[0].file}.session.mp4`;
  const listPath = `${segments[0].file}.session.concat.txt`;
  try {
    fs.writeFileSync(listPath, segments.map((segment) => `file '${segment.file.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
    await deps.concat(listPath, output);
    if (!fs.existsSync(output) || fs.statSync(output).size <= 0) throw new Error("the splice produced no file");
    const spliced = await deps.probe(output);
    const tolerance = Math.max(5, expectedSeconds * 0.02);
    if (!spliced || !(spliced.duration > 0) || spliced.duration < expectedSeconds - tolerance) {
      throw new Error(`the splice holds ${(spliced?.duration ?? 0).toFixed(1)}s of the ${expectedSeconds.toFixed(1)}s its captures measured`);
    }
    // The merged file now holds every byte, so the only irreversible step left is removing the
    // originals -- publish first, retire after.
    replaceFile(output, segments[0].file);
    const date = new Date(segments[0].publishedAt ?? segments[0].startMs);
    // Same contract as the downloader's applyMediaDate for video: the filesystem mtime IS the media
    // date the library sorts by, so the spliced recording keeps the broadcast's date.
    if (!Number.isNaN(date.valueOf())) fs.utimesSync(segments[0].file, date, date);
    const absorbed = segments.slice(1);
    for (const segment of absorbed) {
      // The file goes BEFORE the row leaves `completed`. A crash in between then leaves a finished
      // row whose file is gone, and the next pass refuses to splice a group it cannot fully measure
      // -- so nothing can be folded twice. Retiring the row first would instead leave two completed
      // captures behind, and the next pass would happily splice segment two into segment one's
      // file a second time, duplicating content that the merged file already holds.
      try { fs.unlinkSync(segment.file); } catch { /* the scan hides the row either way */ }
      deps.db.supersedeDownload(segment.id, segments[0].id);
    }
    deps.db.markSessionCollapsed(segments[0].id, { finishedAt: new Date(lastEnd(group)).toISOString(), segmentIds: absorbed.map((segment) => segment.id) });
    deps.log?.(`live-session: spliced ${segments.length} captures of ${group.roomKey} into one recording`, {
      itemId: segments[0].id, roomKey: group.roomKey, segments: segments.length,
      bytes: totalBytes, absorbed: absorbed.map((segment) => segment.id),
    });
    return { spliced: true, segments: absorbed.length, bytes: totalBytes - sizes[0] };
  } finally {
    // A successful splice already renamed `output` into place, so these are no-ops then.
    for (const leftover of [output, listPath]) {
      try { fs.rmSync(leftover, { force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Fold every finished broadcast that is over back into one recording. Runs periodically, never
 * throws, and leaves a group untouched whenever it cannot prove the splice is sound.
 */
export async function spliceLiveSessions(deps: LiveSessionDeps): Promise<SpliceReport> {
  const options = { ...LIVE_SESSION_DEFAULTS, ...deps.options };
  const now = deps.now?.() ?? Date.now();
  const probe = deps.probe ?? probeSignature;
  const freeSpace = deps.freeSpace ?? freeBytes;
  // Hold back the same floor the recording guard holds back, so a splice can never be the reason a
  // live capture runs out of room.
  const configuredFloor = Number(deps.db.getSettings().minFreeDiskGb);
  const minFreeBytes = (Number.isFinite(configuredFloor) && configuredFloor > 0 ? configuredFloor : 1) * GIB;

  const report: SpliceReport = { groups: 0, spliced: 0, segments: 0, bytes: 0, skipped: [], failed: [] };
  const rows = deps.db.listLiveItems([...ACTIVE_ITEM_STATUSES, "completed"]);
  const candidates = sessionCandidates(rows, deps.mediaRoot);
  if (candidates.length < 2) return report;
  const groups = planSessions(candidates, activeRoomKeys(rows), options, now);
  report.groups = groups.length;

  for (const group of groups.slice(0, Math.max(1, options.maxGroupsPerPass))) {
    try {
      const outcome = await spliceGroup(group, { db: deps.db, mediaRoot: deps.mediaRoot, concat: deps.concat, probe, freeSpace, minFreeBytes, log: deps.log });
      if (outcome.spliced) {
        report.spliced += 1;
        report.segments += outcome.segments;
        report.bytes += outcome.bytes;
      } else {
        report.skipped.push({ roomKey: group.roomKey, reason: outcome.reason });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ roomKey: group.roomKey, error: message });
      deps.log?.(`live-session: could not splice ${group.roomKey}; every capture was left untouched`, { roomKey: group.roomKey, error: message });
    }
  }
  return report;
}
