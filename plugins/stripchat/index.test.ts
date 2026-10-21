import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
import { listStripchatMedia, resolveStripchatDirect, resolveStripchatDownload, setStripchatFavorite, stripchatFollowedSnapshot, stripchatPublicPlaybackKey } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function stripchatSession(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-stripchat-test-"));
  temporaryDirectories.push(directory);
  const destination = path.join(directory, "cookies.txt");
  fs.writeFileSync(destination, "# Netscape HTTP Cookie File\n.stripchat.com\tTRUE\t/\tTRUE\t0\tsessionId\ttest-session\n");
  return destination;
}

function accountPage(): string {
  return `<script>window.__PRELOADED_STATE__ = ${JSON.stringify({ userSession: { currentUser: { id: 77, username: "viewer" } }, config: { releaseVersion: "12.3.4" } })};</script>`;
}

function modernAccountPage(): string {
  return `<script>window.PAGE_CONFIG = ${JSON.stringify({ releaseVersion: "12.3.4" })};</script>`;
}

/**
 * The page Stripchat's static frontend pool serves instead of the SSR room: no state payload, but
 * its loader script mentions the identifier by name. Copying that detail matters -- a fixture
 * without it lets a substring check pass and hides exactly the bug this guards.
 */
const STATIC_SHELL_PAGE = '<!doctype html><html><head><!--CSP--><script>(()=>{if(!("__PRELOADED_STATE__" in window)){document.body.className="loader"}})()</script></head><body></body></html>';

function pageState() {
  return `<script>window.__PRELOADED_STATE__ = ${JSON.stringify({
    viewCam: { model: { id: 42, username: "Alice", isLive: true, isOnline: true } },
    configV3: {
      initialCommon: { hlsStreamHost: "doppiocdn.media" },
      static: { featureSettings: {
        hlsFallback: { fallbackDomains: ["doppiocdn.media"] },
        MMPExternalUnitedSourceOrigin: "https://mmp.doppiocdn.com/player/mmp",
      } },
    },
    featuresConfig: { features: { playerModuleExternalLoading: { mmpVersion: "v2.12.0" } } },
  })};</script>`;
}

function context(variant: string) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v2.12.0/main.js")) return new Response('function airplay(url){url.searchParams.set("pkey","PublicKey123456")}');
    if (url.includes("/master/")) return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://media-hls.doppiocdn.media/live/42.m3u8?pkey=PublicKey123456\n`, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
    return new Response(variant, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  });
  return {
    config: {}, fetch, log: vi.fn(),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: pageState(), stderr: "" })),
  };
}

