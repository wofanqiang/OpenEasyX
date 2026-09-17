import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { Database, DownloadItem } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";
import type { LogWriter } from "./log-store.js";
import { filenameFromUrl, safeSegment } from "./utils.js";
import { downloadOutputPath, recordingEncodingArgs } from "./output-settings.js";
import { outputSettings } from "../packages/output-settings.js";
import { liveRecordingRequest } from "../packages/live-capture.js";
import { avSyncPlan, readAvSyncSidecar, startAvSyncMeasurement, type AvSyncWatcher } from "../packages/av-sync-measure.js";
import type { LiveStream, MediaCandidate } from "../packages/plugin-sdk/index.js";
import type { LogLevel } from "./log-store.js";
import { reapOrphans, reapModeFromEnv } from "./process-reap.js";
import { PostProcessGate } from "./postprocess-gate.js";
import type { HlsProxy } from "./hls-proxy.js";

type ActiveDownload = { child?: ChildProcess; closed?: Promise<void>; abort?: AbortController; paused: boolean; encoding?: boolean; action?: "stop" | "cancel" | "delete"; stalled?: boolean; live?: boolean; manualStop?: boolean; lastOutput?: string };

// Concurrency lives in two independent pools. Downloads keep their historical range so the
// setting keeps meaning what it always meant; recordings get their own, larger one because a
// broadcast is time sensitive and cannot be retried later.
const DEFAULT_MAX_DOWNLOADS = 2;
const MAX_DOWNLOADS = 8;
// Default lowered from 8: on the small (1-core / 1.6GB) boxes this app commonly runs on,
// eight simultaneous ffmpeg captures starve the very recordings they serve (measured: the
// captures fall to ~50% of real time, fall behind the LL-HLS edge, and the CDN starts
// evicting segments -> "recorded 30 minutes, got 3"). Four is the measured safe ceiling
// for pure pulls on one core; `clampedRecordingLimit` enforces it for explicit settings too.
const DEFAULT_MAX_RECORDINGS = 4;
const MAX_RECORDINGS = 32;
// A stale staging directory that still holds media is worth rescuing (A10); anything else
// in .downloads is scaffolding (sidecars, empty dirs) and is simply removed.
const MEDIA_EXTENSIONS = new Set([".ts", ".mp4", ".mkv", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".jpg", ".jpeg", ".png", ".webp"]);
// The recovery area must not grow without bound (P3): cap it by entries and bytes and evict
// the oldest directories first when a move would exceed either.
const RECOVERY_MAX_ENTRIES = 50;
const RECOVERY_MAX_BYTES = 20 * 1024 ** 3;

/** Clamp a configured concurrency value into the range the pool can serve. */
export function concurrentLimit(value: unknown, fallback: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(raw)));
}

/**
 * Cap the recording pool by the machine's size: roughly two captures per core, with a
 * floor of 4 (a pure ffmpeg pull is cheap, and a 1-core box measurably sustains four).
 * A generous setting on a tiny box used to self-destruct: the captures starved each
 * other, fell behind the live edge, and produced truncated recordings. The operator's
 * value is kept whenever it already fits the budget.
 */
export function clampedRecordingLimit(value: number, cores: number): number {
  return Math.min(value, Math.max(4, cores * 2));
}

/**
 * The slots that may start right now, recordings first. Recordings lead because a live
 * broadcast cannot be re-downloaded later, while a backfill download can wait.
 */
export function slotPlan(
  counts: { recordings: number; downloads: number },
  limits: { recordings: number; downloads: number },
): Array<"recording" | "download"> {
  const plan: Array<"recording" | "download"> = [];
  for (let i = Math.max(0, limits.recordings - counts.recordings); i > 0; i--) plan.push("recording");
  for (let i = Math.max(0, limits.downloads - counts.downloads); i > 0; i--) plan.push("download");
  return plan;
}

/**
 * Whether the download stall timer should give up on the running item.
 *
 * Post-processing (TS remux, live re-encode) reports no progress by design: ffmpeg frame
 * counters are not relayed as download progress and the staging directory already holds the
 * capture, so `lastActivity` freezes for the whole step. Treating that as a stall SIGKILLs
 * ffmpeg halfway through the `+faststart` pass, which for a multi-GB capture takes minutes --
 * exactly how long recordings used to "fail" right after the capture had already finished.
 * Those steps run under `postProcessDeadlineMs` instead.
 */
export function stalledDownload(control: Pick<ActiveDownload, "encoding" | "action" | "paused">, lastActivity: number, now: number, timeoutMs: number): boolean {
  if (control.encoding) return false;
  if (control.action || control.paused) return false;
  return now - lastActivity > timeoutMs;
}

/**
 * Deadline for a post-processing step that cannot report progress. The budget scales with
 * the input because `+faststart` rewrites the whole file and a re-encode runs slower than
 * realtime: 4 MiB/s, floored at 8 minutes and capped at 45 minutes.
 */
export function postProcessDeadlineMs(inputBytes: number): number {
  const scaled = Math.ceil(Math.max(0, inputBytes) / (4 * 1024 * 1024)) * 1000;
  return Math.min(45 * 60_000, Math.max(8 * 60_000, scaled));
}

/** HTTP status codes a media URL can never recover from: the resource is gone for good. */
const PERMANENT_HTTP_STATUS = new Set([404, 410]);
/**
 * 403 is deliberately NOT permanent on the first strike: many CDNs answer with 403 for an
 * expired signed URL, which a fresh stream resolution fixes. It only becomes permanent once a
 * retry has already failed, so a genuinely forbidden resource still stops wasting a slot.
 */
const RETRY_ONCE_HTTP_STATUS = new Set([403]);

/** Pull the first 4xx/5xx HTTP status out of a download error message, if the message carries one. */
export function httpStatusFromError(message: string): number | undefined {
  const patterns = [
    /download returned http\s*(\d{3})/i,
    /server returned\s*(\d{3})/i,
    /http error\s*(\d{3})/i,
    /status(?:\s*code)?[:\s]+(\d{3})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const status = Number(match[1]);
    if (status >= 400 && status <= 599) return status;
  }
  return undefined;
}

/**
 * Decide whether a failed download is worth retrying.
 *
 * Only an *explicit* HTTP status may mark a failure permanent: 404/410 mean the media is gone,
 * and 403 is treated as an expired token that survives exactly one retry. Everything else --
 * 5xx, 400/401, timeouts, socket resets, stalls -- stays retryable, because a wrong
 * "permanent" verdict would drop a recording a plain retry would have saved.
 */
export function retryDisposition(message: string, attempts: number): "permanent" | "retry" {
  const status = httpStatusFromError(message);
  if (status === undefined) return "retry";
  if (PERMANENT_HTTP_STATUS.has(status)) return "permanent";
  if (RETRY_ONCE_HTTP_STATUS.has(status) && attempts >= 2) return "permanent";
  return "retry";
}

/** File name pattern of one rolling MPEG-TS capture segment (A10 segmented live capture). */
const CAPTURE_SEGMENT_PATTERN = /^capture_part(\d+)\.ts$/;

/**
 * Segmented live captures land as capture_part000.ts, capture_part001.ts, ... Sorted by
 * their numeric index. With skipEmpty, zero-byte parts are dropped: an aborted capture can
 * leave an empty tail part that must neither be concatenated nor block a later salvage.
 */
export function captureSegmentFiles(directory: string, options: { skipEmpty?: boolean } = {}): string[] {
  try {
    return fs.readdirSync(directory)
      .map((name) => ({ name, index: Number(CAPTURE_SEGMENT_PATTERN.exec(name)?.[1] ?? NaN) }))
      .filter((entry) => Number.isInteger(entry.index))
      .sort((a, b) => a.index - b.index)
      .map((entry) => path.join(directory, entry.name))
      .filter((file) => !options.skipEmpty || fs.statSync(file).size > 0);
  } catch {
    return [];
  }
}

/** The segment number a NEW capture attempt must start at, so a resumed recording never overwrites an earlier part. */
export function nextSegmentStart(directory: string): number {
  let max = -1;
  try {
    for (const name of fs.readdirSync(directory)) {
      const index = Number(CAPTURE_SEGMENT_PATTERN.exec(name)?.[1] ?? NaN);
      if (Number.isInteger(index) && index > max) max = index;
    }
  } catch { /* no directory yet: start fresh */ }
  return max + 1;
}

/** ffmpeg arguments that concatenate capture parts into one TS via the concat demuxer. */
export function concatCaptureArgs(listPath: string, output: string): string[] {
  return ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", output];
}

export class DownloadQueue {
  private active = new Map<string, ActiveDownload>();
  private finalizers = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private lowPrioritySupport?: boolean;
  private recordingLimitWarned = false;
  private readonly postProcessGate: PostProcessGate;
  constructor(
    private db: Database,
    private plugins: PluginManager,
    private mediaRoot: string,
    private writeLog?: LogWriter,
    private onCompleted?: () => unknown | Promise<unknown>,
    private onDeleteCompleted?: (item: DownloadItem) => unknown,
    private readonly liveProxy?: HlsProxy,
    private readonly selfOrigin?: string,
    private readonly onLiveFailure?: (item: DownloadItem, message: string) => void,
  ) {
    // Post-processing (concat fold / TS remux / re-encode) runs serialized and load-gated:
    // N workers finishing at once must not start N concurrent ffmpeg remuxes, because on a
    // small VPS that saturates the CPU and starves the live captures themselves (measured:
    // 1-core box, loadavg 13, capture throughput ~0). Concurrency and thresholds are tunable
    // via EASYX_POSTPROCESS_CONCURRENCY / _LOAD_PAUSE / _LOAD_RESUME.
    this.postProcessGate = PostProcessGate.fromEnv((level, message, meta) => this.writeLog?.(level, "download", message, meta));
  }

  /**
   * Record through the app's own HLS proxy when a plugin asks for it by setting
   * `playlistDecodeKey`. ffmpeg cannot de-obfuscate a playlist itself, and it does not send a
   * provider's private headers, so for those streams the proxy is not an optimisation but the
   * only thing that makes recording possible. Providers that do not opt in are untouched.
   */
  private recordThroughProxy(stream: LiveStream): string | undefined {
    if (!stream.playlistDecodeKey || !this.liveProxy || !this.selfOrigin) return undefined;
    return this.selfOrigin + this.liveProxy.register(stream);
  }

