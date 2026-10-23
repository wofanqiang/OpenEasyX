import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../packages/plugin-sdk/index.js";
import { createLiveCamPlugin, genericLiveCandidate } from "./live-cam-plugin-factory.js";

function context(runCommand: PluginContext["runCommand"]): PluginContext {
  return { config: {}, fetch, runCommand, log: () => undefined };
}

describe("live cam plugin factory", () => {
  const plugin = createLiveCamPlugin({
    id: "test.live", name: "Test Live", prefix: "test", homepage: "https://live.test",
    description: "Test", sourceUrlPatterns: ["https://live.test/*"], cookieDomains: ["live.test"],
  });

  it("publishes the complete live plugin contract", () => {
    expect(plugin.manifest).toMatchObject({
      id: "test.live", capabilities: ["media-listing", "download-resolver", "live-cam"],
      polling: { mode: "live", defaultIntervalSeconds: 15, minimumIntervalSeconds: 10 },
      settings: [expect.objectContaining({ key: "cookiesFile", type: "session", cookieDomains: ["live.test"] })],
    });
    expect(plugin.resolveLiveStream).toBeTypeOf("function");
    expect(plugin.resolveDownload).toBeTypeOf("function");
  });

  it("creates a stable candidate for one active stream", () => {
    const first = genericLiveCandidate({ id: "alice", is_live: true, formats: [{ url: "https://cdn.test/alice/master.m3u8?token=one" }] }, "https://live.test/alice", "test");
    const refreshed = genericLiveCandidate({ id: "alice", is_live: true, formats: [{ url: "https://cdn.test/alice/master.m3u8?token=two" }] }, "https://live.test/alice", "test");
    expect(first).toMatchObject({ externalId: expect.stringMatching(/^test:alice:/), mediaType: "video", metadata: { live: true } });
    expect(refreshed?.externalId).toBe(first?.externalId);
    expect(genericLiveCandidate({ id: "alice", live_status: "not_live" }, "https://live.test/alice", "test")).toBeUndefined();
  });

  it("treats an offline extractor response as an empty scan", async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "ERROR: model is offline" }));
    await expect(plugin.listMedia!(context(runCommand), {
      id: "source", externalId: "alice", performerId: "performer", profileUrl: "https://live.test/alice", domain: "live.test",
    })).resolves.toEqual([]);
  });

  it("probes the room with a browser fingerprint", async () => {
    // CamSoda answers 403 to yt-dlp's default client; without this the probe reports the room as
    // broken on every polling interval instead of simply finding it offline.
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ id: "alice", is_live: false }), stderr: "" }));
    await plugin.listMedia!(context(runCommand), {
      id: "source", externalId: "alice", performerId: "performer", profileUrl: "https://live.test/alice", domain: "live.test",
    });
    expect(runCommand).toHaveBeenCalledWith("yt-dlp", expect.arrayContaining(["--impersonate", "chrome"]), expect.any(Object));
  });

  it("falls back to Chromium network capture when yt-dlp cannot resolve the live", async () => {
    const runCommand = vi.fn(async (command: string) => command === "yt-dlp"
      ? { exitCode: 1, stdout: "", stderr: "Unsupported URL" }
      : { exitCode: 0, stdout: JSON.stringify({ url: "https://cdn.test/live.m3u8", pageUrl: "https://live.test/alice", cookie: "sid=one" }), stderr: "" });
    const browserContext = { ...context(runCommand), config: { cookiesFile: "/data/sessions/live.txt" } };
    await expect(plugin.resolveLiveStream!(browserContext, {
      id: "alice", username: "alice", pageUrl: "https://live.test/alice",
    })).resolves.toMatchObject({ url: "https://cdn.test/live.m3u8", headers: { Cookie: "sid=one" } });
    expect(runCommand).toHaveBeenLastCalledWith("easyx-browser-fetch", ["--capture-media", "https://live.test/alice", "/data/sessions/live.txt"], expect.any(Object));
  });

  it("does not spend a Chromium render on a private show", async () => {
    // A private room has no public broadcast, so the browser fallback can only fail -- forty
    // seconds and a full page render later, once per polling interval. The error has to reach
    // the downloader's offline classifier instead, which backs the room off like an offline one.
    const runCommand = vi.fn(async (command: string) => command === "yt-dlp"
      ? { exitCode: 1, stdout: "", stderr: "ERROR: [Stripchat] creampussyy: Model is in a private show" }
      : { exitCode: 0, stdout: JSON.stringify({ url: "https://cdn.test/live.m3u8" }), stderr: "" });
    const browserContext = { ...context(runCommand), config: { cookiesFile: "/data/sessions/live.txt" } };
    await expect(plugin.resolveDownload!(browserContext, {
      externalId: "test:creampussyy:live", title: "creampussyy live", pageUrl: "https://live.test/creampussyy",
      mediaType: "video", metadata: { live: true },
    })).rejects.toThrow(/private show/i);
    expect(runCommand).not.toHaveBeenCalledWith("easyx-browser-fetch", expect.anything(), expect.anything());
  });

  it("explains when playback requires an account session", async () => {
    const sessionPlugin = createLiveCamPlugin({
      id: "test.session", name: "Session Live", prefix: "session", homepage: "https://session.test",
      description: "Test", sourceUrlPatterns: ["https://session.test/*"], cookieDomains: ["session.test"],
      sessionHelp: "Sign in with the integrated browser.",
      sessionRequiredForPlaybackMessage: "An account session is required for playback.",
    });
    const runCommand = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "No stream found" }));

    expect(sessionPlugin.manifest.settings?.[0]?.help).toBe("Sign in with the integrated browser.");
    await expect(sessionPlugin.resolveLiveStream!(context(runCommand), {
      id: "alice", username: "alice", pageUrl: "https://session.test/alice",
    })).rejects.toThrow("An account session is required for playback.");
  });

  // A CDN that gates on the TLS fingerprint answers 403 to ffmpeg for the very URL the resolver
  // just fetched. The plugin that knows this stamps the stream, and the recorder routes the
  // capture through the proxy, which fetches with a Chrome fingerprint.
  it("stamps a stream a fingerprint-gated provider resolved, and leaves others alone", async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ id: "alice", is_live: true, formats: [{ url: "https://cdn.test/alice/master.m3u8?token=one", vcodec: "h264", acodec: "aac" }] }), stderr: "" }));
    const gated = createLiveCamPlugin({
      id: "test.gated", name: "Gated Live", prefix: "gated", homepage: "https://gated.test",
      description: "Test", sourceUrlPatterns: ["https://gated.test/*"], cookieDomains: ["gated.test"],
      fingerprintGated: true,
    });

    const stamped = await gated.resolveLiveStream!(context(runCommand), { id: "alice", username: "alice", pageUrl: "https://gated.test/alice" });
    expect(stamped.requiresTlsFingerprint).toBe(true);

    const plain = await plugin.resolveLiveStream!(context(runCommand), { id: "alice", username: "alice", pageUrl: "https://live.test/alice" });
    expect(plain.requiresTlsFingerprint).toBeUndefined();
  });
});
