import fs from "node:fs";
import path from "node:path";

/**
 * Constant A/V offset measurement for dual-HLS live captures.
 *
 * Root cause of the desync: the capture command feeds ffmpeg two independent
 * HLS playlists (video and audio). Each input starts recording from its own
 * live edge at the moment ffmpeg opens it, so the two captured streams carry a
 * constant content offset (audio typically ahead by 1-3s under load). The
 * offset is invisible inside capture.ts - the TS muxer rebases both streams to
 * the same start_time - so it can only be measured from source-side wall
 * clock: the #EXT-X-PROGRAM-DATE-TIME (PDT) of the segments ffmpeg actually
 * opened first, read from ffmpeg's stderr ("Opening '<segment>' for reading",
 * emitted at loglevel info by the hls demuxer).
 *
 * The measured shift is stored in a sidecar JSON next to capture.ts:
 *   audioShiftSec = PDT(first audio segment) - PDT(first video segment)
 * Positive means the audio content starts later in real time, i.e. the audio
 * is ahead when both streams are played from 0, and the audio track must be
 * delayed by exactly that amount during the finalize remux (asetpts).
 */

export const AV_SYNC_SIDECAR_SUFFIX = ".avsync.json";

/** Minimum meaningful shift in seconds; below this the offset is noise. */
const MIN_SHIFT_SEC = 0.15;
/** Beyond this the offset is not a start-of-capture sync issue; ignore it. */
const MAX_SHIFT_SEC = 30;
/** Give up measuring if the first segments were not identified by then. */
const MEASURE_TIMEOUT_MS = 45_000;
/** Re-fetch the playlists once to catch windows that slid past our snapshot. */
const REFRESH_AFTER_MS = 8_000;

const FFMPEG_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface AvSyncPlan {
  videoPlaylist: string;
  audioPlaylist: string;
  headerArg?: string;
  sidecarPath: string;
}

export interface AvSyncWatcher {
  onStderr: (text: string) => void;
  dispose: () => void;
}

/**
 * Derive the measurement plan from a generated live-capture command. Only dual
 * playlist inputs (video + separate audio) produce a plan; single-input
 * captures cannot have a cross-stream offset.
 */
export function avSyncPlan(args: string[], outputDir: string): AvSyncPlan | undefined {
  const inputs: string[] = [];
  let headerArg: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "-i" && index + 1 < args.length) inputs.push(args[++index]);
    else if (args[index] === "-headers" && index + 1 < args.length) headerArg = args[++index];
  }
  if (inputs.length < 2) return undefined;
  const [videoPlaylist, audioPlaylist] = inputs;
  if (!/^https?:/i.test(videoPlaylist) || !/^https?:/i.test(audioPlaylist)) return undefined;
  return { videoPlaylist, audioPlaylist, headerArg, sidecarPath: path.join(outputDir, `capture.ts${AV_SYNC_SIDECAR_SUFFIX}`) };
}

function requestHeaders(plan: AvSyncPlan): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": FFMPEG_USER_AGENT };
  if (plan.headerArg) {
    for (const line of plan.headerArg.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
  }
  return headers;
}

interface SegmentTimeline { segments: Map<string, number>; hasPdt: boolean }

async function snapshotSegmentTimeline(playlistUrl: string, headers: Record<string, string>): Promise<SegmentTimeline> {
  const response = await fetch(playlistUrl, { headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`playlist HTTP ${response.status}`);
  let text = await response.text();
  let base = playlistUrl;
  // Masters redirect to a variant playlist; follow the highest-bandwidth one.
  if (text.includes("#EXT-X-STREAM-INF")) {
    let best: { bandwidth: number; url: string } | undefined;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith("#EXT-X-STREAM-INF")) continue;
      const bandwidth = Number(lines[index].match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
      const uri = lines[index + 1]?.trim();
      if (uri && !uri.startsWith("#") && (!best || bandwidth > best.bandwidth)) best = { bandwidth, url: new URL(uri, base).href };
    }
    if (!best) throw new Error("master playlist has no variant");
    base = best.url;
    const variant = await fetch(best.url, { headers, signal: AbortSignal.timeout(12_000) });
    if (!variant.ok) throw new Error(`variant HTTP ${variant.status}`);
    text = await variant.text();
  }
  const segments = new Map<string, number>();
  let currentPdt: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const parsed = Date.parse(line.slice(line.indexOf(":") + 1).trim());
      currentPdt = Number.isNaN(parsed) ? null : parsed / 1000;
    } else if (line.startsWith("#EXTINF:")) {
      // Segment duration is not needed: the PDT of the segment start is enough.
    } else if (line && !line.startsWith("#")) {
      // The PDT tag marks the first sample of the segment it precedes; ffmpeg
      // starts a segment at that real moment, so map segment URI -> start PDT.
      if (currentPdt !== null) segments.set(new URL(line, base).href, currentPdt);
      currentPdt = null;
    }
  }
  return { segments, hasPdt: segments.size > 0 };
}

