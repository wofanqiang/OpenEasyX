import { describe, expect, it, vi } from "vitest";
import type { EasyXPlugin, PluginContext } from "./plugin-sdk/index.js";
import { LIVE_MASTER_PLAYLIST, captureInputPreference, chooseDirectCaptureInput, ffmpegLiveCaptureCommand, isLiveCandidate, liveMasterPlaylist, liveRecordingRequest, liveReferer } from "./live-capture.js";

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
    expect(request.args).toEqual(expect.arrayContaining(["-reconnect_delay_max", "10", "-c", "copy"]));
    // A10: rolling TS segments on packet boundaries; the downloader injects the resume point.
    expect(request.args).toEqual(expect.arrayContaining([
      "-f", "segment", "-segment_format", "mpegts", "-reset_timestamps", "1",
      "-segment_start_number", "{segmentStart}", "{outputDir}/capture_part%03d.ts",
    ]));
    expect(request.args).not.toContain("-reconnect_delay_total_max");
    // For HLS, -reconnect_at_eof loops forever instead of progressing; never emit it.
    expect(request.args).not.toContain("-reconnect_at_eof");
    const headers = request.args[request.args.indexOf("-headers") + 1];
    expect(headers).toContain("Cookie: sid=1");
    expect(headers).toContain("Referer: https://site.test/");
  });

  it("gives every input a read timeout so a stalled socket cannot hang the capture", () => {
    // -reconnect only reacts to a closed or errored connection. A CDN that keeps the socket open
    // and stops sending blocks ffmpeg forever; before the timeout existed only the downloader's
    // stall timer ended that, and it SIGKILLs the whole capture. 15s must stay below that timer
    // (60s for a live item) so ffmpeg gets to reconnect first.
    const request = ffmpegLiveCaptureCommand(
      { url: "https://cdn.test/v.m3u8", audioUrl: "https://cdn.test/a.m3u8" },
      { output: "{outputDir}/capture.ts", filename: "a.mp4" },
    );
    const index = request.args.indexOf("-rw_timeout");
    expect(index).toBeGreaterThan(-1);
    const microseconds = Number(request.args[index + 1]);
    expect(microseconds).toBe(15_000_000);
    expect(microseconds / 1_000_000).toBeLessThan(60);
    // A protocol option must be given before the inputs it applies to.
    expect(index).toBeLessThan(request.args.indexOf("-i"));
  });

  it("muxes a separate audio rendition when the stream exposes one", () => {
    const request = ffmpegLiveCaptureCommand(
      { url: "https://cdn.test/v.m3u8", audioUrl: "https://cdn.test/a.m3u8" },
      { output: "{outputDir}/capture.ts", filename: "a.mp4" },
    );
    expect(request.args).toEqual(expect.arrayContaining(["-i", "https://cdn.test/v.m3u8", "-i", "https://cdn.test/a.m3u8", "-map", "0", "-map", "1:a:0?"]));
    // Each input gets its own queue so the two demuxers cannot block each other.
    expect(request.args.filter((argument) => argument === "-thread_queue_size")).toHaveLength(2);
  });

  it("feeds ffmpeg one master playlist when the capture is asked to use a single input", async () => {
    // Two inputs each start at their own live edge and bake a constant offset into the capture.
    // One master input hands both renditions to a single demuxer, which aligns them itself.
    const resolveLiveStream = vi.fn(async () => ({ url: "https://cdn.test/v.m3u8", audioUrl: "https://cdn.test/a.m3u8" }));
    const request = await liveRecordingRequest(plugin(resolveLiveStream), context, liveItem, undefined, { captureInput: "master" });
    expect(request?.kind).toBe("command");
    if (request?.kind !== "command") return;
    // One input, and no second map: there is nothing to mux across inputs any more.
    expect(request.args.filter((argument) => argument === "-i")).toHaveLength(1);
    expect(request.args).toContain(`{outputDir}/${LIVE_MASTER_PLAYLIST}`);
    expect(request.args).not.toContain("-map");
    // The master carries both absolute URLs and is written next to the capture.
    expect(request.supportFiles).toHaveLength(1);
    const master = request.supportFiles?.[0];
    expect(master?.name).toBe(LIVE_MASTER_PLAYLIST);
    expect(master?.content).toContain("#EXT-X-MEDIA:TYPE=AUDIO");
    expect(master?.content).toContain('URI="https://cdn.test/a.m3u8"');
    expect(master?.content).toContain("https://cdn.test/v.m3u8");
  });

  it("keeps the two-input capture when the preference says split", async () => {
    const resolveLiveStream = vi.fn(async () => ({ url: "https://cdn.test/v.m3u8", audioUrl: "https://cdn.test/a.m3u8" }));
    const request = await liveRecordingRequest(plugin(resolveLiveStream), context, liveItem, undefined, { captureInput: "split" });
    expect(request?.kind).toBe("command");
    if (request?.kind !== "command") return;
    expect(request.args.filter((argument) => argument === "-i")).toHaveLength(2);
    expect(request.supportFiles).toBeUndefined();
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
    expect(request!.args).toEqual(expect.arrayContaining(["-f", "segment", "{outputDir}/capture_part%03d.ts"]));
  });

  it("records through the rewrite hook when a provider cannot be played directly", async () => {
    // An obfuscated playlist is parsed by ffmpeg exactly as written, so it fetches decoys and
    // records an advert. The server's HLS proxy de-obfuscates it, and this hook is what points
    // ffmpeg at the proxy instead of at the CDN.
    const resolveLiveStream = vi.fn(async () => ({ url: "https://cdn.test/a.m3u8", headers: { Referer: "https://site.test/" }, playlistDecodeKey: "secret" }));
    const rewrite = vi.fn((stream: { url: string }) => (stream.url.startsWith("https://cdn.test/") ? "http://127.0.0.1:3210/api/live-cams/proxy/token.m3u8" : undefined));
    const request = await liveRecordingRequest(plugin(resolveLiveStream), context, liveItem, rewrite);
    expect(rewrite).toHaveBeenCalledOnce();
    expect(request!.args).toEqual(expect.arrayContaining(["-i", "http://127.0.0.1:3210/api/live-cams/proxy/token.m3u8"]));
    // The proxy replays the provider's headers itself, so none are forwarded alongside it.
    expect(request!.args).not.toEqual(expect.arrayContaining(["-headers"]));
  });

  it("keeps the raw stream and its headers when no rewrite hook applies", async () => {
    // Existing providers must be untouched: only a plugin that sets playlistDecodeKey opts in.
    const resolveLiveStream = vi.fn(async () => ({ url: "https://cdn.test/a.m3u8" }));
    const rewrite = vi.fn((stream: { playlistDecodeKey?: string }) => stream.playlistDecodeKey ? "http://127.0.0.1:3210/proxied.m3u8" : undefined);
    const request = await liveRecordingRequest(plugin(resolveLiveStream), context, liveItem, rewrite);
    expect(request!.args).toEqual(expect.arrayContaining(["-i", "https://cdn.test/a.m3u8"]));
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

  it("hands the plugin a room name instead of the display title", async () => {
    // A capture item carries no identity key; `liveRoom` names the room instead. Titled rooms are
    // the norm ("Anais Bloom ( Anna)"), and a plugin that keys its lookup on this field refuses to
    // resolve the broadcast when it is handed one — the recording then drops to a path that cannot
    // record that provider at all.
    const resolveLiveStream = vi.fn(async (_context: unknown, cam: { username?: string; pageUrl?: string }) => ({ url: "https://cdn.test/a.m3u8" }));
    await liveRecordingRequest(plugin(resolveLiveStream), context, {
      ...liveItem, identityKey: undefined, title: "Anais Bloom ( Anna)",
      metadata: { live: true, liveRoom: "anais_bloom" },
    });
    expect(resolveLiveStream.mock.calls[0]![1]).toMatchObject({ username: "anais_bloom", pageUrl: "https://chaturbate.com/alice" });
  });

  it("still prefers an identity key to the room key", async () => {
    const resolveLiveStream = vi.fn(async (_context: unknown, cam: { username?: string }) => ({ url: "https://cdn.test/a.m3u8" }));
    await liveRecordingRequest(plugin(resolveLiveStream), context, { ...liveItem, metadata: { live: true, liveRoom: "someone_else" } });
    expect(resolveLiveStream.mock.calls[0]![1]).toMatchObject({ username: "chaturbate:alice:1" });
  });

  it("recognises a live broadcast so the sync path can refuse to queue it", () => {
    expect(isLiveCandidate(liveItem)).toBe(true);
    expect(isLiveCandidate({ externalId: "clip", mediaType: "video", metadata: {} })).toBe(false);
    expect(isLiveCandidate({ externalId: "clip", mediaType: "video" })).toBe(false);
  });
});

