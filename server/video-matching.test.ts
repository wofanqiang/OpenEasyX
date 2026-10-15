import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { containmentOffsets, fingerprintVideo, verifyVideoContainment, type VideoFingerprint } from "./video-matching.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-video-match-"));
const full = path.join(root, "full.mp4");
const excerpt = path.join(root, "excerpt.mp4");
const different = path.join(root, "different.mp4");
const staticVideo = path.join(root, "static.mp4");
const signal = () => AbortSignal.timeout(30_000);
const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", "-threads", "1", ...args], { stdio: "pipe" });
let fullPrint: VideoFingerprint; let clipPrint: VideoFingerprint;

beforeAll(async () => {
  ffmpeg("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=40", "-vf", "hue=h=6*t,rotate=0.07*t", "-c:v", "libx264", "-preset", "ultrafast", full);
  ffmpeg("-ss", "7.25", "-i", full, "-t", "16", "-vf", "scale=160:120", "-c:v", "libx264", "-crf", "26", excerpt);
  ffmpeg("-f", "lavfi", "-i", "testsrc=size=160x120:rate=12:duration=16", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", different);
  ffmpeg("-f", "lavfi", "-i", "color=black:size=160x120:rate=12:duration=16", "-c:v", "libx264", "-preset", "ultrafast", staticVideo);
  fullPrint = (await fingerprintVideo(full, signal()))!;
  clipPrint = (await fingerprintVideo(excerpt, signal()))!;
}, 30_000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("video excerpt recognition", () => {
  it("recognizes a trimmed, resized and recompressed excerpt at a non-integer offset", async () => {
    expect(fullPrint.duration).toBe(40);
    expect(clipPrint.duration).toBe(16);
    expect(containmentOffsets(clipPrint, fullPrint).length).toBeGreaterThan(0);
    const match = await verifyVideoContainment(excerpt, clipPrint, full, fullPrint, signal());
    expect(match?.offsetSeconds).toBeCloseTo(7.25, 1);
    expect(match?.durationSeconds).toBe(16);
  });
  it("keeps unrelated videos, black footage, and the full video when only an excerpt exists", async () => {
    const other = (await fingerprintVideo(different, signal()))!;
    const black = (await fingerprintVideo(staticVideo, signal()))!;
    expect(await verifyVideoContainment(different, other, full, fullPrint, signal())).toBeUndefined();
    expect(containmentOffsets(black, { ...black, duration: 40, hashes: Array(80).fill("") })).toEqual([]);
    expect(containmentOffsets(fullPrint, clipPrint)).toEqual([]);
  });
  it.each([0, 24])("recognizes an excerpt at the boundary %s seconds", async (offset) => {
    const file = path.join(root, `boundary-${offset}.mp4`);
    ffmpeg("-ss", String(offset), "-i", full, "-t", "16", "-vf", "scale=160:120", "-c:v", "libx264", "-crf", "26", file);
    const print = (await fingerprintVideo(file, signal()))!;
    expect((await verifyVideoContainment(file, print, full, fullPrint, signal()))?.offsetSeconds).toBeCloseTo(offset, 1);
  });
  it("does not discard a video merely because it shares a long opening", async () => {
    const mixed = path.join(root, "mixed.mp4");
    ffmpeg("-i", excerpt, "-i", different, "-filter_complex", "[0:v]trim=duration=12,setpts=PTS-STARTPTS[a];[1:v]trim=duration=4,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", mixed);
    const print = (await fingerprintVideo(mixed, signal()))!;
    expect(await verifyVideoContainment(mixed, print, full, fullPrint, signal())).toBeUndefined();
  });
  it("requires the RGB verification even when search fingerprints suggest a match", async () => {
    expect(await verifyVideoContainment(different, clipPrint, full, fullPrint, signal())).toBeUndefined();
  });
  it("stops analysis when cancelled and rejects broken input", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fingerprintVideo(full, controller.signal)).rejects.toThrow();
    const broken = path.join(root, "broken.mp4"); fs.writeFileSync(broken, "broken");
    await expect(fingerprintVideo(broken, signal())).rejects.toThrow();
  });
});
