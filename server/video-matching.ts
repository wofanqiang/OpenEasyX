import fs from "node:fs";
import { spawn } from "node:child_process";

// Versioned, compact fingerprints are only a search index. A match must also
// pass a separate RGB comparison of the entire proposed excerpt.
export type VideoFingerprint = { version: 1; duration: number; hashes: string[] };
export type VideoContainment = { offsetSeconds: number; durationSeconds: number };
const INDEX_FPS = 2;
const VERIFY_FPS = 4;
const PIXELS = 32 * 32 * 3;
const MIN_SECONDS = 10;
const MAX_SECONDS = 6 * 3600;
const MAX_CLIP_SECONDS = 30 * 60;
const bits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

export function videoFileStamp(file: string) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw new Error("Video file is unavailable");
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function distance(a: string, b: string) {
  if (!a || !b || a.length !== 32 || b.length !== 32) return 128;
  let count = 0;
  for (let i = 0; i < 32; i++) count += bits[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return count;
}

function frameHash(frame: Buffer) {
  if (Math.max(...frame) - Math.min(...frame) < 24) return "";
  let hash = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x += 4) {
      let nibble = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (frame[y * 17 + x + bit] > frame[y * 17 + x + bit + 1]) nibble |= 1 << (3 - bit);
      }
      hash += nibble.toString(16);
    }
  }
  return hash;
}

function excerptAnchors(clip: VideoFingerprint): number[] {
  if (clip.version !== 1 || clip.duration < MIN_SECONDS || clip.duration > MAX_CLIP_SECONDS) return [];
  const samples = Array.from({ length: 16 }, (_, i) => Math.round(i * (clip.hashes.length - 1) / 15));
  const distinct: string[] = [];
  for (const index of samples) {
    const hash = clip.hashes[index];
    if (hash && distinct.every((other) => distance(hash, other) >= 16)) distinct.push(hash);
  }
  // Static scenes, black screens and very repetitive content are inconclusive.
  if (distinct.length < 5) return [];
  const anchors = samples.filter((index) => !!clip.hashes[index]);
  if (anchors.length < 12) return [];
  return anchors;
}

export function canMatchVideoExcerpt(clip: VideoFingerprint) { return excerptAnchors(clip).length > 0; }

/** Search for a consistent time offset, never merely a shared opening/thumbnail. */
export function containmentOffsets(clip: VideoFingerprint, full: VideoFingerprint): number[] {
  if (full.version !== 1 || full.duration < clip.duration + Math.max(2, clip.duration * 0.05)) return [];
  const anchors = excerptAnchors(clip);
  if (!anchors.length) return [];
  const result: number[] = [];
  const lastOffset = Math.floor((full.duration - clip.duration) * INDEX_FPS);
  for (let offset = 0; offset <= lastOffset; offset++) {
    let matches = 0;
    for (const index of anchors) {
      if (distance(clip.hashes[index], full.hashes[index + offset]) <= 32) matches++;
    }
    if (matches >= Math.ceil(anchors.length * 0.9)) result.push(offset / INDEX_FPS);
    // Many possible locations mean ambiguous/repeating footage: keep the clip.
    if (result.length > 12) return [];
  }
  return result;
}

function rgbMatch(clip: Buffer, full: Buffer, offsetFrames: number) {
  const count = Math.floor(clip.length / PIXELS);
  if (count < MIN_SECONDS * VERIFY_FPS || full.length < (offsetFrames + count) * PIXELS) return false;
  let misses = 0; let previousMiss = false;
  for (let frame = 0; frame < count; frame++) {
    let error = 0;
    const a = frame * PIXELS; const b = (frame + offsetFrames) * PIXELS;
    for (let pixel = 0; pixel < PIXELS; pixel++) error += Math.abs(clip[a + pixel] - full[b + pixel]);
    const miss = error / PIXELS > 6;
    if (miss) {
      misses++;
      if (previousMiss || frame < 3 || frame >= count - 3 || misses > Math.floor(count * 0.01)) return false;
    }
    previousMiss = miss;
  }
  return true;
}

