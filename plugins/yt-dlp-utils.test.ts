import { describe, expect, it } from "vitest";
import { ffmpegLiveCaptureCommand, liveStreamFromInfo, ytDlpDownload } from "./yt-dlp-utils.js";

describe("live stream selection", () => {
  it("keeps separate live video and audio tracks when yt-dlp selected both formats", () => {
    const master = "https://cdn.test/master.m3u8?token=fresh";
    expect(liveStreamFromInfo({
      requested_formats: [
        { url: "https://cdn.test/video.m3u8", manifest_url: master, vcodec: "avc1", acodec: "none", height: 1080 },
        { url: "https://cdn.test/audio.m3u8", manifest_url: master, vcodec: "none", acodec: "aac" },
      ],
      formats: [{ url: "https://cdn.test/audio-low.m3u8", vcodec: "none", acodec: "aac" }],
      http_headers: { Referer: "https://live.test/" },
    }, "alice")).toEqual({
      url: "https://cdn.test/video.m3u8", audioUrl: "https://cdn.test/audio.m3u8",
      headers: { Referer: "https://live.test/" }, contentType: "application/vnd.apple.mpegurl",
    });
  });

  it("keeps the best muxed stream when no master manifest exists", () => {
    expect(liveStreamFromInfo({ formats: [
      { url: "https://cdn.test/360.mp4", vcodec: "h264", acodec: "aac", height: 360 },
      { url: "https://cdn.test/720.mp4", vcodec: "h264", acodec: "aac", height: 720 },
    ] }, "alice")).toEqual({ url: "https://cdn.test/720.mp4", headers: undefined, contentType: undefined });
  });
});

describe("live recording output", () => {
  it("writes browser-playable MP4 instead of MPEG-TS bytes behind an .mp4 name", () => {
    const request = ytDlpDownload({ externalId: "live:alice", mediaType: "video", pageUrl: "https://live.test/alice", filename: "alice.mp4" }, {}, { live: true });
    expect(request.args).toContain("--no-hls-use-mpegts");
    expect(request.args).not.toContain("--hls-use-mpegts");
    expect(request.args).toEqual(expect.arrayContaining(["--merge-output-format", "mp4", "--remux-video", "mp4"]));
  });

  it("captures a live stream to MPEG-TS with ffmpeg and self-reconnect flags", () => {
    const stream = { url: "https://cdn.test/live.m3u8?token=fresh", audioUrl: "https://cdn.test/audio.m3u8", headers: { Referer: "https://live.test/", "User-Agent": "yt-dlp" } };
    const request = ffmpegLiveCaptureCommand(stream, { referer: "https://live.test/", output: "{outputDir}/capture.ts", filename: "alice.mp4" });
    expect(request.command).toBe("ffmpeg");
    expect(request.filename).toBe("alice.mp4");
    // reconnect lets a transient 403 / network blip self-heal inside one ffmpeg process
    expect(request.args).toContain("-reconnect");
    expect(request.args).toContain("-reconnect_on_http_error");
    expect(request.args).toContain("5xx");
    // straight to MPEG-TS so the downloader can remux + delete afterwards
    expect(request.args).toEqual(expect.arrayContaining(["-f", "mpegts", "{outputDir}/capture.ts"]));
    // per-stream headers are forwarded (minus User-Agent, which ffmpeg emits itself)
    const headerArg = request.args[request.args.indexOf("-headers") + 1];
    expect(headerArg).toContain("Referer: https://live.test/");
    expect(headerArg).not.toContain("User-Agent:");
    // audio is mapped in when a separate audio track exists
    expect(request.args).toEqual(expect.arrayContaining(["-i", "https://cdn.test/audio.m3u8", "-map", "0", "-map", "1:a:0?"]));
  });
});