describe("Stripchat direct live playback", () => {
  it("detects a live configured source from browser state without invoking yt-dlp", async () => {
    const mock = context("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:123\n");
    await expect(listStripchatMedia(mock, {
      id: "source-1", externalId: "Alice", performerId: "person-1", profileUrl: "https://stripchat.com/Alice", domain: "stripchat.com",
    })).resolves.toEqual([expect.objectContaining({
      externalId: "stripchat:alice:live", pageUrl: "https://stripchat.com/Alice", filename: "Alice-live.mp4", metadata: expect.objectContaining({ live: true }),
    })]);
    expect(mock.runCommand).toHaveBeenCalledTimes(1);
    expect(mock.runCommand).toHaveBeenCalledWith("easyx-browser-fetch", ["https://stripchat.com/Alice"], expect.any(Object));
  });

  it.each(["private", "groupShow", "idle", "off"])("does not queue non-public %s rooms", async (status) => {
    const mock = context("");
    mock.runCommand.mockResolvedValue({ exitCode: 0, stderr: "", stdout: pageState().replace('"isLive":true', '"status":"' + status + '","isLive":true') });
    expect(await listStripchatMedia(mock, { id: "s", externalId: "Alice", performerId: "p", profileUrl: "https://stripchat.com/Alice", domain: "stripchat.com" })).toEqual([]);
  });

  it("extracts the public playback key from the current player module", () => {
    expect(stripchatPublicPlaybackKey('url.searchParams.set("pkey","B0p93vi8Uj6AYyZb")')).toBe("B0p93vi8Uj6AYyZb");
    expect(stripchatPublicPlaybackKey("no playback key here")).toBeUndefined();
  });

  it("adds the player key and accepts only a real live media playlist", async () => {
    const mock = context("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:123\n#EXTINF:2\nsegment.mp4\n");
    await expect(resolveStripchatDirect(mock, "https://stripchat.com/Alice")).resolves.toEqual({
      url: "https://edge-hls.doppiocdn.media/hls/42/master/42_auto.m3u8?pkey=PublicKey123456",
      headers: { referer: "https://stripchat.com/", origin: "https://stripchat.com" },
      contentType: "application/vnd.apple.mpegurl",
    });
    expect(mock.fetch).toHaveBeenCalledTimes(3);
  });

  it("retries the static shell instead of reporting a live room offline", async () => {
    const mock = context("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:123\n#EXTINF:2\nsegment.mp4\n");
    // Which backend answers is decided per request, so the shell can land on a room that is live
    // right now -- measured on production for a room whose state was `isLive: true`.
    let pageRequests = 0;
    mock.runCommand.mockImplementation(async () => {
      pageRequests += 1;
      return { exitCode: 0, stderr: "", stdout: pageRequests === 1 ? STATIC_SHELL_PAGE : pageState() };
    });
    await expect(resolveStripchatDirect(mock, "https://stripchat.com/Alice")).resolves.toMatchObject({ contentType: "application/vnd.apple.mpegurl" });
    // One retry is all it takes: the shell was rejected structurally, not read as "no live room".
    expect(pageRequests).toBe(2);
  });

  it("keeps a live room visible when its first profile page is the static shell", async () => {
    const mock = context("");
    let pageRequests = 0;
    mock.runCommand.mockImplementation(async () => {
      pageRequests += 1;
      return { exitCode: 0, stderr: "", stdout: pageRequests === 1 ? STATIC_SHELL_PAGE : pageState() };
    });
    // The liveness answer is just "no cams" if the shell is read as a real page, and the room then
    // hides for the whole offline window. Nothing else retries this path.
    await expect(listStripchatMedia(mock, {
      id: "s", externalId: "Alice", performerId: "p", profileUrl: "https://stripchat.com/Alice", domain: "stripchat.com",
    })).resolves.toEqual([expect.objectContaining({ externalId: "stripchat:alice:live" })]);
    expect(pageRequests).toBe(2);
  });

  it("does not retry when the room page itself says the room is offline", async () => {
    const mock = context("");
    mock.runCommand.mockResolvedValue({
      exitCode: 0, stderr: "",
      stdout: pageState().replace('"isLive":true', '"isLive":false').replace('"isOnline":true', '"isOnline":false'),
    });
    // The preloaded state came through, so the answer is about the room, not about the fetch.
    // Asking again would only spend another full fetch to reach the same verdict.
    await expect(resolveStripchatDirect(mock, "https://stripchat.com/Alice")).rejects.toThrow("The public room did not expose an HLS host");
    expect(mock.runCommand).toHaveBeenCalledTimes(1);
  });

  it("reports a page that never arrives as transient, not as a confirmed offline room", async () => {
    const mock = context("");
    mock.runCommand.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "<!doctype html><html><head><!--CSP--></head></html>" });
    const error = await resolveStripchatDirect(mock, "https://stripchat.com/Alice").then(() => undefined, (failure: Error) => failure);
    expect(error?.message).toContain("static page shell");
    // The wording has to stay clear of server/offline-error.ts, or this failure parks the room on
    // the hour-long cooldown that is meant for a room that is genuinely off.
    expect(/did not expose an hls host|no public .*hls host returned a live manifest/i.test(error?.message ?? "")).toBe(false);
    expect(mock.runCommand).toHaveBeenCalledTimes(3);
  });

  it("rejects Stripchat's finite intro advertisement playlist", async () => {
    const mock = context("#EXTM3U\n#EXT-X-MOUFLON-ADVERT\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n");
    await expect(resolveStripchatDirect(mock, "https://stripchat.com/Alice")).rejects.toThrow("No public Stripchat HLS host returned a live manifest");
  });

  it("records the validated live media playlist directly instead of invoking yt-dlp", async () => {
    const mock = context("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:123\n#EXTINF:2\nsegment.mp4\n");
    await expect(resolveStripchatDownload(mock, {
      externalId: "stripchat:alice:session", pageUrl: "https://stripchat.com/Alice", mediaType: "video", filename: "alice.mp4",
    })).resolves.toEqual({
      kind: "command", command: process.execPath, requireSuccessfulExit: true, filename: "alice.mp4",
      args: expect.arrayContaining([
        "-e", "https://media-hls.doppiocdn.media/live/42.m3u8?pkey=PublicKey123456", "{output}",
      ]),
    });
    expect(mock.runCommand).toHaveBeenCalledWith("easyx-browser-fetch", ["https://stripchat.com/Alice"], expect.any(Object));
  });
});

