import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOUFLON_KEYMAP } from "../packages/hls-mouflon.js";
import { HlsProxy } from "./hls-proxy.js";

/**
 * End-to-end proof of the claim the rest of the suite only asserts in pieces: a recorder that
 * talks to this proxy over plain HTTP ends up with real frames, and never asks the CDN for the
 * decoy address. Uses a local ffmpeg and a stubbed CDN, so it needs no network and no live room.
 *
 * The recording must be spawned asynchronously — the stub CDN lives in this process, so blocking
 * the event loop while ffmpeg waits for a response would deadlock.
 */

const KEY = MOUFLON_KEYMAP["Ook7quaiNgiyuhai"]!;
const VARIANT = "https://cdn.test/vr/156104630_vr_1440p60.m3u8";

// Two segments. Each `#EXT-X-MOUFLON:URI:` hint carries the real, still-encrypted address; the
// URI line beneath it is the decoy a naive parser (ffmpeg included) would fetch instead.
const MEDIA = [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MEDIA-SEQUENCE:5385",
  "#EXTINF:2.000",
  "#EXT-X-MOUFLON:URI:https://cdn.test/vr/156104630_vr_1440p60_h264_5385_Ao5b8oKcwmYOOsIxLlofVy_1789400984.mp4",
  "https://cdn.test/vr/media.mp4",
  "#EXTINF:2.000",
  "#EXT-X-MOUFLON:URI:https://cdn.test/vr/156104630_vr_1440p60_h264_5386_Qv9/c29MAps+NroUJhdD1w_1789400986.mp4",
  "https://cdn.test/vr/media.mp4",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 << 20 },
      (error, stdout, stderr) => (error ? reject(new Error(`${file} failed: ${String(stderr).slice(-500)}`)) : resolve(String(stdout ?? ""))));
  });
}

let ffmpegAvailable = true;
try { execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" }); }
catch { ffmpegAvailable = false; }

describe.skipIf(!ffmpegAvailable)("HLS proxy as a recorder source", () => {
  let root = "";
  let source = "";
  let output = "";
  let probe = "";
  let requested: string[] = [];

  beforeAll(async () => {
    requested = [];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hls-proxy-e2e-"));
    source = path.join(root, "segment.mp4");
    output = path.join(root, "recorded.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "testsrc=duration=2:size=320x240:rate=15", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", source]);

    const stub = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes(".m3u8")) {
        return new Response(MEDIA, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
      }
      return new Response(fs.readFileSync(source), { status: 200, headers: { "content-type": "video/mp4" } });
    }) as unknown as typeof fetch;

    const proxy = new HlsProxy(stub);
    const entry = proxy.register({ url: VARIANT, headers: { Referer: "https://site.test/" }, playlistDecodeKey: KEY });

    const app = Fastify();
    app.get("/api/live-cams/proxy/*", async (request, reply) => {
      return proxy.serve((request.params as { "*": string })["*"], reply, request.query as Record<string, unknown>, request.headers.range);
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      // Plain http, no -protocol_whitelist: this is exactly what the recorder builds.
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
        "-i", `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${entry}`, "-c", "copy", output]);
    } finally {
      await app.close();
    }
    probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height",
      "-of", "default=noprint_wrappers=1", output]);
  }, 180_000);

  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("produces a file with real video frames", () => {
    expect(fs.statSync(output).size).toBeGreaterThan(1000);
    expect(probe).toContain("codec_name=h264");
    expect(probe).toContain("width=320");
    expect(Number(/duration=([\d.]+)/.exec(probe)?.[1] ?? 0)).toBeGreaterThan(1);
  });

  it("never asks the CDN for the decoy address", () => {
    // The decoy is what a recorder parsing the playlist as written would fetch. This proves the
    // rewrite happened for real, not only inside a unit test of the rewriter.
    expect(requested.filter((url) => url.includes("media.mp4"))).toEqual([]);
  });

  it("requests the decrypted segment addresses", () => {
    const segments = requested.filter((url) => url.includes("_538"));
    expect(segments.length).toBeGreaterThanOrEqual(2);
    // `Ao5b8oKcwmYOOsIxLlofVy` decrypts to `gFbIS9EhCnNf0nWm`; `Qv9/...` to `mAWYzYYTwQJQJgSp`.
    expect(segments.join(" ")).toContain("gFbIS9EhCnNf0nWm");
    expect(segments.join(" ")).toContain("mAWYzYYTwQJQJgSp");
  });
});
