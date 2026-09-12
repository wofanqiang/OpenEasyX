import fs from "node:fs";
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
import type { MediaCandidate } from "../packages/plugin-sdk/index.js";

type ActiveDownload = { child?: ChildProcess; abort?: AbortController; paused: boolean; encoding?: boolean; action?: "stop" | "cancel" | "delete"; stalled?: boolean };

export class DownloadQueue {
  private active = new Map<string, ActiveDownload>();
  private finalizers = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  constructor(
    private db: Database,
    private plugins: PluginManager,
    private mediaRoot: string,
    private writeLog?: LogWriter,
    private onCompleted?: () => unknown | Promise<unknown>,
    private onDeleteCompleted?: (item: DownloadItem) => unknown,
  ) {}

  start() {
    fs.mkdirSync(this.mediaRoot, { recursive: true });
    fs.mkdirSync(this.downloadsRoot, { recursive: true, mode: 0o700 });
    this.db.requeueInterruptedDownloads();
    this.cleanupStaleDownloads();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const control of this.active.values()) { this.signal(control, "SIGTERM"); control.abort?.abort(); }
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
    this.signal(control, "SIGCONT"); this.signal(control, action === "stop" ? "SIGINT" : "SIGTERM"); control.abort?.abort();
    return this.db.setItemStatus(itemId, action === "stop" ? "stopping" : "cancelling");
  }

  private async tick() {
    const max = Math.max(1, Math.min(8, Number(this.db.getSettings().maxConcurrentDownloads ?? 2)));
    while (this.active.size < max) {
      const item = this.db.nextQueued();
      if (!item || this.active.has(item.id)) return;
      const control: ActiveDownload = { paused: false };
      this.active.set(item.id, control);
      this.db.setItemStatus(item.id, "downloading", { progress: 0 });
      this.writeLog?.("info", "download", "Download started", { itemId: item.id, pluginId: item.pluginId, title: item.title, mediaType: item.mediaType });
      void this.download(item, control).finally(() => this.active.delete(item.id));
    }
  }

  private async download(item: DownloadItem, control: ActiveDownload) {
    let temporary = "";
    let temporaryDirectory = "";
    let preserveTemporary = false;
    let recordingFinalize = false;
    let avWatcher: AvSyncWatcher | undefined;
    let lastProgress = 0; let lastBytes = 0; let lastProgressUpdate = 0; let lastActivity = Date.now();
    const reportProgress = (progress?: number, downloadedBytes?: number, force = false) => {
      const nextProgress = progress === undefined ? lastProgress : Math.max(lastProgress, Math.min(0.99, Math.max(0, progress)));
      const nextBytes = downloadedBytes === undefined ? lastBytes : Math.max(lastBytes, downloadedBytes);
      const stamp = Date.now();
      if (!force && stamp - lastProgressUpdate < 250 && nextProgress - lastProgress < 0.005 && nextBytes - lastBytes < 256 * 1024) { lastActivity = stamp; return; }
      lastProgress = nextProgress; lastBytes = nextBytes; lastProgressUpdate = stamp; lastActivity = stamp;
      if (!control.action) this.db.setItemStatus(item.id, control.paused ? "paused" : "downloading", { progress: nextProgress, downloadedBytes: nextBytes });
    };
    const stallTimeoutMs = Math.max(0, Number(this.db.getSettings().downloadStallTimeoutSeconds ?? 120)) * 1000;
    const stallTimer = stallTimeoutMs > 0 ? setInterval(() => {
      if (!control.action && !control.paused && Date.now() - lastActivity > stallTimeoutMs) {
        control.stalled = true; control.abort?.abort(); this.signal(control, "SIGKILL");
      }
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
      const request = (await liveRecordingRequest(plugin, context, candidate))
        ?? (plugin.resolveDownload ? await plugin.resolveDownload(context, candidate) : undefined);
      if (!request) throw new Error("This plugin cannot resolve downloads");
      const fallback = `${item.externalId}.${item.mediaType === "image" ? "jpg" : item.mediaType === "video" ? "mp4" : "bin"}`;
      const requestUrl = request.kind === "command" ? item.pageUrl ?? item.externalId : request.url;
      const filename = safeSegment(request.filename ?? item.filename ?? filenameFromUrl(requestUrl, fallback), fallback);
      const destination = path.join(this.mediaRoot, downloadOutputPath(settings, item, performer.name, source.domain, filename));
      this.prepareOutputDirectory(path.dirname(destination));
      temporaryDirectory = path.join(this.downloadsRoot, safeSegment(item.id, "download"));
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
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
          if (fs.existsSync(tsPath) && fs.statSync(tsPath).size > 0) {
            const mp4Staging = path.join(temporaryDirectory, "encoded.mp4");
            // A live capture ends either because the user pressed stop or because the
            // stream went offline, and in both cases the capture is already finished:
            // the remux below concludes the recording, it is not a fresh download.
            // Clear any pending action *before* spawning ffmpeg, because
            // runCommandDownload immediately signals a child spawned while
            // control.action is still set. Left as "stop", it would SIGINT the remux the
            // instant it starts, produce no MP4, and let the catch branch discard the
            // whole capture. `encoding` then keeps a later stop/cancel from cutting the
            // remux short (see interrupt()).
            control.action = undefined;
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
            let audioShift = readAvSyncSidecar(tsPath + ".avsync.json") ?? 0;
            if (audioShift === 0) {
              try {
                const probe = await this.capture("ffprobe", [
                  "-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", tsPath,
                ]);
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
            await this.runCommandDownload("ffmpeg", [
              "-y", "-fflags", "+genpts+igndts", "-i", tsPath,
              "-map", "0", "-c:v", "copy", "-c:a", "aac",
              ...(audioFilter ? ["-af", audioFilter] : []),
              // Still corrects any drift inside the audio timeline itself.
              "-async", "1",
              "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", mp4Staging,
            ], temporaryDirectory, undefined, () => {}, control);
            if (control.action === "cancel" || control.action === "delete") throw new Error("Remux cancelled");
            if (!fs.existsSync(mp4Staging) || !fs.statSync(mp4Staging).size) throw new Error("Remux to MP4 produced no output");
            fs.unlinkSync(tsPath);
            fs.renameSync(mp4Staging, temporary);
          }
        }
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size === 0) throw new Error("Extractor completed without producing a media file");
        reportProgress(0.99, fs.statSync(temporary).size, true);
        checksum = await this.hashFile(temporary);
      } else {
        const controller = new AbortController(); control.abort = controller;
        const response = await fetch(request.url, { method: request.method ?? "GET", headers: request.headers, body: request.body, redirect: "follow", signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`Download returned HTTP ${response.status}`);
        const contentLength = Number(response.headers.get("content-length") ?? item.expectedBytes ?? 0);
        const hash = createHash("sha256"); let received = 0;
        const readable = Readable.fromWeb(response.body as any);
        readable.on("data", (chunk: Buffer) => {
          hash.update(chunk); received += chunk.length;
          reportProgress(contentLength ? received / contentLength : undefined, received);
        });
        await pipeline(readable, fs.createWriteStream(temporary, { mode: 0o600 }));
        reportProgress(contentLength ? received / contentLength : undefined, received, true);
        checksum = hash.digest("hex");
      }
      if (control.action === "cancel" || control.action === "delete") throw new Error("Download cancelled");
      if (item.mediaType === "video" && item.metadata.live === true && settings.recordingPreset && settings.recordingPreset !== "source") {
        const encoded = path.join(temporaryDirectory, "encoded.mp4");
        control.action = undefined; control.encoding = true;
        this.db.setItemStatus(item.id, "downloading", { progress: 0.99 });
        this.writeLog?.("info", "download", "Encoding live recording", { itemId: item.id, preset: settings.recordingPreset });
        await this.runCommandDownload("ffmpeg", recordingEncodingArgs(settings.recordingPreset, temporary, encoded), temporaryDirectory, undefined, () => {}, control);
        if (control.action === "cancel" || control.action === "delete") throw new Error("Encoding cancelled");
        if (!fs.existsSync(encoded) || !fs.statSync(encoded).size) throw new Error("Encoder completed without producing a media file");
        fs.unlinkSync(temporary); temporary = encoded;
        checksum = await this.hashFile(temporary);
      }
      await this.withFinalizeLock("output", async () => {
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
      const recoverySource = temporary && fs.existsSync(temporary)
        ? temporary
        : (capturePath && fs.existsSync(capturePath) && fs.statSync(capturePath).size > 0 ? capturePath : "");
      if (!control.action && !control.paused && recoverySource) {
        const partialBytes = fs.statSync(recoverySource).size;
        const isLiveRecording = (item.metadata as Record<string, unknown> | undefined)?.live === true;
        if (control.encoding || (isLiveRecording && partialBytes > 0)) {
          try {
            const recoveryDirectory = path.join(this.mediaRoot, ".recording-recovery", safeSegment(item.id));
            this.prepareOutputDirectory(recoveryDirectory);
            const recovery = this.availableDestination(path.join(recoveryDirectory, path.basename(recoverySource)), item.id);
            fs.renameSync(recoverySource, recovery); temporary = "";
            message += ` Recording preserved for recovery at ${path.relative(this.mediaRoot, recovery)}.`;
          } catch {
            preserveTemporary = true;
            message += ` Recording preserved in staging at ${path.relative(this.mediaRoot, recoverySource)}; recover it before retrying.`;
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
        this.handleFailure(item.id, message, control);
      }
    } finally {
      if (stallTimer) clearInterval(stallTimer);
      avWatcher?.dispose();
      if (temporaryDirectory && !preserveTemporary) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      if (control.action === "delete") this.db.deleteItem(item.id);
    }
  }

  private handleFailure(itemId: string, message: string, control: ActiveDownload) {
    const settings = this.db.getSettings();
    const maxAttempts = Math.max(0, Number(settings.downloadRetryAttempts ?? 5));
    const attempts = (this.db.getItem(itemId)?.attempts ?? 0) + 1;
    if (attempts < maxAttempts) {
      const base = Math.max(1, Number(settings.downloadRetryBaseSeconds ?? 30));
      const delay = Math.min(base * 2 ** (attempts - 1), 3600) * 1000;
      const jitter = Math.floor(Math.random() * Math.min(delay, 30_000));
      const nextRetryAt = new Date(Date.now() + delay + jitter).toISOString();
      this.db.scheduleRetry(itemId, message, attempts, nextRetryAt);
      this.writeLog?.("warn", "download", "Download failed, scheduling automatic retry", { itemId, attempt: attempts, maxAttempts, nextRetryAt, error: message });
    } else {
      this.db.setItemStatus(itemId, "failed", { error: message });
      this.writeLog?.("error", "download", "Download failed permanently after exhausting retries", { itemId, attempts, error: message });
    }
  }

  private cleanupStaleDownloads() {
    try {
      const root = this.downloadsRoot;
      if (!fs.existsSync(root)) return;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (this.active.has(entry.name)) continue;
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      }
    } catch { /* Best-effort startup cleanup; never blocks startup. */ }
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

  private runCommandDownload(command: string, args: string[], outputDirectory: string, expectedBytes: number | undefined, reportProgress: (progress?: number, downloadedBytes?: number, force?: boolean) => void, control: ActiveDownload, onStderr?: (text: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      // Memory guard for live recordings on small VPS: cap yt-dlp fragment concurrency
      // and buffer so a single download cannot balloon the cgroup and trip OOM.
      const effectiveArgs = command === "yt-dlp"
        ? [...args, "--concurrent-fragments", "1", "--buffer-size", "4M"]
        : args;
      const child = spawn(command, effectiveArgs, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      control.child = child;
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
      const poll = setInterval(() => {
        const downloadedBytes = this.directoryBytes(outputDirectory);
        if (downloadedBytes > 0) reportProgress(expectedBytes ? downloadedBytes / expectedBytes : undefined, downloadedBytes);
      }, 250); poll.unref();
      const finish = (error?: Error) => { if (settled) return; settled = true; clearInterval(poll); error ? reject(error) : resolve(); };
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        control.child = undefined;
        if (code === 0 || (control.action === "stop" && this.directoryBytes(outputDirectory) > 0)) finish();
        else finish(new Error(`${command} exited with code ${code}: ${output.trim() || "no error output"}`));
      });
    });
  }

  private directoryBytes(directory: string): number {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return total + this.directoryBytes(target);
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
      const exifDate = date.toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
      try { await this.capture("exiftool", ["-overwrite_original", `-DateTimeOriginal=${exifDate}`, `-CreateDate=${exifDate}`, `-ModifyDate=${exifDate}`, `-XMP:DateCreated=${date.toISOString()}`, file]); } catch { /* Filesystem date still preserves the canonical date. */ }
    } else if (mediaType === "video" && [".mp4", ".m4v", ".mov", ".mkv", ".webm"].includes(path.extname(file).toLowerCase())) {
      const extension = path.extname(file); const dated = `${file}.dated${extension}`;
      try {
        await this.capture("ffmpeg", ["-y", "-v", "error", "-i", file, "-map", "0", "-map_metadata", "0", "-c", "copy", "-metadata", `creation_time=${date.toISOString()}`, "-metadata", `date=${date.toISOString()}`, dated]);
        if (fs.existsSync(dated) && fs.statSync(dated).size > 0) fs.renameSync(dated, file);
      } catch { if (fs.existsSync(dated)) fs.unlinkSync(dated); }
    }
    fs.utimesSync(file, date, date);
  }

  async applyStoredMediaDates(itemIds: string[]) {
    for (const itemId of [...new Set(itemIds)]) {
      const item = this.db.getItem(itemId);
      if (!item?.storagePath || item.status !== "completed") continue;
      await this.withFinalizeLock("output", () => this.applyMediaDate(path.join(this.mediaRoot, item.storagePath!), item.mediaType, item.publishedAt));
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

  private async withFinalizeLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.finalizers.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.finalizers.set(key, settled);
    try { return await result; }
    finally { if (this.finalizers.get(key) === settled) this.finalizers.delete(key); }
  }
}