  start() {
    fs.mkdirSync(this.mediaRoot, { recursive: true });
    fs.mkdirSync(this.downloadsRoot, { recursive: true, mode: 0o700 });
    this.db.requeueInterruptedDownloads();
    const mode = reapModeFromEnv();
    const protectedDirs = mode === "off"
      ? new Set<string>()
      : reapOrphans({
          mode,
          log: (level, scope, message, meta) => this.writeLog?.(level as LogLevel, scope, message, meta),
        });
    this.cleanupStaleDownloads(protectedDirs);
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }

  stop(timeoutMs = Number(process.env.EASYX_STOP_REAP_MS ?? 25_000)) {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const controls = [...this.active.values()];
    for (const control of controls) { this.signal(control, "SIGTERM"); control.abort?.abort(); }
    const deadline = Date.now() + timeoutMs;
    return Promise.all(controls.map((control) => this.waitForExit(control, deadline))).then(() => undefined);
  }

  /** Process ids of the children this queue is running right now. The diagnostics orphan scan
   *  needs them: a healthy live capture matches the "stray ffmpeg" pattern just as well as a
   *  crash leftover does, and only ownership tells the two apart. */
  activePids(): number[] {
    return [...this.active.values()]
      .map((control) => control.child?.pid)
      .filter((pid): pid is number => typeof pid === "number");
  }