describe("Stripchat account favorites", () => {
  it("resolves only the requested creator even when the account follows thousands of models", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(accountPage()))
      .mockResolvedValueOnce(Response.json({ modelIds: Array.from({ length: 4000 }, (_, i) => i + 1) }))
      .mockResolvedValueOnce(Response.json({ model: { id: 5001, username: "Bob" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ modelIds: [5001] }));
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand: vi.fn() } as unknown as PluginContext;
    await expect(setStripchatFavorite(mock, { id: "bob", username: "Bob", pageUrl: "https://stripchat.com/Bob" }, true)).resolves.toEqual({ synchronized: true });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.map(([url]) => String(url)).some((url) => url.includes("/models/list"))).toBe(false);
  });
  it("imports the authenticated online and offline favorite lists", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(modernAccountPage()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ initialDynamic: { user: { id: 77, username: "viewer" } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [11, 12] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [
        { id: 11, username: "Alice", status: "public", viewersCount: 42 },
        { id: 12, username: "Bob", status: "offline", previewUrl: "/bob.jpg" },
      ] })));
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand: vi.fn() } as unknown as PluginContext;

    await expect(stripchatFollowedSnapshot(mock)).resolves.toEqual({
      authoritative: true,
      cams: [
        expect.objectContaining({ username: "Alice", online: true, viewers: 42 }),
        expect.objectContaining({ username: "Bob", online: false, viewers: 0 }),
      ],
    });
    expect(fetch.mock.calls[1][0].toString()).toContain("/api/front/v3/config/initial-dynamic");
    expect(fetch.mock.calls[2][0].toString()).toContain("/api/front/users/77/favorites");
    expect(fetch.mock.calls[3][0].toString()).toContain("/api/front/models/list?modelIds=11%2C12");
  });

  it("mirrors a follow to Stripchat and verifies it in the remote favorite lists", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(accountPage()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { user: { id: 22, username: "Bob" } } })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [22] })));
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand: vi.fn() } as unknown as PluginContext;

    await expect(setStripchatFavorite(mock, {
      id: "bob", username: "Bob", pageUrl: "https://stripchat.com/Bob",
    }, true)).resolves.toEqual({ synchronized: true });
    expect(fetch.mock.calls[3][0].toString()).toContain("/api/front/users/77/favorites/22");
    expect(fetch.mock.calls[3][1]).toEqual(expect.objectContaining({ method: "PUT" }));
  });

  it("uses Stripchat's signed browser action when the HTTP endpoint requires its anti-noise payload", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(accountPage()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [] })))
      .mockResolvedValueOnce(new Response("contract required", { status: 418 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [22] })));
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ success: true, favorite: true, modelId: 22 }), stderr: "" }));
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand } as unknown as PluginContext;

    await expect(setStripchatFavorite(mock, {
      id: "bob", username: "Bob", pageUrl: "https://stripchat.com/Bob",
    }, true)).resolves.toEqual({ synchronized: true });
    expect(runCommand).toHaveBeenCalledWith("easyx-browser-fetch", [
      "--stripchat-favorite", "https://stripchat.com/Bob", expect.stringContaining("cookies.txt"), "0", "follow",
    ], expect.objectContaining({ timeoutMs: 60_000 }));
  });

  it("does not repeat a Stripchat follow that is already active", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(accountPage()))
      .mockResolvedValueOnce(new Response(JSON.stringify({ modelIds: [22] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ id: 22, username: "Bob", status: "offline" }] })));
    const runCommand = vi.fn();
    const mock = { config: { cookiesFile: stripchatSession() }, fetch, log: vi.fn(), runCommand } as unknown as PluginContext;

    await expect(setStripchatFavorite(mock, {
      id: "bob", username: "Bob", pageUrl: "https://stripchat.com/Bob",
    }, true)).resolves.toEqual({ synchronized: true });
    expect(runCommand).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
