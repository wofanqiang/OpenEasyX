import { describe, expect, it, vi } from "vitest";
import type { EasyXPlugin, PluginContext } from "./plugin-sdk/index.js";
import { ffmpegLiveCaptureCommand, liveRecordingRequest, liveReferer } from "./live-capture.js";

const context: PluginContext = {
  config: {}, fetch, runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }), log: () => undefined,
};

function plugin(resolveLiveStream?: EasyXPlugin["resolveLiveStream"]): EasyXPlugin {
  return {
    manifest: { id: "test.live", name: "Test", version: "1", description: "Test", author: "Test", capabilities: ["live-cam", "download-resolver"] },
    resolveLiveStream,
  };
}

const liveItem = {
  externalId: "chaturbate:alice:1", identityKey: "chaturbate:alice:1", title: "Alice live",
  pageUrl: "https://chaturbate.com/alice", mediaType: "video" as const, filename: "alice-1.mp4", metadata: { live: true },
};

describe("live capture request", () => {
  it("captures the stream to MPEG-TS with reconnect enabled", () => {
    const request = ffmpegLiveCaptureCommand(
      { url: "https://cdn.test/a.m3u8", headers: { Cookie: "sid=1" } },
      { referer: "https://site.test/", output: "{outputDir}/capture.ts", filename: "a.mp4" },
    );
    expect(request.command).toBe("ffmpeg");
    expect(request.filename).toBe("a.mp4");
    expect(request.args).toEqual(expect.arrayContaining(["-reconnect_delay_max", "10", "-c", "copy", "-f", "mpegts", "{outputDir}/capture.ts"]));
    expect(request.args).not.toContain("-reconnect_delay_total_max");
    const headers = request.args[request.args.indexOf("-headers") + 1];
    expect(headers).toContain("Cookie: sid=1");
    expect(headers).toContain("Referer: https://site.test/");
  });

  it("muxes a separate audio rendition when the stream exposes one", () => {
    const request = ffmpegLiveCaptureCommand(
      { url: "https://cdn.test/v.m3u8", audioUrl: "https://cdn.test/a.m3u8" },
      { output: "{outputDir}/capture.ts", filename: "a.mp4" },
    );
    expect(request.args).toEqual(expect.arrayContaining(["-i", "https://cdn.test/v.m3u8", "-i", "https://cdn.test/a.m3u8", "-map", "0", "-map", "1:a:0?"]));
  });

  it("derives the referer from the recorded page origin", () => {
    expect(liveReferer("https://chaturbate.com/alice")).toBe("https://chaturbate.com/");
    expect(liveReferer(undefined)).toBeUndefined();
  });

  it("takes priority over the plugin download path for a live item", async () => {
    const resolveLiveStream = vi.fn(async () => ({ url: "https://cdn.test/a.m3u8" }));
    const request = await liveRecordingRequest(plugin(resolveLiveStream), context, liveItem);
    expect(resolveLiveStream).toHaveBeenCalledOnce();
    expect(request).toMatchObject({ kind: "command", command: "ffmpeg", filename: "alice-1.mp4" });
    expect(request!.args).toEqual(expect.arrayContaining(["-f", "mpegts", "{outputDir}/capture.ts"]));
  });

  it("leaves non-live items to the plugin", async () => {
    const resolveLiveStream = vi.fn();
    expect(await liveRecordingRequest(plugin(resolveLiveStream), context, { ...liveItem, metadata: { live: false } })).toBeUndefined();
    expect(resolveLiveStream).not.toHaveBeenCalled();
  });

  it("falls back when the plugin has no live resolver", async () => {
    expect(await liveRecordingRequest(plugin(undefined), context, liveItem)).toBeUndefined();
  });

  it("falls back and logs when live resolution fails", async () => {
    const log = vi.fn();
    const request = await liveRecordingRequest(plugin(async () => { throw new Error("room is offline"); }), { ...context, log }, liveItem);
    expect(request).toBeUndefined();
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("falling back"), "room is offline");
  });
});