  /** Wait for a child to exit, escalating SIGTERM -> SIGKILL if it outlives the grace window.
   *  Detached ffmpeg reparents to init when node dies, so we MUST confirm exit before the
   *  process leaves or the capture keeps running (and writing to a deleted dir) forever. */
  private async waitForExit(control: ActiveDownload, deadline: number): Promise<void> {
    const exit = control.closed;
    if (!exit) return;
    const remaining = Math.max(0, deadline - Date.now());
    await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, remaining))]);
    const child = control.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      this.signal(control, "SIGKILL");
      await exit.catch(() => {});
    }
  }

  pause(itemId: string) {
    const item = this.requiredItem(itemId);
    if (item.status === "queued") return this.db.setItemStatus(itemId, "paused");
    const control = this.active.get(itemId);
    if (item.status !== "downloading" || !control) throw Object.assign(new Error(`Cannot pause an item with status '${item.status}'`), { statusCode: 409 });
    control.paused = true;
    if (control.child) this.signal(control, "SIGSTOP");
    else control.abort?.abort();
    return this.db.setItemStatus(itemId, "paused");
  }

  resume(itemId: string) {
    const item = this.requiredItem(itemId);
    if (item.status !== "paused") throw Object.assign(new Error(`Cannot resume an item with status '${item.status}'`), { statusCode: 409 });
    const control = this.active.get(itemId);
    if (!control) return this.db.setItemStatus(itemId, "queued");
    control.paused = false; this.signal(control, "SIGCONT");
    return this.db.setItemStatus(itemId, "downloading");
  }

  stopRecording(itemId: string) { return this.interrupt(itemId, "stop"); }
  cancel(itemId: string) { return this.interrupt(itemId, "cancel"); }
  delete(itemId: string) {
    const item = this.requiredItem(itemId);
    if (["downloading", "paused"].includes(item.status) && this.active.has(itemId)) return this.interrupt(itemId, "delete");
    let mediaDeletion: unknown;
    if (item.status === "completed") {
      if (!item.storagePath) throw Object.assign(new Error("Completed item has no stored media path"), { statusCode: 409 });
      if (!this.onDeleteCompleted) throw Object.assign(new Error("Completed media deletion is not configured"), { statusCode: 409 });
      mediaDeletion = this.onDeleteCompleted(item);
    }
    this.db.deleteItem(itemId);
    return { deleted: true, id: itemId, ...(mediaDeletion && typeof mediaDeletion === "object" ? mediaDeletion : {}) };
  }

  outputPath(itemId: string) {
    const item = this.requiredItem(itemId); if (item.storagePath) return item.storagePath;
    const performer = this.db.getPerformer(item.performerId); const source = this.db.getSource(item.sourceId);
    const fallback = `${item.externalId}.${item.mediaType === "image" ? "jpg" : item.mediaType === "video" ? "mp4" : "bin"}`;
    return downloadOutputPath(this.db.getSettings(), item, performer?.name ?? "Unknown", source?.domain ?? "unknown", item.filename ?? fallback);
  }

  private requiredItem(itemId: string) {
    const item = this.db.getItem(itemId);
    if (!item) throw Object.assign(new Error("Item not found"), { statusCode: 404 });
    return item;
  }

  private interrupt(itemId: string, action: ActiveDownload["action"]) {
    const item = this.requiredItem(itemId); const control = this.active.get(itemId);
    if (action === "stop" && control?.encoding) return item;
    if (!control) {
      if (!["queued", "paused"].includes(item.status)) throw Object.assign(new Error(`Cannot ${action} an item with status '${item.status}'`), { statusCode: 409 });
      return this.db.setItemStatus(itemId, action === "delete" ? "deleted" : "cancelled");
    }
    control.action = action; control.paused = false;
    if (action === "stop") control.manualStop = true;
    this.signal(control, "SIGCONT"); this.signal(control, action === "stop" ? "SIGINT" : "SIGTERM"); control.abort?.abort();
    return this.db.setItemStatus(itemId, action === "stop" ? "stopping" : "cancelling");
  }

  /** Active items split by pool: live recordings and everything else. */
  private activeCounts() {
    let recordings = 0;
    for (const control of this.active.values()) if (control.live) recordings++;
    return { recordings, downloads: this.active.size - recordings };
  }

  private startItem(item: DownloadItem) {
    // Read the live flag off the item itself, so slot accounting can never disagree with
    // the branch download() takes (both keyed on metadata.live).
    const control: ActiveDownload = { paused: false, live: (item.metadata as Record<string, unknown> | undefined)?.live === true };
    this.active.set(item.id, control);
    this.db.setItemStatus(item.id, "downloading", { progress: 0 });
    this.writeLog?.("info", "download", "Download started", { itemId: item.id, pluginId: item.pluginId, title: item.title, mediaType: item.mediaType });
    // `.finally()` does not swallow rejections. Anything thrown while recording the
    // outcome (setItemStatus, scheduleRetry) would otherwise escape as an unhandled
    // rejection, so catch it here and keep the queue's slot accounting intact.
    void this.download(item, control).catch((error) => {
      this.writeLog?.("error", "download", "Download failed outside of its own error handling", { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => this.active.delete(item.id));
  }

  private tick() {
    const settings = this.db.getSettings();
    const configuredRecordings = concurrentLimit(settings.maxConcurrentRecordings, DEFAULT_MAX_RECORDINGS, MAX_RECORDINGS);
    const effectiveRecordings = clampedRecordingLimit(configuredRecordings, Math.max(1, os.cpus().length));
    if (effectiveRecordings < configuredRecordings && !this.recordingLimitWarned) {
      this.recordingLimitWarned = true;
      this.writeLog?.("warn", "download", `maxConcurrentRecordings=${configuredRecordings} exceeds what ${os.cpus().length} core(s) can sustain; capping the recording pool at ${effectiveRecordings}`, { configured: configuredRecordings, effective: effectiveRecordings, cores: os.cpus().length });
    }
    const limits = {
      recordings: effectiveRecordings,
      downloads: concurrentLimit(settings.maxConcurrentDownloads, DEFAULT_MAX_DOWNLOADS, MAX_DOWNLOADS),
    };
    // Each pool drains only its own queue, so a recording can never be blocked behind a
    // backfill and a backfill can never be blocked behind a broadcast. A pool whose queue
    // is empty yields nothing and the plan simply moves on to the other one.
    for (const kind of slotPlan(this.activeCounts(), limits)) {
      const item = this.db.nextQueued(kind === "recording");
      if (!item || this.active.has(item.id)) continue;
      // One capture per room. A second live item for a source that is already capturing would
      // open another ffmpeg on the same broadcast; the two then starve each other and end
      // together. Close the newcomer as a duplicate of the capture in flight instead.
      if (kind === "recording") {
        const inFlight = this.db.activeLiveItemForSource(item.sourceId, item.id);
        if (inFlight) {
          this.db.setItemStatus(item.id, "duplicate", {
            duplicateOf: inFlight.id,
            error: `Another live capture of this source is already running (${inFlight.id})`,
          });
          this.writeLog?.("warn", "download", "Live item closed as a duplicate: this source is already being captured", { itemId: item.id, duplicateOf: inFlight.id, title: item.title });
          continue;
        }
      }
      this.startItem(item);
    }
  }

  private async download(item: DownloadItem, control: ActiveDownload) {
    let temporary = "";
    let temporaryDirectory = "";
    let preserveTemporary = false;
    let recordingFinalize = false;
    let avWatcher: AvSyncWatcher | undefined;
    let lastProgress = 0; let lastBytes = 0; let lastProgressUpdate = 0; let lastActivity = Date.now();
    // Stall detection must key off *byte growth*, not "any progress report". The staging
    // poll below calls reportProgress every 1.5s whenever the output directory holds >0
    // bytes, so a live capture that stopped growing (the recorder fell behind the broadcast
    // edge and the CDN started evicting segments) used to refresh lastActivity forever and
    // the stall timer never fired -- the mechanism behind "recorded 30 minutes, got 3".
    // lastByteGrowthAt only advances when the byte count actually rises.
    let lastByteGrowthAt = Date.now();
    let lastSampledBytes = 0;
    // On top of the stall gate, a sustained near-zero growth rate is the earliest symptom of
    // "losing the race against the live edge" (403s typically follow within minutes), so warn
    // about it while there is still time to react.
    const isLiveRecording = (item.metadata as Record<string, unknown> | undefined)?.live === true;
    const LOW_RATE_BYTES_PER_S = 200 * 1024;
    const LOW_RATE_SUSTAIN_MS = 30_000;
    const LOW_RATE_WARN_INTERVAL_MS = 5 * 60_000;
    let rateAnchorAt = Date.now();
    let rateAnchorBytes = 0;
    let lastLowRateWarnAt = 0;
    const noteBytes = (stamp: number, bytes: number) => {
      if (bytes > lastSampledBytes) lastByteGrowthAt = stamp;
      lastSampledBytes = bytes;
      if (!isLiveRecording || control.encoding || control.action || control.paused) { rateAnchorAt = stamp; rateAnchorBytes = bytes; return; }
      // No bytes yet says nothing about falling behind (a slow resolve has not started
      // writing); the stall timer owns the "never produced output" case.
      if (bytes === 0) { rateAnchorAt = stamp; return; }
      const elapsed = stamp - rateAnchorAt;
      if (elapsed < LOW_RATE_SUSTAIN_MS) return;
      const rate = (bytes - rateAnchorBytes) / (elapsed / 1000);
      if (rate < LOW_RATE_BYTES_PER_S && stamp - lastLowRateWarnAt >= LOW_RATE_WARN_INTERVAL_MS) {
        lastLowRateWarnAt = stamp;
        this.writeLog?.("warn", "download", `Live capture is falling behind the broadcast (${Math.round(rate / 1024)} KB/s over the last ${Math.round(elapsed / 1000)}s); the room is about to outrun this recording`, { itemId: item.id, rateBps: Math.round(rate) });
      }
      rateAnchorAt = stamp; rateAnchorBytes = bytes;
    };
    const reportProgress = (progress?: number, downloadedBytes?: number, force = false) => {
      const nextProgress = progress === undefined ? lastProgress : Math.max(lastProgress, Math.min(0.99, Math.max(0, progress)));
      const nextBytes = downloadedBytes === undefined ? lastBytes : Math.max(lastBytes, downloadedBytes);
      const stamp = Date.now();
      noteBytes(stamp, nextBytes);
      if (!force && stamp - lastProgressUpdate < 250 && nextProgress - lastProgress < 0.005 && nextBytes - lastBytes < 256 * 1024) { lastActivity = stamp; return; }
      lastProgress = nextProgress; lastBytes = nextBytes; lastProgressUpdate = stamp; lastActivity = stamp;
      if (!control.action) this.db.setItemStatus(item.id, control.paused ? "paused" : "downloading", { progress: nextProgress, downloadedBytes: nextBytes });
    };
    const stallTimeoutMs = Math.max(0, Number(this.db.getSettings().downloadStallTimeoutSeconds ?? 120)) * 1000;
    const stallTimer = stallTimeoutMs > 0 ? setInterval(() => {
      if (!stalledDownload(control, lastByteGrowthAt, Date.now(), stallTimeoutMs)) return;
      control.stalled = true; control.abort?.abort(); this.signal(control, "SIGKILL");
    }, 5000) : undefined;
    stallTimer?.unref();
    try {
      const plugin = this.plugins.get(item.pluginId);
      const performer = this.db.getPerformer(item.performerId); const source = this.db.getSource(item.sourceId);
      if (!performer || !source) throw new Error("The performer or source no longer exists");
      const settings = outputSettings(this.db.getSettings());
      const context = this.plugins.context(item.pluginId);
      const candidate: MediaCandidate = {
        externalId: item.externalId, identityKey: item.identityKey, title: item.title, pageUrl: item.pageUrl,
        mediaType: item.mediaType as MediaCandidate["mediaType"], filename: item.filename, qualityScore: item.qualityScore,
        expectedBytes: item.expectedBytes, publishedAt: item.publishedAt, metadata: item.metadata,
      };
      // TS-first live capture wins over the plugin's own download path: any live item
      // records as ffmpeg MPEG-TS (then the remux below turns it into MP4) no matter
      // which plugin resolved it. Non-live items and plugins without a live resolver
      // keep using resolveDownload unchanged.
      const request = (await liveRecordingRequest(plugin, context, candidate, (stream) => this.recordThroughProxy(stream)))
        ?? (plugin.resolveDownload ? await plugin.resolveDownload(context, candidate) : undefined);
      if (!request) throw new Error("This plugin cannot resolve downloads");
      const fallback = `${item.externalId}.${item.mediaType === "image" ? "jpg" : item.mediaType === "video" ? "mp4" : "bin"}`;
      const requestUrl = request.kind === "command" ? item.pageUrl ?? item.externalId : request.url;
      const filename = safeSegment(request.filename ?? item.filename ?? filenameFromUrl(requestUrl, fallback), fallback);
      const destination = path.join(this.mediaRoot, downloadOutputPath(settings, item, performer.name, source.domain, filename));
      this.prepareOutputDirectory(path.dirname(destination));
      temporaryDirectory = path.join(this.downloadsRoot, safeSegment(item.id, "download"));
      // Resume rules: a retry keeps the staging directory so the partial file can be
      // continued (fetch via Range, yt-dlp via its .part files). A live capture resumes too
      // when segmented parts survived (A10): the new attempt appends at the next segment
      // number instead of discarding the recorded minutes. Anything else -- a first
      // attempt, or a live capture with no salvageable parts (a broadcast cannot be
      // re-joined where it died) -- starts from a clean directory.
      const isLiveItem = (item.metadata as Record<string, unknown> | undefined)?.live === true;
      const segmentStart = isLiveItem && fs.existsSync(temporaryDirectory) ? nextSegmentStart(temporaryDirectory) : 0;
      const keepStaging = segmentStart > 0 || ((item.attempts ?? 0) > 0 && !isLiveItem && fs.existsSync(temporaryDirectory));
      if (keepStaging) {
        this.writeLog?.("info", "download", segmentStart > 0
          ? `Retry continues the segmented capture at part ${segmentStart}`
          : "Retry resumes the partial staging files", { itemId: item.id, attempts: item.attempts, segmentStart });
      } else {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
      temporary = path.join(temporaryDirectory, filename);
      let checksum: string;
      if (request.kind === "command") {
        // For a live dual-HLS capture, measure the constant A/V offset while
        // ffmpeg records: watch the first segment opened per input on stderr
        // and map it to the playlist's PROGRAM-DATE-TIME. The result lands in
        // a sidecar JSON next to capture.ts, consumed by the remux below.
        if ((item.metadata as Record<string, unknown> | undefined)?.live === true && temporaryDirectory) {
          const plan = avSyncPlan(request.args, temporaryDirectory);
          if (plan) avWatcher = await startAvSyncMeasurement(plan, (message) => this.writeLog?.("info", "download", message, { itemId: item.id }));
        }
        const placeholders: Record<string, string> = {
          "{output}": temporary,
          "{outputDir}": path.dirname(temporary),
          "{outputName}": path.basename(temporary),
          // A10: a resumed segmented capture starts after the parts already on disk.
          "{segmentStart}": String(segmentStart),
        };
        await this.runCommandDownload(request.command, request.args.map((argument) => {
          for (const [placeholder, value] of Object.entries(placeholders)) argument = argument.replaceAll(placeholder, value);
          return argument;
        }), temporaryDirectory, item.expectedBytes, reportProgress, control, avWatcher?.onStderr);
        // Live captures land as MPEG-TS (capture.ts); remux to MP4 in place and
        // delete the TS so every downstream step only ever sees a .mp4 file.
        // Gated on the TS file actually existing so non-TS captures are untouched.
        if ((item.metadata as Record<string, unknown> | undefined)?.live === true) {
          const tsPath = path.join(temporaryDirectory, "capture.ts");
          // A10: a segmented capture lands as capture_partNNN.ts files. Fold them into the
          // single capture.ts the remux step expects: one part is renamed outright, several
          // are concatenated losslessly (-c copy through the concat demuxer). ffmpeg's
          // segment muxer only cuts on TS packet boundaries, so the join adds no A/V gap.
          const parts = captureSegmentFiles(temporaryDirectory, { skipEmpty: true });
          if (parts.length && !fs.existsSync(tsPath)) {
            // The capture already ended, so a late "stop" must not abort the fold-in (it would
            // discard a finished recording). A "cancel"/"delete" is kept so the post-process
            // checks below can still end the item as cancelled/deleted.
            if (control.action === "stop") control.action = undefined;
            control.encoding = true;
            recordingFinalize = true;
            this.db.setItemStatus(item.id, "downloading", { progress: 0.99 });
            const partBytes = parts.reduce((total, part) => total + fs.statSync(part).size, 0);
            if (parts.length === 1) {
              fs.renameSync(parts[0], tsPath);
            } else {
              this.writeLog?.("info", "download", `Concatenating ${parts.length} segmented capture parts`, { itemId: item.id, partBytes });
              const listPath = path.join(temporaryDirectory, "capture.concat.txt");
              fs.writeFileSync(listPath, parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
              await this.postProcessGate.run("Concat", () =>
                this.withPostProcessDeadline(control, partBytes, "Concat",
                  () => this.runPostProcessCommand("ffmpeg", concatCaptureArgs(listPath, tsPath), temporaryDirectory, control)));
              if (!fs.existsSync(tsPath) || fs.statSync(tsPath).size === 0) throw new Error("Concatenation completed without producing a media file");
            }
          }
          if (fs.existsSync(tsPath) && fs.statSync(tsPath).size > 0) {
            const mp4Staging = path.join(temporaryDirectory, "encoded.mp4");
            // A live capture ends either because the user pressed stop or because the
            // stream went offline, and in both cases the capture is already finished:
            // the remux below concludes the recording, it is not a fresh download.
            // A "stop" is cleared *before* spawning ffmpeg because runCommandDownload
            // immediately signals a child spawned while control.action is still set; left
            // as "stop" it would SIGINT the remux the instant it starts and discard the
            // whole capture. A "cancel"/"delete" is kept so the remux is aborted and the
            // post-process check throws, ending the item as cancelled/deleted.
            if (control.action === "stop") control.action = undefined;
            control.encoding = true;
            recordingFinalize = true;
            this.db.setItemStatus(item.id, "downloading", { progress: 0.99 });
            this.writeLog?.("info", "download", "Remuxing live TS capture to MP4", { itemId: item.id });
            // Measure the constant A/V skew baked into the capture by the dual-HLS
            // recording command: video and audio come from two independent HLS
            // playlists opened by ffmpeg at slightly different moments, so each
            // input starts at its own live edge and capture.ts carries a fixed
            // content offset (audio typically ahead 1-3s). The offset is invisible
            // in capture.ts itself (the TS muxer rebases both start_times equal),
            // so the primary source is the sidecar written during capture from the
            // playlists' PROGRAM-DATE-TIME (see packages/av-sync-measure.ts).
            // `-async 1` cannot remove a constant offset, so the audio PTS are
            // shifted by the measured delta via `asetpts` while re-encoding to
            // AAC. Video is copied. Without a sidecar, fall back to probing
            // start_time (works for sources whose raw PTS differ visibly).
            await this.remuxCaptureToMp4(tsPath, mp4Staging, control);
            fs.unlinkSync(tsPath);
            fs.renameSync(mp4Staging, temporary);
          }
        }
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size === 0) throw new Error("Extractor completed without producing a media file");
        reportProgress(0.99, fs.statSync(temporary).size, true);
        checksum = await this.hashFile(temporary);
      } else {
        const controller = new AbortController(); control.abort = controller;
        // A9 resume: when a retry finds a partial file, ask the server to continue from the
        // bytes already on disk. Only a 206 whose Content-Range starts at (or before) the
        // staging size may be appended; a 200 means the server ignored the Range, so the
        // write truncates and the body is taken as the complete file.
        const stagingBytes = fs.existsSync(temporary) ? fs.statSync(temporary).size : 0;
        const mayResume = stagingBytes > 0 && (item.attempts ?? 0) > 0;
        const resumeFetch = (range: boolean) => fetch(request.url, {
          method: request.method ?? "GET",
          headers: range ? { ...request.headers, Range: `bytes=${stagingBytes}-` } : request.headers,
          body: request.body, redirect: "follow", signal: controller.signal,
        });
        let response = await resumeFetch(mayResume);
        if (response.status === 416 && mayResume) {
          // The staging file already holds everything: the previous attempt died after the
          // last byte landed (during hashing or the move into place). Take the whole body.
          response = await resumeFetch(false);
        }
        if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`);
        const contentRange = response.status === 206 ? response.headers.get("content-range") ?? "" : "";
        const resumeStart = /^bytes (\d+)-/i.exec(contentRange)?.[1];
        const totalFromRange = /\/(\d+)\s*$/.exec(contentRange)?.[1];
        if (response.status === 206 && resumeStart === undefined) {
          void response.body.cancel().catch(() => {});
          throw new Error("Server answered the Range request with 206 but no Content-Range header");
        }
        const resumeOffset = Number(resumeStart ?? 0);
        if (response.status === 206 && resumeOffset > stagingBytes) {
          // A 206 starting beyond what we hold would leave a gap in the file: unusable.
          // Fail so the normal retry path takes over instead of writing corrupt media.
          void response.body.cancel().catch(() => {});
          throw new Error(`Server resumed from byte ${resumeOffset} but staging holds ${stagingBytes}; the missing range cannot be filled`);
        }
        if (response.status === 206 && resumeOffset < stagingBytes) {
          // The server is continuing from a lower offset than we hold: truncate to its
          // offset so the bytes it is about to send stay contiguous with the file.
          fs.truncateSync(temporary, resumeOffset);
        }
        const append = response.status === 206;
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        const totalSize = append ? (Number(totalFromRange) || resumeOffset + contentLength) : (contentLength || item.expectedBytes || 0);
        const baseBytes = append ? resumeOffset : 0;
        const hash = createHash("sha256"); let received = 0;
        const readable = Readable.fromWeb(response.body as any);
        readable.on("data", (chunk: Buffer) => {
          hash.update(chunk); received += chunk.length;
          const done = baseBytes + received;
          reportProgress(totalSize ? done / totalSize : undefined, done);
        });
        await pipeline(readable, fs.createWriteStream(temporary, { mode: 0o600, flags: append ? "a" : "w" }));
        reportProgress(totalSize ? (baseBytes + received) / totalSize : undefined, baseBytes + received, true);
        // An appended file's checksum must cover the bytes from earlier attempts too, so on
        // the resume path the digest is computed over the finished file, not the chunks.
        checksum = append ? await this.hashFile(temporary) : hash.digest("hex");
      }
      if (control.action === "cancel" || control.action === "delete") throw new Error("Download cancelled");
      if (item.mediaType === "video" && item.metadata.live === true && settings.recordingPreset && settings.recordingPreset !== "source") {
        const encoded = path.join(temporaryDirectory, "encoded.mp4");
        const preset = settings.recordingPreset;
        // Keep a "cancel"/"delete" so the re-encode is aborted and the item ends cancelled/deleted.
        if (control.action === "stop") control.action = undefined; control.encoding = true;
        this.db.setItemStatus(item.id, "downloading", { progress: 0.99 });
        this.writeLog?.("info", "download", "Encoding live recording", { itemId: item.id, preset });
        let encodeBytes = 0; try { encodeBytes = fs.statSync(temporary).size; } catch { /* keep 0 */ }
        await this.postProcessGate.run("Re-encode", () =>
          this.withPostProcessDeadline(control, encodeBytes, "Re-encode",
            () => this.runPostProcessCommand("ffmpeg", recordingEncodingArgs(preset, temporary, encoded), temporaryDirectory, control)));
        if (control.action === "cancel" || control.action === "delete") throw new Error("Encoding cancelled");
        if (!fs.existsSync(encoded) || !fs.statSync(encoded).size) throw new Error(`Encoder completed without producing a media file${control.lastOutput ? `: ${control.lastOutput.slice(-800)}` : ""}`);
        fs.unlinkSync(temporary); temporary = encoded;
        checksum = await this.hashFile(temporary);
      }
      // C3: a live recording that ended on its own with an almost-empty file is a fragment
      // (the stream blipped or the capture opened to nothing), not a real clip. It is moved
      // to recovery so the user can inspect it, and must NOT be cataloged as a finished
      // download. A manual stop is intentional, so it is never treated as a fragment.
      if (item.metadata.live === true && !control.manualStop) {
        const minBytes = Number(this.db.getSettings().autoRecordMinBytes ?? 5 * 1024 * 1024);
        const size = fs.existsSync(temporary) ? fs.statSync(temporary).size : 0;
        if (minBytes > 0 && size > 0 && size < minBytes) {
          this.db.setItemMetadata(item.id, { fragment: true });
          const recoveryDirectory = path.join(this.mediaRoot, ".recording-recovery", safeSegment(item.id));
          this.prepareOutputDirectory(recoveryDirectory);
          const target = this.availableDestination(path.join(recoveryDirectory, "recovered.mp4"), item.id);
          fs.renameSync(temporary, target); temporary = "";
          const relative = path.relative(this.mediaRoot, target);
          const sidecar = {
            itemId: item.id, title: item.title ?? item.id,
            performer: item.performerId ? this.db.getPerformer(item.performerId)?.name ?? "" : "",
            source: item.sourceId ? this.db.getSource(item.sourceId)?.domain ?? "" : "",
            duration: 0, width: 0, height: 0, size, recoveredAt: new Date().toISOString(), avsyncDelta: 0, fragment: true,
          };
          fs.writeFileSync(path.join(recoveryDirectory, "recovered.json"), JSON.stringify(sidecar, null, 2));
          this.db.setItemStatus(item.id, "failed", { error: `Fragment recording (${size} bytes) moved to recovery`, checksum });
          this.writeLog?.("info", "download", "Live recording flagged as fragment and moved to recovery", { itemId: item.id, size });
          void Promise.resolve(this.onCompleted?.()).catch((error) => this.writeLog?.("warn", "library", "Library refresh after download failed", { error }));
          return;
        }
      }

      // Truncation check: the fragment bound above is only a floor, so a capture that
      // silently fell behind (3 recorded minutes of a 30-minute broadcast) still entered
      // the library looking healthy. Compare the real media duration against the wall
      // clock the capture session ran for; a large shortfall stays in the library but is
      // flagged (visible in the UI) and logged instead of being silently accepted.
      if (item.mediaType === "video" && item.metadata.live === true && !control.manualStop) {
        // Re-read from the DB: the in-memory row was fetched before setItemStatus stamped
        // download_started_at, and scheduleRetry re-stamps it per attempt.
        const startedAt = Date.parse(this.db.getItem(item.id)?.downloadStartedAt ?? "");
        const expectedSec = Number.isFinite(startedAt) ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
        if (expectedSec >= 60) {
          try {
            const probe = await this.probeVideo(temporary);
            const actualSec = probe.duration;
            if (actualSec > 0 && actualSec < expectedSec * 0.8) {
              this.db.setItemMetadata(item.id, { truncated: true, expectedDurationSec: Math.round(expectedSec), actualDurationSec: Math.round(actualSec) });
              this.writeLog?.("warn", "download", `Live recording looks truncated: captured ${Math.round(actualSec)}s of a ${Math.round(expectedSec)}s session`, { itemId: item.id, expectedSec: Math.round(expectedSec), actualSec: Math.round(actualSec) });
            }
          } catch { /* Best-effort: a failed probe must never fail the finalize. */ }
        }
      }

      await this.withFinalizeLock(`output:${item.id}`, async () => {
        const visual = await this.visualFingerprint(temporary, item.mediaType);
        const qualityScore = Math.max(item.qualityScore, visual?.qualityScore ?? 0);
        this.db.setDownloadFingerprint(item.id, visual?.hash, qualityScore);
        const duplicate = (item.identityKey ? this.db.findByIdentity(item.identityKey, item.id, item.performerId) : undefined)
          ?? this.db.findByChecksum(checksum, item.id, item.performerId)
          ?? (visual ? this.db.findVisualDuplicate(visual.hash, item.id, item.performerId, item.mediaType) : undefined);
        if (duplicate) {
          const canonicalDate = this.db.setCanonicalMediaDate(duplicate.id, item.publishedAt);
          if (qualityScore <= duplicate.qualityScore) {
            fs.unlinkSync(temporary); temporary = "";
            this.db.setCanonicalMediaDate(item.id, canonicalDate);
            if (duplicate.storagePath) await this.applyMediaDate(path.join(this.mediaRoot, duplicate.storagePath), duplicate.mediaType, canonicalDate);
            this.db.setItemStatus(item.id, "duplicate", { progress: 1, checksum, duplicateOf: duplicate.id });
            this.writeLog?.("info", "download", "Duplicate download discarded", { itemId: item.id, duplicateOf: duplicate.id, title: item.title });
            return;
          }
          this.db.setCanonicalMediaDate(item.id, canonicalDate);
          await this.applyMediaDate(temporary, item.mediaType, canonicalDate);
          const oldPath = duplicate.storagePath ? path.join(this.mediaRoot, duplicate.storagePath) : undefined;
          const finalPath = this.availableDestination(destination, item.id, oldPath);
          fs.renameSync(temporary, finalPath); temporary = "";
          if (oldPath && path.resolve(oldPath) !== path.resolve(finalPath) && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
          const relativePath = path.relative(this.mediaRoot, finalPath);
          this.db.setItemStatus(item.id, "completed", { progress: 1, checksum, storagePath: relativePath });
          this.writeLog?.("info", "download", "Higher-quality download stored", { itemId: item.id, replacedItemId: duplicate.id, storagePath: relativePath });
          this.db.supersedeDownload(duplicate.id, item.id);
          if (plugin.afterDownload) await plugin.afterDownload(this.plugins.context(item.pluginId), { absolutePath: finalPath, relativePath, mediaType: item.mediaType, checksumSha256: checksum });
          void Promise.resolve(this.onCompleted?.()).catch((error) => this.writeLog?.("warn", "library", "Library refresh after download failed", { error }));
          return;
        }
        const canonicalDate = this.db.setCanonicalMediaDate(item.id, item.publishedAt);
        await this.applyMediaDate(temporary, item.mediaType, canonicalDate);
        const finalPath = this.availableDestination(destination, item.id);
        fs.renameSync(temporary, finalPath); temporary = "";
        const relativePath = path.relative(this.mediaRoot, finalPath);
        this.db.setItemStatus(item.id, "completed", { progress: 1, checksum, storagePath: relativePath });
        this.writeLog?.("info", "download", "Download completed", { itemId: item.id, storagePath: relativePath, mediaType: item.mediaType });
        // A capture that "succeeded" while its extractor kept complaining (403s on evicted
        // segments, invalid data) is the signature of a truncated recording -- surface it.
        if (control.lastOutput) this.writeLog?.("warn", "download", "Recording finished with extractor warnings", { itemId: item.id, output: control.lastOutput.slice(-500) });
        if (plugin.afterDownload) await plugin.afterDownload(this.plugins.context(item.pluginId), { absolutePath: finalPath, relativePath, mediaType: item.mediaType, checksumSha256: checksum });
        void Promise.resolve(this.onCompleted?.()).catch((error) => this.writeLog?.("warn", "library", "Library refresh after download failed", { error }));
      });
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      // A failed post-processing step (remux / re-encode) must never throw the capture
      // away: prefer the finished MP4, but fall back to the TS capture. Before this
      // fallback existed a failed remux deleted the entire recording, because the
      // staging file is capture.ts while `temporary` points at the not-yet-written MP4.
      const capturePath = temporaryDirectory ? path.join(temporaryDirectory, "capture.ts") : "";
      let recoverySource = temporary && fs.existsSync(temporary)
        ? temporary
        : (capturePath && fs.existsSync(capturePath) && fs.statSync(capturePath).size > 0 ? capturePath : "");
      // A10: a segmented capture that died before finalize has no capture.ts yet, only
      // parts. Salvage them: folding the parts into one TS keeps the existing single-file
      // recovery flow working; if even that fold fails, the raw parts are moved below so
      // no recorded minute is ever thrown away.
      let strayParts: string[] = [];
      if (!recoverySource && isLiveRecording && !control.action && !control.paused && temporaryDirectory) {
        strayParts = captureSegmentFiles(temporaryDirectory, { skipEmpty: true });
        if (strayParts.length && !control.encoding) {
          try {
            const partBytes = strayParts.reduce((total, part) => total + fs.statSync(part).size, 0);
            if (strayParts.length === 1) {
              fs.renameSync(strayParts[0], capturePath);
            } else {
              const listPath = path.join(temporaryDirectory, "capture.concat.txt");
              fs.writeFileSync(listPath, strayParts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
            await this.postProcessGate.run("Concat", () =>
              this.withPostProcessDeadline(control, partBytes, "Concat",
                () => this.runPostProcessCommand("ffmpeg", concatCaptureArgs(listPath, capturePath), temporaryDirectory, control)));
            }
            if (fs.existsSync(capturePath) && fs.statSync(capturePath).size > 0) {
              recoverySource = capturePath;
              strayParts = [];
            }
          } catch { /* the raw-parts fallback below still salvages the bytes */ }
        }
      }
      if (!control.action && !control.paused && recoverySource) {
        const partialBytes = fs.statSync(recoverySource).size;
        if (control.encoding || (isLiveRecording && partialBytes > 0)) {
          try {
            const recoveryDirectory = path.join(this.mediaRoot, ".recording-recovery", safeSegment(item.id));
            this.prepareOutputDirectory(recoveryDirectory);
            const recoveredMp4 = this.availableDestination(path.join(recoveryDirectory, "recovered.mp4"), item.id);
            try {
              // Prefer a real MP4 the recovery UI can play; the post-process gate keeps it off
              // live captures' CPUs. On a corrupt capture or a missing ffmpeg, fall back to moving
              // the raw TS under the recovered.mp4 name so the file is still listed and inspectable.
              await this.remuxCaptureToMp4(recoverySource, recoveredMp4, control);
            } catch {
              fs.renameSync(recoverySource, recoveredMp4);
            }
            const sidecar = {
              itemId: item.id, title: item.title ?? item.id,
              performer: item.performerId ? this.db.getPerformer(item.performerId)?.name ?? "" : "",
              source: item.sourceId ? this.db.getSource(item.sourceId)?.domain ?? "" : "",
              duration: 0, width: 0, height: 0, size: fs.statSync(recoveredMp4).size,
              recoveredAt: new Date().toISOString(), avsyncDelta: 0,
            };
            fs.writeFileSync(path.join(recoveryDirectory, "recovered.json"), JSON.stringify(sidecar, null, 2));
            temporary = "";
            message += ` Recording preserved for recovery at ${path.relative(this.mediaRoot, recoveredMp4)}.`;
          } catch {
            preserveTemporary = true;
            message += ` Recording preserved in staging at ${path.relative(this.mediaRoot, recoverySource)}; recover it before retrying.`;
          }
        }
      }
      if (!control.action && !control.paused && !recoverySource && strayParts.length) {
        // The fold above (parts -> capture.ts) can fail for reasons that say nothing about the
        // parts themselves -- most often the post-process slot was held through a load spike and
        // the deadline killed the fold. So salvage straight through the concat demuxer and give
        // the Recovery page a real MP4. Without this the bytes sat here as bare parts, and
        // `listRecovered()` (which only recognises recovered.mp4) never listed them at all.
        const recoveryDirectory = path.join(this.mediaRoot, ".recording-recovery", safeSegment(item.id));
        const partBytes = strayParts.reduce((total, part) => { try { return total + fs.statSync(part).size; } catch { return total; } }, 0);
        let salvaged = false;
        if (partBytes > 0) {
          try {
            this.prepareOutputDirectory(recoveryDirectory);
            const recoveredMp4 = this.availableDestination(path.join(recoveryDirectory, "recovered.mp4"), item.id);
            // Multi-part captures go through the concat demuxer directly: an intermediate folded
            // capture.ts would double the disk footprint of a multi-GB recording.
            const concatList = strayParts.length >= 2 && temporaryDirectory ? path.join(temporaryDirectory, "capture.concat.txt") : undefined;
            if (concatList) fs.writeFileSync(concatList, strayParts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
            // Suspend the download stall timer for the rest of this attempt: the salvage is
            // concluding work and must not be mistaken for a stalled capture.
            control.encoding = true;
            await this.remuxCaptureToMp4(concatList ?? strayParts[0], recoveredMp4, control, concatList, partBytes);
            const probe = await this.probeVideo(recoveredMp4);
            fs.writeFileSync(path.join(recoveryDirectory, "recovered.json"), JSON.stringify({
              itemId: item.id, title: item.title ?? item.id,
              performer: item.performerId ? this.db.getPerformer(item.performerId)?.name ?? "" : "",
              source: item.sourceId ? this.db.getSource(item.sourceId)?.domain ?? "" : "",
              duration: probe.duration, width: probe.width, height: probe.height,
              size: fs.statSync(recoveredMp4).size, recoveredAt: new Date().toISOString(), avsyncDelta: 0,
            }, null, 2));
            try { await this.ensureRecoveredPoster(item.id, recoveredMp4); } catch { /* Poster is optional. */ }
            for (const part of strayParts) { try { fs.unlinkSync(part); } catch { /* a leftover part is harmless; the next rescue run removes it */ } }
            temporary = "";
            message += ` Recording preserved for recovery at ${path.relative(this.mediaRoot, recoveredMp4)}.`;
            salvaged = true;
          } catch { /* fall through to the raw-parts fallback below */ }
        }
        if (!salvaged) {
          // Truly un-remuxable parts: keep the bytes and record what was saved, so no recorded
          // minute is ever deleted with the staging directory. The Recovery page cannot list
          // these (there is no recovered.mp4); `cleanup-residual-ts` folds them later.
          try {
            this.prepareOutputDirectory(recoveryDirectory);
            const saved: string[] = [];
            for (const part of strayParts) {
              const target = this.availableDestination(path.join(recoveryDirectory, path.basename(part)), item.id);
              fs.renameSync(part, target);
              saved.push(path.basename(target));
            }
            temporary = "";
            fs.writeFileSync(path.join(recoveryDirectory, "recovered.parts.json"), JSON.stringify({ itemId: item.id, title: item.title ?? item.id, parts: saved }, null, 2));
            message += ` ${saved.length} raw capture part(s) preserved for recovery.`;
            this.writeLog?.("warn", "download", "Recording parts kept raw; run the residual recovery pass to fold them", { itemId: item.id, parts: saved.length });
          } catch {
            preserveTemporary = true;
            message += " Raw capture parts preserved in staging; recover them before retrying.";
          }
        }
      }
      if (control.action) {
        if (control.action !== "delete") this.db.setItemStatus(item.id, "cancelled", { error: null });
        this.writeLog?.("info", "download", control.action === "stop" ? "Recording stopped" : "Download cancelled", { itemId: item.id, title: item.title });
      } else if (control.paused) {
        this.db.setItemStatus(item.id, "paused", { error: null });
      } else if (recordingFinalize) {
        // The capture already ended (user stop, or the stream going offline) and only
        // the post-processing failed. Retrying would silently restart a recording the
        // user asked to stop, so report the failure once instead.
        this.db.setItemStatus(item.id, "failed", { error: message });
        this.writeLog?.("error", "download", "Live recording could not be finalized after the capture ended", { itemId: item.id, title: item.title, error: message });
      } else {
        // Keep the underlying command output: without it a stall is undiagnosable
        // (the real ffmpeg/yt-dlp error is the only clue to what went wrong).
        if (control.stalled) message = `Download timed out (no progress received within the configured stall timeout). Underlying output: ${message.slice(0, 800)}`;
        const disposition = this.handleFailure(item.id, message, control);
        // A9/A10: a scheduled retry must find its resume point in staging -- the partial
        // fetch file / yt-dlp .part for downloads, the recorded capture segments for a
        // live capture (the next attempt appends at the next segment number). A retry
        // that finds nothing to resume simply starts from a clean directory.
        if (disposition === "retry") preserveTemporary = true;
      }
    } finally {
      if (stallTimer) clearInterval(stallTimer);
      avWatcher?.dispose();
      if (temporaryDirectory && !preserveTemporary) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      if (control.action === "delete") this.db.deleteItem(item.id);
    }
  }

  /** Schedule a retry or mark the item failed. Returns which branch was taken so the caller
   *  can keep the staging directory alive for a retry (A9: the partial file is the resume point). */
  private handleFailure(itemId: string, message: string, control: ActiveDownload): "retry" | "failed" {
    const settings = this.db.getSettings();
    const maxAttempts = Math.max(0, Number(settings.downloadRetryAttempts ?? 5));
    const attempts = (this.db.getItem(itemId)?.attempts ?? 0) + 1;
    // A deterministic HTTP failure (gone media, or a forbidden URL that already survived one
    // retry) must not burn the whole exponential-backoff schedule: fail it now so the slot
    // frees up. Every other failure keeps the normal retry path.
    if (retryDisposition(message, attempts) === "retry" && attempts < maxAttempts) {
      const base = Math.max(1, Number(settings.downloadRetryBaseSeconds ?? 30));
      const delay = Math.min(base * 2 ** (attempts - 1), 3600) * 1000;
      const jitter = Math.floor(Math.random() * Math.min(delay, 30_000));
      const nextRetryAt = new Date(Date.now() + delay + jitter).toISOString();
      this.db.scheduleRetry(itemId, message, attempts, nextRetryAt);
      this.writeLog?.("warn", "download", "Download failed, scheduling automatic retry", { itemId, attempt: attempts, maxAttempts, nextRetryAt, error: message });
      return "retry";
    } else {
      const status = httpStatusFromError(message);
      this.db.setItemStatus(itemId, "failed", { error: message });
      // Let the live-cam layer learn about confirmed-offline rooms (e.g. the provider page
      // itself said so) so the auto-recorder stops re-queueing a room that is not live.
      if (this.onLiveFailure) {
        const failed = this.db.getItem(itemId);
        if (failed) this.onLiveFailure(failed, message);
      }
      if (status !== undefined && retryDisposition(message, attempts) === "permanent") {
        this.writeLog?.("error", "download", "Download failed permanently: the source returned an unrecoverable HTTP status", { itemId, attempts, status, error: message });
      } else {
        this.writeLog?.("error", "download", "Download failed permanently after exhausting retries", { itemId, attempts, error: message });
      }
      return "failed";
    }
  }

  private cleanupStaleDownloads(protectedDirs: Set<string> = new Set()) {
    try {
      const root = this.downloadsRoot;
      if (!fs.existsSync(root)) return;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (this.active.has(entry.name)) continue;
        // A9: a queued item with a staging directory is a scheduled retry waiting for its
        // slot; the directory holds the partial file that retry will resume from.
        const staged = this.db.getItem(entry.name);
        if (staged?.status === "queued") continue;
        const full = path.resolve(root, entry.name);
        if (protectedDirs.has(full)) continue;
        // Deletion used to be unconditional (A10), which threw away recordings a restart
        // had interrupted mid-write. Directories that actually hold media are moved to the
        // recovery area instead; scaffolding without media is still just removed.
        if (this.containsMedia(full)) this.moveToRecovery(full, entry.name);
        else fs.rmSync(full, { recursive: true, force: true });
      }
    } catch { /* Best-effort startup cleanup; never blocks startup. */ }
  }

  private containsMedia(directory: string): boolean {
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        try { if (fs.statSync(path.join(directory, entry.name)).size > 0) return true; } catch { /* vanished mid-scan */ }
      }
    } catch { /* unreadable: treat as no media */ }
    return false;
  }

  private moveToRecovery(source: string, name: string) {
    const target = path.join(this.recoveryRoot, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    try {
      this.prepareOutputDirectory(this.recoveryRoot);
      fs.renameSync(source, target);
      this.writeLog?.("warn", "download", "Moved a stale recording from the staging area to recovery", { directory: name });
      this.enforceRecoveryCap();
    } catch (error) {
      // Same mount, so rename should not fail; leave the directory in place rather than
      // deleting data the move could have saved.
      this.writeLog?.("warn", "download", "Could not move a stale recording to recovery; left in place", { directory: name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private enforceRecoveryCap() {
    try {
      const entries = fs.readdirSync(this.recoveryRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const full = path.join(this.recoveryRoot, entry.name);
          return { full, mtime: fs.statSync(full).mtimeMs, bytes: this.directoryBytes(full) };
        });
      let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
      entries.sort((left, right) => left.mtime - right.mtime);
      while (entries.length > RECOVERY_MAX_ENTRIES || (bytes > RECOVERY_MAX_BYTES && entries.length > 0)) {
        const oldest = entries.shift()!;
        try {
          fs.rmSync(oldest.full, { recursive: true, force: true });
          bytes -= oldest.bytes;
          this.writeLog?.("warn", "download", "Recovery area is over its cap; evicted the oldest rescued directory", { directory: path.basename(oldest.full) });
        } catch { break; }
      }
    } catch { /* best-effort */ }
  }

  private get downloadsRoot() { return path.join(this.mediaRoot, ".downloads"); }

  private prepareOutputDirectory(directory: string) {
    const root = path.resolve(this.mediaRoot); const relative = path.relative(root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Output path must stay inside the media volume");
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { fs.mkdirSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Output folders must be real directories, not symbolic links");
    }
  }

  private availableDestination(destination: string, itemId: string, replacedPath?: string) {
    this.prepareOutputDirectory(path.dirname(destination));
    let candidate = destination; let suffix = 0;
    while (fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(replacedPath ?? "")) {
      suffix++;
      candidate = path.join(path.dirname(destination), `${path.parse(destination).name}-${itemId.slice(-6)}${suffix > 1 ? `-${suffix}` : ""}${path.extname(destination)}`);
    }
    return candidate;
  }

  private signal(control: ActiveDownload, signal: NodeJS.Signals) {
    const child = control.child; if (!child?.pid) return;
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, signal); return; } catch { /* Fall back to the direct child. */ }
    }
    // Windows only maps SIGTERM/SIGKILL/SIGINT to a process kill and throws
    // ERR_UNKNOWN_SIGNAL for the rest, so an unsupported signal must not abort the
    // caller mid-stop (SIGCONT/SIGSTOP simply have no equivalent on Windows).
    try { child.kill(signal); } catch { /* Signal unsupported on this platform. */ }
  }

  private runCommandDownload(command: string, args: string[], outputDirectory: string, expectedBytes: number | undefined, reportProgress: (progress?: number, downloadedBytes?: number, force?: boolean) => void, control: ActiveDownload, onStderr?: (text: string) => void, options?: { lowPriority?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      // Memory guard for live recordings on small VPS: cap yt-dlp fragment concurrency
      // and buffer so a single download cannot balloon the cgroup and trip OOM.
      const effectiveArgs = command === "yt-dlp"
        ? [...args, "--concurrent-fragments", "1", "--buffer-size", "4M"]
        : args;
      // Post-process commands may be deprioritized so live captures keep the CPU. nice(1)
      // and ionice(1) exec() into the target binary, so the spawned PID is still the child
      // we signal -- pause/stop/kill semantics are unchanged by the wrapper.
      let spawnCommand = command;
      let spawnArgs = effectiveArgs;
      if (options?.lowPriority) {
        spawnCommand = "nice";
        spawnArgs = ["-n", "19", "ionice", "-c", "3", command, ...effectiveArgs];
      }
      const child = spawn(spawnCommand, spawnArgs, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      control.child = child;
      control.closed = new Promise<void>((resolve) => child.once("close", resolve));
      if (control.paused) this.signal(control, "SIGSTOP");
      if (control.action) this.signal(control, control.action === "stop" ? "SIGINT" : "SIGTERM");
      let output = ""; let progressOutput = ""; let settled = false;
      const remember = (chunk: Buffer) => {
        const text = chunk.toString("utf8"); output = `${output}${text}`.slice(-8_000); progressOutput = `${progressOutput}${text}`.replaceAll("\r", "\n").slice(-2_000);
        onStderr?.(text);
        const matches = [...progressOutput.matchAll(/(?:easyx-progress:\s*)?(\d{1,3}(?:\.\d+)?)%/gi)];
        const percentage = Number(matches.at(-1)?.[1]);
        if (Number.isFinite(percentage)) reportProgress(percentage / 100);
        const byteMatches = [...progressOutput.matchAll(/easyx-bytes:(\d+):(\d+)/gi)];
        const downloadedBytes = Number(byteMatches.at(-1)?.[1]); const expectedBytes = Number(byteMatches.at(-1)?.[2]);
        if (Number.isFinite(downloadedBytes) && downloadedBytes > 0) reportProgress(expectedBytes > 0 ? downloadedBytes / expectedBytes : undefined, downloadedBytes);
      };
      child.stdout.on("data", remember); child.stderr.on("data", remember);
      // Command extractors report progress on stdout; this poll is only a fallback for
      // silent ones, so a 1.5s cadence is plenty and keeps the directory scan cheap (A2).
      const poll = setInterval(() => {
        const downloadedBytes = this.directoryBytes(outputDirectory);
        if (downloadedBytes > 0) reportProgress(expectedBytes ? downloadedBytes / expectedBytes : undefined, downloadedBytes);
      }, 1500); poll.unref();
      const finish = (error?: Error) => { if (settled) return; settled = true; clearInterval(poll); error ? reject(error) : resolve(); };
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        control.child = undefined;
        // Keep the extractor's own words around even on success: a truncated live capture
        // exits 0 with the whole story ("403 Forbidden", "Invalid data") in its stderr.
        control.lastOutput = output.trim();
        if (code === 0 || (control.action === "stop" && this.directoryBytes(outputDirectory) > 0)) finish();
        else finish(new Error(`${command} exited with code ${code}: ${output.trim() || "no error output"}`));
      });
    });
  }

  // Size of a staging directory, one level deep: command extractors write flat into their
  // output directory, so the fallback poll never needs a recursive walk (A2).
  private directoryBytes(directory: string): number {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
        const target = path.join(directory, entry.name);
        if (!entry.isFile()) return total;
        try { return total + fs.statSync(target).size; } catch { return total; }
      }, 0);
    } catch { return 0; }
  }

  private hashFile(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256"); const stream = fs.createReadStream(file);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.once("error", reject); stream.once("end", () => resolve(hash.digest("hex")));
    });
  }

  private async visualFingerprint(file: string, mediaType: string): Promise<{ hash: string; qualityScore: number } | undefined> {
    if (mediaType !== "image") return undefined;
    try {
      const probe = await this.capture("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file]);
      const stream = (JSON.parse(probe.stdout.toString("utf8")) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0];
      const width = Number(stream?.width ?? 0); const height = Number(stream?.height ?? 0);
      const pixels = await this.capture("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=8:8:force_original_aspect_ratio=decrease,pad=8:8:(ow-iw)/2:(oh-ih)/2:black,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
      if (pixels.stdout.length < 64) return undefined;
      const values = [...pixels.stdout.subarray(0, 64)];
      if (Math.max(...values) - Math.min(...values) < 10) return undefined;
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      let hash = "";
      for (let index = 0; index < 64; index += 4) {
        let nibble = 0;
        for (let bit = 0; bit < 4; bit += 1) if (values[index + bit] >= average) nibble |= 1 << (3 - bit);
        hash += nibble.toString(16);
      }
      return { hash, qualityScore: width > 0 && height > 0 ? width * height : 0 };
    } catch { return undefined; }
  }

  private async applyMediaDate(file: string, mediaType: string, publishedAt?: string) {
    if (!publishedAt || !fs.existsSync(file)) return;
    const date = new Date(publishedAt);
    if (Number.isNaN(date.valueOf())) return;
    if (mediaType === "image") {
      // Embed the canonical date in EXIF too; the filesystem mtime below is the fallback.
      const exifDate = date.toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
      try { await this.capture("exiftool", ["-overwrite_original", `-DateTimeOriginal=${exifDate}`, `-CreateDate=${exifDate}`, `-ModifyDate=${exifDate}`, `-XMP:DateCreated=${date.toISOString()}`, file]); } catch { /* Filesystem date still preserves the canonical date. */ }
    }
    // Videos keep their container untouched: a `-c copy` remux of a multi-GB capture is a full
    // read+write that fights live recordings for I/O on small hosts. The on-disk mtime already
    // pins the canonical date the library view sorts by, so the ffmpeg rewrite is unnecessary.
    fs.utimesSync(file, date, date);
  }

  async applyStoredMediaDates(itemIds: string[]) {
    for (const itemId of [...new Set(itemIds)]) {
      const item = this.db.getItem(itemId);
      if (!item?.storagePath || item.status !== "completed") continue;
      await this.withFinalizeLock(`output:${itemId}`, () => this.applyMediaDate(path.join(this.mediaRoot, item.storagePath!), item.mediaType, item.publishedAt));
    }
  }

  private capture(command: string, args: string[]): Promise<{ stdout: Buffer; stderr: Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out`)); }, 120_000); timer.unref();
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }) : reject(new Error(`${command} exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`)); });
    });
  }

  /**
   * Post-process commands (concat / remux / re-encode) run at the lowest CPU and I/O
   * priority: the capture that just finished must never compete with the live captures
   * still on the air, and an idle machine simply runs the job at full speed anyway. The
   * support probe runs once; a system without nice/ionice falls back to normal priority
   * instead of failing every remux.
   */
  private async lowPrioritySupported(): Promise<boolean> {
    if (this.lowPrioritySupport !== undefined) return this.lowPrioritySupport;
    if (process.platform !== "linux") {
      this.lowPrioritySupport = false;
    } else {
      try {
        await this.capture("nice", ["-n", "19", "true"]);
        this.lowPrioritySupport = true;
      } catch {
        this.writeLog?.("warn", "download", "nice/ionice unavailable; post-processing runs at normal priority");
        this.lowPrioritySupport = false;
      }
    }
    return this.lowPrioritySupport;
  }

  private async runPostProcessCommand(command: string, args: string[], outputDirectory: string, control: ActiveDownload, onStderr?: (text: string) => void): Promise<void> {
    if (await this.lowPrioritySupported()) {
      return this.runCommandDownload(command, args, outputDirectory, undefined, () => {}, control, onStderr, { lowPriority: true });
    }
    return this.runCommandDownload(command, args, outputDirectory, undefined, () => {}, control, onStderr);
  }

  private async withFinalizeLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.finalizers.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.finalizers.set(key, settled);
    try { return await result; }
      finally { if (this.finalizers.get(key) === settled) this.finalizers.delete(key); }
  }

  // --- Residual TS recovery (Recovery page) ---------------------------------

  /** Recovered recordings live here, outside the library, until the user archives them. */
  private get recoveryRoot() { return path.join(this.mediaRoot, ".recording-recovery"); }

  recoveredStreamPath(itemId: string): string | null {
    const file = path.join(this.recoveryRoot, safeSegment(itemId), "recovered.mp4");
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? file : null;
  }
  recoveredPosterPath(itemId: string): string | null {
    const file = path.join(this.recoveryRoot, safeSegment(itemId), "recovered.poster.jpg");
    return fs.existsSync(file) && fs.statSync(file).size > 0 ? file : null;
  }

  /**
   * Run a post-processing step under its own deadline. The download stall timer is suspended
   * while `control.encoding` is set (see `stalledDownload`), so this deadline is what keeps a
   * genuinely hung ffmpeg from blocking the queue forever.
   */
  private async withPostProcessDeadline<T>(control: ActiveDownload, inputBytes: number, label: string, run: () => Promise<T>): Promise<T> {
    const budgetMs = postProcessDeadlineMs(inputBytes);
    let expired = false;
    const deadline = setTimeout(() => { expired = true; this.signal(control, "SIGKILL"); }, budgetMs);
    deadline.unref();
    try {
      return await run();
    } catch (error) {
      // Replace the opaque "exited with code null" (SIGKILL leaves no exit code).
      if (expired) throw new Error(`${label} timed out after ${Math.round(budgetMs / 1000)}s; the capture is preserved for recovery`);
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Remux a live MPEG-TS capture into an MP4, shifting the audio by the measured A/V skew.
   *  `concatList` (A10 segmented-capture rescue) swaps the single-file input for the concat
   *  demuxer, so every part is remuxed in one pass without an intermediate folded capture.ts. */
  private async remuxCaptureToMp4(tsPath: string, mp4Staging: string, control: ActiveDownload, concatList?: string, inputBytes?: number): Promise<number> {
    let audioShift = readAvSyncSidecar(tsPath + ".avsync.json") ?? 0;
    if (audioShift === 0) {
      try {
        const probe = await this.capture("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", tsPath]);
        const parsed = JSON.parse(probe.stdout.toString("utf8")) as { streams?: Array<{ codec_type?: string; start_time?: string }> };
        let videoStart: number | undefined;
        let audioStart: number | undefined;
        for (const stream of parsed.streams ?? []) {
          if (stream.codec_type === "video" && videoStart === undefined) videoStart = Number(stream.start_time ?? 0) || 0;
          if (stream.codec_type === "audio" && audioStart === undefined) audioStart = Number(stream.start_time ?? 0) || 0;
        }
        // Only correct a clear, sane skew: tiny deltas are measurement noise,
        // and huge deltas would indicate something other than a sync issue.
        if (videoStart !== undefined && audioStart !== undefined) {
          const delta = videoStart - audioStart;
          if (Math.abs(delta) > 0.15 && Math.abs(delta) <= 30) audioShift = delta;
        }
      } catch { /* Probe failed: keep the audio unshifted (previous behaviour). */ }
    }
    const audioFilter = audioShift !== 0 ? `asetpts=PTS+${audioShift.toFixed(3)}/TB` : undefined;
    // `+faststart` rewrites the whole file after the muxer has written it, so this step takes
    // minutes on a multi-GB capture and must not read as a stalled download.
    let captureBytes = 0;
    if (inputBytes !== undefined) captureBytes = inputBytes;
    else { try { captureBytes = fs.statSync(tsPath).size; } catch { /* keep 0 */ } }
    // The gate also covers the recovery path below: a rescue remux must not fight live
    // captures either, and the deadline only starts once a slot is actually granted.
    await this.postProcessGate.run("Remux", () =>
      this.withPostProcessDeadline(control, captureBytes, "Remux", () => this.runPostProcessCommand("ffmpeg", [
      "-y", "-fflags", "+genpts+igndts",
      // The concat demuxer streams every capture part as one continuous input; a plain
      // `-i tsPath` here would remux only the first slice of a segmented capture.
      ...(concatList ? ["-f", "concat", "-safe", "0", "-i", concatList] : ["-i", tsPath]),
      "-map", "0", "-c:v", "copy", "-c:a", "aac",
      ...(audioFilter ? ["-af", audioFilter] : []),
      // Still corrects any drift inside the audio timeline itself.
      "-async", "1",
      "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", mp4Staging,
      ], path.dirname(mp4Staging), control)));
    if (control.action === "cancel" || control.action === "delete") throw new Error("Remux cancelled");
    if (!fs.existsSync(mp4Staging) || !fs.statSync(mp4Staging).size) throw new Error("Remux to MP4 produced no output");
    return audioShift;
  }

  /** Single-file capture candidates only; segmented (A10) captures are folded at remux time. */
  private findNamedCapture(dir: string): string | undefined {
    for (const candidate of ["capture.ts", "capture.mkv", "capture.mp4"]) {
      const candidatePath = path.join(dir, candidate);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).size > 0) return candidatePath;
    }
    return undefined;
  }

  /** Last-resort capture candidate: any non-empty .ts that is neither named nor a segment part. */
  private findLooseCapture(dir: string): string | undefined {
    try {
      const ts = fs.readdirSync(dir)
        .filter((file) => file.endsWith(".ts") && !CAPTURE_SEGMENT_PATTERN.test(file) && fs.statSync(path.join(dir, file)).size > 0)
        .sort();
      return ts.length ? path.join(dir, ts[0]) : undefined;
    } catch { return undefined; }
  }

  private async isPlayableCapture(tsPath: string): Promise<boolean> {
    try {
      const probe = await this.capture("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", tsPath]);
      const parsed = JSON.parse(probe.stdout.toString("utf8")) as { streams?: Array<{ codec_type?: string }> };
      return (parsed.streams ?? []).some((stream) => stream.codec_type === "video" || stream.codec_type === "audio");
    } catch { return false; }
  }

  private async probeVideo(file: string): Promise<{ duration: number; width: number; height: number }> {
    try {
      const probe = await this.capture("ffprobe", ["-v", "error", "-show_entries", "stream=duration,width,height", "-of", "json", file]);
      const parsed = JSON.parse(probe.stdout.toString("utf8")) as { streams?: Array<{ duration?: string; width?: number; height?: number }> };
      const video = parsed.streams?.find((stream) => stream.width);
      let duration = 0;
      for (const stream of parsed.streams ?? []) if (stream.duration) duration = Number(stream.duration) || duration;
      return { duration, width: video?.width ?? 0, height: video?.height ?? 0 };
    } catch { return { duration: 0, width: 0, height: 0 }; }
  }

  async ensureRecoveredPoster(itemId: string, mp4?: string): Promise<string | null> {
    const dir = path.join(this.recoveryRoot, safeSegment(itemId));
    const poster = path.join(dir, "recovered.poster.jpg");
    if (fs.existsSync(poster) && fs.statSync(poster).size > 0) return poster;
    const source = mp4 ?? path.join(dir, "recovered.mp4");
    if (!fs.existsSync(source)) return null;
    try {
      await this.capture("ffmpeg", ["-y", "-v", "error", "-ss", "1", "-i", source, "-frames:v", "1", "-vf", "scale=320:-1", poster]);
      if (fs.existsSync(poster) && fs.statSync(poster).size > 0) return poster;
    } catch { /* Poster is optional; the UI falls back to a placeholder. */ }
    return null;
  }

  /** Scan both the active download staging area and the recovery folder for leftover captures. */
  async recoverResidualTs(options: { dryRun?: boolean; execute?: boolean } = {}): Promise<{
    scanned: number; rescued: number; deleted: number; skipped: number; failed: number; leftover: number; dryRun: boolean;
    items: Array<{ itemId: string; action: "rescued" | "deleted" | "skipped" | "failed" }>;
  }> {
    const dryRun = options.dryRun === true || options.execute !== true;
    const execute = options.execute === true;
    const report = {
      scanned: 0, rescued: 0, deleted: 0, skipped: 0, failed: 0, leftover: 0, dryRun,
      items: [] as Array<{ itemId: string; action: "rescued" | "deleted" | "skipped" | "failed" }>,
    };
    const roots = [this.downloadsRoot, this.recoveryRoot];
    const ACTIVE = new Set(["queued", "downloading", "paused", "stopping", "cancelling"]);
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      let names: string[] = [];
      try {
        names = fs.readdirSync(root).filter((name) => { try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; } });
      } catch { continue; }
      for (const name of names) {
        const itemId = name;
        // A recovery folder that already holds a rescued MP4 is a finished rescue, not a
        // residual capture, so it is not counted as a scan candidate.
        if (root === this.recoveryRoot && fs.existsSync(path.join(root, name, "recovered.mp4"))) continue;
        report.scanned++;
        const item = this.db.getItem(itemId);
        if (this.active.has(itemId) || (item && ACTIVE.has(item.status))) {
          report.skipped++; report.items.push({ itemId, action: "skipped" }); continue;
        }
        const stagingDir = path.join(root, name);
        // A10 segmented captures land as capture_partNNN.ts. The remux below folds them via the
        // concat demuxer so a whole recording is rescued in ONE run; the old path saved only the
        // alphabetically-first slice and needed one recovery run per 10-minute part.
        const folded = this.findNamedCapture(stagingDir);
        const parts = captureSegmentFiles(stagingDir, { skipEmpty: true });
        const tsPath = folded ?? parts[0] ?? this.findLooseCapture(stagingDir);
        if (!tsPath) { report.skipped++; report.items.push({ itemId, action: "skipped" }); continue; }
        const recoverable = await this.isPlayableCapture(tsPath);
        if (!recoverable) {
          if (execute) { try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); report.deleted++; } catch { report.failed++; } }
          else report.deleted++;
          report.items.push({ itemId, action: "deleted" });
          continue;
        }
        const recoveryDir = path.join(this.recoveryRoot, safeSegment(itemId));
        const outPath = path.join(recoveryDir, "recovered.mp4");
        // Nothing is written during a dry run, so the recovery folder is only created on execute.
        if (dryRun) { report.rescued++; report.items.push({ itemId, action: "rescued" }); continue; }
        try {
          this.prepareOutputDirectory(recoveryDir);
          // Multi-part captures go through the concat demuxer directly: an intermediate folded
          // capture.ts would double the disk footprint of a multi-GB recording during the rescue.
          let concatList: string | undefined;
          if (!folded && parts.length >= 2) {
            concatList = path.join(stagingDir, "capture.concat.txt");
            fs.writeFileSync(concatList, parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
          }
          const inputBytes = concatList
            ? parts.reduce((total, part) => { try { return total + fs.statSync(part).size; } catch { return total; } }, 0)
            : undefined;
          await this.remuxCaptureToMp4(tsPath, outPath, { action: undefined, paused: false, encoding: false } as ActiveDownload, concatList, inputBytes);
          const probe = await this.probeVideo(outPath);
          const sidecar = {
            itemId, title: item?.title ?? itemId,
            performer: item?.performerId ? this.db.getPerformer(item.performerId)?.name ?? "" : "",
            source: item?.sourceId ? this.db.getSource(item.sourceId)?.domain ?? "" : "",
            duration: probe.duration, width: probe.width, height: probe.height,
            size: fs.statSync(outPath).size, recoveredAt: new Date().toISOString(), avsyncDelta: 0,
          };
          fs.writeFileSync(path.join(recoveryDir, "recovered.json"), JSON.stringify(sidecar, null, 2));
          await this.ensureRecoveredPoster(itemId, outPath);
          if (path.resolve(tsPath) !== path.resolve(outPath)) {
            // The rescue itself succeeded, so the item is still reported as rescued; only the
            // leftover capture could not be removed (for example a staging folder the server
            // user cannot write to). Count it instead of hiding a failed cleanup. Segmented
            // captures delete every part: otherwise the next run would re-rescue the same
            // recording from the remaining slices.
            for (const leftoverFile of new Set([tsPath, ...parts, ...(concatList ? [concatList] : [])])) {
              if (path.resolve(leftoverFile) === path.resolve(outPath)) continue;
              try { fs.unlinkSync(leftoverFile); }
              catch (error) {
                report.leftover++;
                this.writeLog?.("warn", "download", "Rescued capture could not be deleted", { itemId, path: leftoverFile, error: String(error) });
              }
            }
          }
          report.rescued++; report.items.push({ itemId, action: "rescued" });
        } catch (error) {
          report.failed++; report.items.push({ itemId, action: "failed" });
          this.writeLog?.("warn", "download", "Residual TS remux failed", { itemId, error: String(error) });
        }
      }
    }
    return report;
  }

  async listRecovered(): Promise<Array<{
    itemId: string; title: string; performer: string; source: string;
    duration: number; width: number; height: number; size: number; recoveredAt: string; cataloged: boolean;
  }>> {
    const entries: Array<{
      itemId: string; title: string; performer: string; source: string;
      duration: number; width: number; height: number; size: number; recoveredAt: string; cataloged: boolean;
    }> = [];
    if (!fs.existsSync(this.recoveryRoot)) return entries;
    for (const name of fs.readdirSync(this.recoveryRoot)) {
      const dir = path.join(this.recoveryRoot, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const mp4 = path.join(dir, "recovered.mp4");
      if (!fs.existsSync(mp4) || !fs.statSync(mp4).size) continue;
      const itemId = name;
      const item = this.db.getItem(itemId);
      let sidecar: Record<string, unknown> = {};
      try { sidecar = JSON.parse(fs.readFileSync(path.join(dir, "recovered.json"), "utf8")); } catch { /* sidecar missing */ }
      const performerName = typeof sidecar.performer === "string" ? sidecar.performer
        : (item?.performerId ? this.db.getPerformer(item.performerId)?.name ?? "" : "");
      const sourceDomain = typeof sidecar.source === "string" ? sidecar.source
        : (item?.sourceId ? this.db.getSource(item.sourceId)?.domain ?? "" : "");
      const cataloged = Boolean(item && item.status === "completed" && item.storagePath && fs.existsSync(path.join(this.mediaRoot, item.storagePath)));
      entries.push({
        itemId,
        title: typeof sidecar.title === "string" ? sidecar.title : (item?.title ?? itemId),
        performer: performerName, source: sourceDomain,
        duration: Number(sidecar.duration ?? 0), width: Number(sidecar.width ?? 0), height: Number(sidecar.height ?? 0),
        size: fs.statSync(mp4).size, recoveredAt: typeof sidecar.recoveredAt === "string" ? sidecar.recoveredAt : (item?.updatedAt ?? new Date().toISOString()),
        cataloged,
      });
    }
    return entries.sort((a, b) => (a.recoveredAt < b.recoveredAt ? 1 : -1));
  }

  /** Move a recovered recording into the library at its canonical path (reuses the finalize logic). */
  async catalogRecovered(itemId: string): Promise<{ cataloged: boolean; reason?: string; storagePath?: string }> {
    const mp4 = path.join(this.recoveryRoot, safeSegment(itemId), "recovered.mp4");
    if (!fs.existsSync(mp4) || !fs.statSync(mp4).size) throw Object.assign(new Error("No recovered file for this item"), { statusCode: 404 });
    const item = this.db.getItem(itemId);
    if (!item) throw Object.assign(new Error("Recording item not found"), { statusCode: 404 });
    // Guard: the item is already a completed library entry with its file on disk — never overwrite it.
    if (item.status === "completed" && item.storagePath && fs.existsSync(path.join(this.mediaRoot, item.storagePath))) {
      this.clearRecovery(itemId);
      return { cataloged: false, reason: "already-completed" };
    }
    const performer = this.db.getPerformer(item.performerId);
    const source = this.db.getSource(item.sourceId);
    const settings = outputSettings(this.db.getSettings());
    const filename = safeSegment(item.filename ?? `${item.externalId}.mp4`, `${item.externalId}.mp4`);
    const destination = path.join(this.mediaRoot, downloadOutputPath(settings, item, performer?.name ?? "Unsorted", source?.domain ?? "recovered", filename));
    this.prepareOutputDirectory(path.dirname(destination));
    const finalPath = this.availableDestination(destination, item.id);
    const canonicalDate = this.db.setCanonicalMediaDate(item.id, item.publishedAt);
    return this.withFinalizeLock(`output:${itemId}`, async () => {
      await this.applyMediaDate(mp4, item.mediaType, canonicalDate);
      fs.renameSync(mp4, finalPath);
      const relativePath = path.relative(this.mediaRoot, finalPath);
      const checksum = await this.hashFile(finalPath);
      const duplicate = this.db.findByChecksum(checksum, item.id, item.performerId);
      if (duplicate && duplicate.storagePath && fs.existsSync(path.join(this.mediaRoot, duplicate.storagePath))) {
        fs.unlinkSync(finalPath);
        this.db.setItemStatus(item.id, "duplicate", { progress: 1, checksum, duplicateOf: duplicate.id });
        this.clearRecovery(itemId);
        return { cataloged: false, reason: "duplicate" };
      }
      this.db.setItemStatus(item.id, "completed", { progress: 1, checksum, storagePath: relativePath });
      this.clearRecovery(itemId);
      return { cataloged: true, storagePath: relativePath };
    });
  }

  private clearRecovery(itemId: string) {
    const dir = path.join(this.recoveryRoot, safeSegment(itemId));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  async deleteRecovered(itemIds: string[]): Promise<{ deleted: string[]; failed: Array<{ id: string; error: string }> }> {
    const deleted: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of itemIds) {
      try { this.clearRecovery(id); deleted.push(id); }
      catch (error) { failed.push({ id, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { deleted, failed };
  }
}