/**
 * Start measuring the capture's constant A/V offset. Snapshots both playlists
 * (segment URI -> PDT), then watches ffmpeg's stderr for the first segment
 * opened per input. When both are identified, writes the sidecar JSON with
 * `audioShiftSec`. Returns undefined when a playlist is unreachable or carries
 * no PDT tags (in that case the finalize falls back to ffprobe start_time).
 */
export async function startAvSyncMeasurement(plan: AvSyncPlan, log?: (message: string) => void): Promise<AvSyncWatcher | undefined> {
  const headers = requestHeaders(plan);
  let videoSegments: Map<string, number>;
  let audioSegments: Map<string, number>;
  try {
    const [video, audio] = await Promise.all([
      snapshotSegmentTimeline(plan.videoPlaylist, headers),
      snapshotSegmentTimeline(plan.audioPlaylist, headers),
    ]);
    videoSegments = video.segments;
    audioSegments = audio.segments;
  } catch (error) {
    log?.(`av-sync probe skipped: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (!videoSegments.size || !audioSegments.size) {
    log?.("av-sync probe skipped: playlists without PROGRAM-DATE-TIME");
    return undefined;
  }
  return createAvSyncWatcher(videoSegments, audioSegments, plan, log, headers);
}

/**
 * Watch ffmpeg's stderr for the first segment opened per input and write the
 * sidecar with the measured audio shift. Exported for testing; production
 * callers use `startAvSyncMeasurement`.
 */
export function createAvSyncWatcher(videoSegments: Map<string, number>, audioSegments: Map<string, number>, plan: AvSyncPlan, log?: (message: string) => void, headers?: Record<string, string>): AvSyncWatcher {

  let videoPdt: number | undefined;
  let audioPdt: number | undefined;
  let finished = false;
  let lineBuffer = "";
  const openingPattern = /Opening '([^']+)'\s+for reading/g;

  const writeSidecar = () => {
    if (videoPdt === undefined || audioPdt === undefined) return;
    const shift = Number((audioPdt - videoPdt).toFixed(3));
    if (!Number.isFinite(shift)) return;
    const payload = JSON.stringify({
      audioShiftSec: shift,
      method: "hls-pdt",
      videoStartPdt: Number(videoPdt.toFixed(3)),
      audioStartPdt: Number(audioPdt.toFixed(3)),
      measuredAt: new Date().toISOString(),
    });
    try {
      const staging = `${plan.sidecarPath}.tmp`;
      fs.writeFileSync(staging, payload);
      fs.renameSync(staging, plan.sidecarPath);
      log?.(`av-sync measured: audio shift ${shift}s (sidecar written)`);
    } catch { /* Sidecar is best-effort; finalize falls back to ffprobe. */ }
  };

  const scanLine = (line: string) => {
    if (finished || (videoPdt !== undefined && audioPdt !== undefined)) return;
    openingPattern.lastIndex = 0;
    const match = openingPattern.exec(line);
    if (!match) return;
    const url = match[1];
    // Shared URIs would be ambiguous; the two media playlists list distinct files.
    const inVideo = videoSegments.get(url);
    const inAudio = audioSegments.get(url);
    if (inVideo !== undefined && inAudio === undefined && videoPdt === undefined) videoPdt = inVideo;
    else if (inAudio !== undefined && inVideo === undefined && audioPdt === undefined) audioPdt = inAudio;
    if (videoPdt !== undefined && audioPdt !== undefined) {
      finished = true;
      writeSidecar();
    }
  };

  const refreshTimer = setTimeout(() => {
    // The live window slides forward; ffmpeg's first segments may postdate the
    // pre-spawn snapshot. Merge one fresh snapshot (never removes entries).
    if (!headers) return;
    void Promise.allSettled([
      snapshotSegmentTimeline(plan.videoPlaylist, headers),
      snapshotSegmentTimeline(plan.audioPlaylist, headers),
    ]).then(([video, audio]) => {
      if (finished) return;
      if (video.status === "fulfilled") for (const [uri, pdt] of video.value.segments) if (!videoSegments.has(uri)) videoSegments.set(uri, pdt);
      if (audio.status === "fulfilled") for (const [uri, pdt] of audio.value.segments) if (!audioSegments.has(uri)) audioSegments.set(uri, pdt);
    }).catch(() => undefined);
  }, REFRESH_AFTER_MS);
  refreshTimer.unref();

  const giveUpTimer = setTimeout(() => {
    if (!finished) log?.("av-sync probe gave up: first segments not identified");
    finished = true;
  }, MEASURE_TIMEOUT_MS);
  giveUpTimer.unref();

  return {
    onStderr: (text: string) => {
      if (finished) return;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) scanLine(line);
    },
    dispose: () => {
      finished = true;
      clearTimeout(refreshTimer);
      clearTimeout(giveUpTimer);
    },
  };
}

/** Read a measurement sidecar; returns a validated shift or undefined. */
export function readAvSyncSidecar(sidecarPath: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as { audioShiftSec?: unknown };
    const shift = Number(parsed.audioShiftSec);
    if (!Number.isFinite(shift) || Math.abs(shift) <= MIN_SHIFT_SEC || Math.abs(shift) > MAX_SHIFT_SEC) return undefined;
    return shift;
  } catch {
    return undefined;
  }
}