/** Every process has a time/output bound and is killed on cancellation. */
function capture(command: string, args: string[], signal: AbortSignal, limit: number, timeoutMs: number): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let bytes = 0; let error = ""; let failure: Error | undefined;
    const kill = (reason: Error) => { failure ??= reason; child.kill("SIGKILL"); };
    const abort = () => kill(new Error("Video comparison cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => kill(new Error("Video comparison timed out")), timeoutMs); timer.unref();
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) kill(new Error("Video comparison output limit exceeded"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => { error = `${error}${String(chunk)}`.slice(-1000); });
    child.once("error", (reason) => { cleanup(); reject(reason); });
    child.once("close", (code) => {
      cleanup();
      if (failure || code !== 0) reject(failure ?? new Error(`${command}: ${error}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export async function fingerprintVideo(file: string, signal: AbortSignal): Promise<VideoFingerprint | undefined> {
  const probe = await capture("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=duration", "-of", "json", file], signal, 64 * 1024, 10_000);
  const info = JSON.parse(probe.toString("utf8"));
  const duration = Number(info.streams?.[0]?.duration ?? info.format?.duration);
  if (!info.streams?.length || !Number.isFinite(duration) || duration < MIN_SECONDS || duration > MAX_SECONDS) return undefined;
  const frames = await capture("ffmpeg", ["-nostdin", "-v", "error", "-threads", "1", "-i", file, "-map", "0:v:0", "-an", "-sn", "-vf", `fps=${INDEX_FPS},scale=17:8:flags=area,format=gray`, "-threads", "1", "-f", "rawvideo", "pipe:1"], signal, Math.ceil(MAX_SECONDS * INDEX_FPS + 2) * 136, 120_000);
  const count = frames.length / 136;
  // Reject truncated/partial analysis rather than comparing only its beginning.
  if (!Number.isInteger(count) || Math.abs(count / INDEX_FPS - duration) > 1) return undefined;
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) hashes.push(frameHash(frames.subarray(i * 136, (i + 1) * 136)));
  return { version: 1, duration, hashes };
}

async function verificationFrames(file: string, start: number, duration: number, signal: AbortSignal) {
  return capture("ffmpeg", ["-nostdin", "-v", "error", "-threads", "1", "-ss", start.toFixed(3), "-i", file,
    "-t", duration.toFixed(3), "-map", "0:v:0", "-an", "-sn", "-vf", `fps=${VERIFY_FPS},scale=32:32:flags=area,format=rgb24`,
    "-threads", "1", "-f", "rawvideo", "pipe:1"], signal, (MAX_CLIP_SECONDS + 3) * VERIFY_FPS * PIXELS, 120_000);
}

export async function verifyVideoContainment(clipFile: string, clip: VideoFingerprint, fullFile: string, full: VideoFingerprint, signal: AbortSignal): Promise<VideoContainment | undefined> {
  const offsets = containmentOffsets(clip, full);
  if (!offsets.length) return undefined;
  const shortFrames = await verificationFrames(clipFile, 0, clip.duration, signal);
  if (Math.abs(shortFrames.length / PIXELS / VERIFY_FPS - clip.duration) > 0.3) return undefined;
  for (const offset of offsets) {
    signal.throwIfAborted();
    const start = Math.max(0, offset - 0.5);
    const fullFrames = await verificationFrames(fullFile, start, clip.duration + 1, signal);
    for (let shift = 0; shift <= 4; shift++) {
      const exactOffset = start + shift / VERIFY_FPS;
      if (exactOffset + clip.duration > full.duration + 0.1) continue;
      if (rgbMatch(shortFrames, fullFrames, shift)) return { offsetSeconds: exactOffset, durationSeconds: clip.duration };
    }
  }
  return undefined;
}