describe("direct capture input choice", () => {
  const dual = { url: "https://cdn.test/v.m3u8", audioUrl: "https://cdn.test/a.m3u8" };
  const muxed = { url: "https://cdn.test/a.m3u8" };

  it("only leaves split when asked for a master", () => {
    expect(chooseDirectCaptureInput(dual, "split")).toBe("split");
    expect(chooseDirectCaptureInput(dual, undefined)).toBe("split");
    expect(chooseDirectCaptureInput(dual, "nonsense")).toBe("split");
    expect(chooseDirectCaptureInput(dual, "master")).toBe("master");
    expect(chooseDirectCaptureInput(dual, "auto")).toBe("master");
  });

  it("stays on split for a stream with no separate audio rendition", () => {
    // Nothing to align, so a master would only add a file and an indirection.
    expect(chooseDirectCaptureInput(muxed, "master")).toBe("split");
  });

  it("builds a master that names both renditions", () => {
    expect(liveMasterPlaylist(dual)).toBe([
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="https://cdn.test/a.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO="audio"',
      "https://cdn.test/v.m3u8",
      "",
    ].join("\n"));
    expect(liveMasterPlaylist(muxed)).toBeUndefined();
  });

  it("lets the deployment override beat the stored setting", () => {
    expect(captureInputPreference("split", "master")).toBe("master");
    expect(captureInputPreference("master", "split")).toBe("split");
    // An unset or unparsable override leaves the setting in charge...
    expect(captureInputPreference("master", undefined)).toBe("master");
    expect(captureInputPreference("master", "bogus")).toBe("master");
    // ...and an install that never chose gets the historical behaviour.
    expect(captureInputPreference(undefined, undefined)).toBe("split");
  });
});
