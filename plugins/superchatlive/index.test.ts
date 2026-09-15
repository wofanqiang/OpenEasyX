import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
import superchatPlugin from "./index.js";
import {
  listSuperchatMedia, normalizedGender, primaryTagFor, resetSuperchatCaches, resolveSuperchatDownload,
  resolveSuperchatStream, roomUrl, setSuperchatFavorite, superchatFavoriteCam, superchatFollowedSnapshot,
  superchatLiveCam, superchatPage, usernameFromRoomUrl,
} from "./index.js";
import {
  DEFAULT_HLS_TEMPLATE, applyMouflonChallenge, buildSuperchatHlsUrl, coerceMouflonPlaylist, hlsHostFromPlaylist,
  isLivePlaylist, isMasterPlaylist, isMouflonObfuscated, mouflonSegmentUrls, parseMouflonChallenge,
  playlistUrls, superchatStreamConfig,
} from "./streams.js";
import { MOUFLON_KEYMAP } from "../../packages/hls-mouflon.js";

beforeEach(() => resetSuperchatCaches());

function context(fetch: ReturnType<typeof vi.fn>, config: Record<string, unknown> = {}): PluginContext {
  return { config, fetch, log: vi.fn(), runCommand: vi.fn() } as unknown as PluginContext;
}

function room(overrides: Record<string, unknown> = {}) {
  return {
    id: 156104630, username: "OSHUN_", status: "public", isLive: true, isOnline: true,
    broadcastGender: "female", genderGroup: "F", gender: "female", country: "co",
    viewersCount: 325, isHd: true, isVr: true, age: 27,
    previewUrlThumbSmall: "https://static-proxy.strpst.com/previews/c/e/5/ce5-thumb-small",
    hlsPlaylist: "https://edge-hls.doppiocdn.media/hls/156104630/master/156104630_240p.m3u8",
    streamName: "",
    ...overrides,
  };
}

/**
 * Catalogue samples default to the VR tag, because `superchatPage` serves a VR-only catalogue
 * now — a room without it never reaches a page. Pass an explicit list to model a room the API
 * does not mark as VR.
 */
function cam(username: string, viewers: number, tags: string[] = ["vr"]) {
  return { id: username.toLowerCase(), username, pageUrl: roomUrl(username), viewers, tags };
}

const ADVERT = "#EXTM3U\n#EXT-X-MOUFLON-ADVERT\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-ENDLIST\n";
/** A real media playlist as the CDN serves it: the addresses are deliberately wrong. */
const OBFUSCATED_LIVE = [
  "#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-MOUFLON:PSCH:v2:1Dzcc6OjP73LKbtI",
  "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:42",
  '#EXT-X-MAP:URI="https://media-hls.doppiocdn.media/b-hls-21/1/1_init.mp4"',
  "#EXTINF:2.000",
  "#EXT-X-MOUFLON:URI:https://media-hls.doppiocdn.media/b-hls-21/1/1_42_AbC_part0.mp4",
  '#EXT-X-PART:DURATION=0.500,URI="https://media-hls.doppiocdn.media/b-hls-21/media.mp4"',
  "#EXT-X-MOUFLON:URI:https://media-hls.doppiocdn.media/b-hls-21/1/1_42_AbC.mp4",
  "https://media-hls.doppiocdn.media/b-hls-21/media.mp4",
].join("\n");

const MEDIA_OK = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:2,\nchunk.m4s\n";

describe("SuperChat room mapping", () => {
  it("maps a live public room and keeps its VR marker", () => {
    const live = superchatLiveCam(room());
    expect(live).toEqual(expect.objectContaining({
      id: "oshun_", username: "OSHUN_", pageUrl: "https://vr.superchat.live/cam/OSHUN_", viewers: 325,
      gender: "female", age: 27, title: "OSHUN_",
      thumbnailUrl: "https://static-proxy.strpst.com/previews/c/e/5/ce5-thumb-small",
    }));
    expect(live?.tags).toEqual(expect.arrayContaining(["female", "co", "hd", "vr"]));
  });

  it("refuses anything that is not a free public show", () => {
    expect(superchatLiveCam(room({ status: "private" }))).toBeUndefined();
    expect(superchatLiveCam(room({ status: "group" }))).toBeUndefined();
    expect(superchatLiveCam(room({ status: "offline" }))).toBeUndefined();
    expect(superchatLiveCam(room({ username: "not a room name" }))).toBeUndefined();
    expect(superchatLiveCam(null)).toBeUndefined();
  });

  it("keeps an offline room for the favourites list, with no viewers", () => {
    expect(superchatFavoriteCam(room({ status: "offline", isLive: false }))).toEqual(
      expect.objectContaining({ username: "OSHUN_", online: false, viewers: 0 }));
    expect(superchatFavoriteCam(room())).toEqual(expect.objectContaining({ online: true, viewers: 325 }));
  });

  it("reads a room name back out of a page URL", () => {
    expect(usernameFromRoomUrl("https://vr.superchat.live/cam/OSHUN_")).toBe("OSHUN_");
    expect(usernameFromRoomUrl(undefined)).toBeUndefined();
  });
});

describe("SuperChat gender vocabulary", () => {
  it("sends only the primaryTag values the API accepts", () => {
    // `primaryTag=female` is rejected with HTTP 400; the catalogue uses these words instead.
    expect(primaryTagFor("female")).toBe("girls");
    expect(primaryTagFor("male")).toBe("men");
    expect(primaryTagFor("couple")).toBe("couples");
    expect(primaryTagFor("trans")).toBe("trans");
    expect(primaryTagFor(undefined)).toBe("girls");
  });

  it("normalizes the provider's own gender words", () => {
    expect(normalizedGender("tranny")).toBe("trans");
    expect(normalizedGender("group")).toBe("couple");
    expect(normalizedGender("maleFemale")).toBe("couple");
    expect(normalizedGender("female")).toBe("female");
  });
});

describe("SuperChat catalogue paging", () => {
  it("serves a VR-only catalogue and drops rooms without the tag", () => {
    const cams = [cam("oshun_", 10), cam("plain_room", 90, []), { ...cam("hd_only", 50), tags: ["hd"] }];
    const page = superchatPage(cams, { page: 1, pageSize: 10 });
    expect(page.cams.map((item) => item.username)).toEqual(["oshun_"]);
    expect(page.total).toBe(1);
    // `oshun_` carries no "vr" in its name, so a hit here can only come from its tag.
    expect(superchatPage(cams, { page: 1, pageSize: 10, search: "vr" }).cams.map((item) => item.username)).toEqual(["oshun_"]);
  });

  it("ranks by viewers and slices pages locally", () => {
    const cams = [cam("a", 10), cam("b", 300), cam("c", 50)];
    const first = superchatPage(cams, { page: 1, pageSize: 2 });
    expect(first.cams.map((item) => item.username)).toEqual(["b", "c"]);
    expect(first.total).toBe(3);
    expect(first.pages).toBe(2);
    expect(superchatPage(cams, { page: 2, pageSize: 2 }).cams.map((item) => item.username)).toEqual(["a"]);
  });

  it("filters a snapshot by gender and search term", () => {
    const cams = [
      { ...cam("alice", 5), gender: "female" },
      { ...cam("bob", 9), gender: "male" },
    ];
    expect(superchatPage(cams, { page: 1, pageSize: 10, gender: "male" }).cams.map((item) => item.username)).toEqual(["bob"]);
    expect(superchatPage(cams, { page: 1, pageSize: 10, search: "alice" }).cams.map((item) => item.username)).toEqual(["alice"]);
  });

  it("collapses a room that appears twice, keeping the busier copy", () => {
    const page = superchatPage([cam("dup", 4), cam("dup", 90)], { page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.cams[0].viewers).toBe(90);
  });
});

describe("SuperChat stream configuration", () => {
  it("reads the template and the host order out of the live configuration", () => {
    const config = superchatStreamConfig({
      initial: {
        common: {
          hlsStreamUrlTemplate: "https://edge-hls.{cdnHost}/hls/{streamName}/master/{streamName}{suffix}.m3u8",
          hlsStreamHost: "doppiocdn.org", defaultHlsStreamHost: "doppiocdn.media",
          hlsStreamHosts: { A: "doppiocdn.com", C: "doppiocdn.media", E: "doppiocdn.org" },
        },
      },
    });
    expect(config.template).toBe("https://edge-hls.{cdnHost}/hls/{streamName}/master/{streamName}{suffix}.m3u8");
    expect(config.hosts[0]).toBe("doppiocdn.media");
    expect(config.hosts).toContain("doppiocdn.org");
    expect(new Set(config.hosts).size).toBe(config.hosts.length);
  });

  it("falls back to the probed template when the configuration drifts", () => {
    const config = superchatStreamConfig({});
    expect(config.template).toBe(DEFAULT_HLS_TEMPLATE);
    expect(config.hosts.length).toBeGreaterThan(0);
    expect(config.hosts).toContain("doppiocdn.media");
  });

  it("fills every placeholder in the server template", () => {
    expect(buildSuperchatHlsUrl(DEFAULT_HLS_TEMPLATE, "doppiocdn.media", "156104630", "_auto"))
      .toBe("https://edge-hls.doppiocdn.media/hls/156104630/master/156104630_auto.m3u8");
  });

  it("reads the CDN host out of a room playlist", () => {
    expect(hlsHostFromPlaylist("https://edge-hls.doppiocdn.media/hls/156104630/master/156104630_240p.m3u8")).toBe("doppiocdn.media");
    expect(hlsHostFromPlaylist("https://example.com/x.m3u8")).toBeUndefined();
    expect(hlsHostFromPlaylist(undefined)).toBeUndefined();
  });

  it("lists only playlist references from a master", () => {
    const master = `#EXTM3U\n#EXT-X-MOUFLON:PSCH:v2:abc\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://media-hls.doppiocdn.media/b-hls-21/1/1.m3u8?x=1\n#EXT-X-STREAM-INF:BANDWIDTH=2\n/relative.m3u8\n`;
    expect(playlistUrls(master, "https://edge-hls.doppiocdn.media/hls/1/master/1_auto.m3u8")).toEqual([
      "https://media-hls.doppiocdn.media/b-hls-21/1/1.m3u8?x=1",
      "https://edge-hls.doppiocdn.media/relative.m3u8",
    ]);
  });

  it("accepts only a live media playlist and rejects the advert reel", () => {
    expect(isLivePlaylist(MEDIA_OK)).toBe(true);
    expect(isLivePlaylist("#EXTM3U\n#EXT-X-PART:URI=\"a.m4s\"\n")).toBe(true);
    expect(isLivePlaylist(ADVERT)).toBe(false);
    expect(isMasterPlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx.m3u8\n`)).toBe(true);
  });
});

describe("SuperChat MOUFLON v2 playlist handling", () => {
  it("reads the challenge the CDN demands", () => {
    expect(parseMouflonChallenge("#EXTM3U\n#EXT-X-MOUFLON:PSCH:v2:1Dzcc6OjP73LKbtI\n")).toEqual({
      scheme: "v2", key: "1Dzcc6OjP73LKbtI",
    });
    expect(parseMouflonChallenge(OBFUSCATED_LIVE)).toEqual({ scheme: "v2", key: "1Dzcc6OjP73LKbtI" });
    expect(parseMouflonChallenge("#EXTM3U\n")).toBeUndefined();
  });

  it("echoes the challenge back without dropping the parameters already present", () => {
    expect(applyMouflonChallenge(
      "https://media-hls.doppiocdn.media/b-hls-31/1/1_1440p60.m3u8?playlistType=lowLatency",
      { scheme: "v2", key: "abc123" },
    )).toBe("https://media-hls.doppiocdn.media/b-hls-31/1/1_1440p60.m3u8?playlistType=lowLatency&psch=v2&pkey=abc123");
  });

  it("replaces the decoy addresses with the ones carried on the MOUFLON line", () => {
    const plain = coerceMouflonPlaylist(OBFUSCATED_LIVE);
    expect(plain).toContain("URI=\"https://media-hls.doppiocdn.media/b-hls-21/1/1_42_AbC_part0.mp4\"");
    expect(plain.trimEnd().endsWith("https://media-hls.doppiocdn.media/b-hls-21/1/1_42_AbC.mp4")).toBe(true);
    // The decoy must be gone: recording it would capture the advert reel.
    expect(plain.match(/\/media\.mp4/g) ?? []).toHaveLength(0);
  });

  it("exposes the real segment addresses and flags an obfuscated playlist", () => {
    expect(isMouflonObfuscated(OBFUSCATED_LIVE)).toBe(true);
    expect(isMouflonObfuscated(MEDIA_OK)).toBe(false);
    expect(mouflonSegmentUrls(OBFUSCATED_LIVE)).toEqual([
      "https://media-hls.doppiocdn.media/b-hls-21/1/1_42_AbC_part0.mp4",
      "https://media-hls.doppiocdn.media/b-hls-21/1/1_42_AbC.mp4",
    ]);
    expect(mouflonSegmentUrls("https://media-hls.doppiocdn.media/b-hls-21/media.mp4")).toEqual([]);
  });
});

describe("SuperChat stream resolution", () => {
  const MASTER = [
    "#EXTM3U", "#EXT-X-MOUFLON:PSCH:v2:1Dzcc6OjP73LKbtI", "#EXT-X-MOUFLON:PSCH:v2:7uUnbD0jMCB9GH32",
    '#EXT-X-STREAM-INF:BANDWIDTH=4566425,RESOLUTION=1920x1080,NAME="source"',
    "https://media-hls.doppiocdn.media/b-hls-21/156104630/156104630.m3u8?playlistType=standard",
    '#EXT-X-STREAM-INF:BANDWIDTH=2610000,RESOLUTION=1280x720,NAME="720p"',
    "https://media-hls.doppiocdn.media/b-hls-21/156104630/156104630_720p.m3u8?playlistType=standard",
  ].join("\n");

  function playerFetch(options: { isVr?: boolean; master?: string; variantBody?: string } = {}) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/users/user-ids/")) return Response.json({ id: 156104630 });
      if (url.includes("/v2/models/")) {
        return Response.json({
          streamName: "156104630",
          model: { status: "public", isLive: true, name: "OSHUN_", viewersCount: 325, isVr: options.isVr === true },
          cam: { modelToken: "" },
        });
      }
      if (url.includes("/v3/config/initial")) {
        return Response.json({ initial: { common: { hlsStreamUrlTemplate: DEFAULT_HLS_TEMPLATE, defaultHlsStreamHost: "doppiocdn.media" } } });
      }
      if (url.includes("/master/")) return new Response(options.master ?? MASTER);
      return new Response(options.variantBody ?? OBFUSCATED_LIVE);
    });
  }

  it("echoes the challenge and returns the challenged variant that is really on air", async () => {
    const fetch = playerFetch();
    const stream = await resolveSuperchatStream(context(fetch), { id: "oshun_", username: "OSHUN_", pageUrl: roomUrl("OSHUN_") });
    expect(stream).toEqual({
      url: "https://media-hls.doppiocdn.media/b-hls-21/156104630/156104630.m3u8?playlistType=standard&psch=v2&pkey=1Dzcc6OjP73LKbtI",
      headers: { referer: "https://vr.superchat.live/", origin: "https://vr.superchat.live" },
      contentType: "application/vnd.apple.mpegurl",
    });
    // The master request must carry the low-latency flag the VR feed is published under.
    const masterCall = fetch.mock.calls.map(([url]) => String(url)).find((url) => url.includes("/master/"));
    expect(masterCall).toContain("playlistType=lowLatency");
    // The variant request must carry the challenge, otherwise the CDN serves the advert reel.
    const variantCall = fetch.mock.calls.map(([url]) => String(url)).find((url) => url.includes("156104630.m3u8?"));
    expect(variantCall).toContain("psch=v2");
    expect(variantCall).toContain("pkey=1Dzcc6OjP73LKbtI");
  });

  it("prefers the VR stream name for a VR room", async () => {
    const fetch = playerFetch({ isVr: true });
    await resolveSuperchatStream(context(fetch), { id: "oshun_", username: "OSHUN_", pageUrl: roomUrl("OSHUN_") }).catch(() => undefined);
    const masterCalls = fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/master/"));
    expect(masterCalls[0]).toContain("/156104630_vr/master/");
  });

  it("skips a variant that only serves the advert reel", async () => {
    // First variant is the advert VOD; the second is genuinely live.
    const master = [
      "#EXTM3U", "#EXT-X-MOUFLON:PSCH:v2:abc",
      "#EXT-X-STREAM-INF:BANDWIDTH=1", "https://media-hls.doppiocdn.media/b-hls-21/1/advert.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2", "https://media-hls.doppiocdn.media/b-hls-21/1/live.m3u8",
    ].join("\n");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/users/user-ids/")) return Response.json({ id: 1 });
      if (url.includes("/v2/models/")) return Response.json({ streamName: "1", model: { status: "public", isLive: true }, cam: {} });
      if (url.includes("/v3/config/initial")) return Response.json({ initial: { common: { defaultHlsStreamHost: "doppiocdn.media" } } });
      if (url.includes("/master/")) return new Response(master);
      return new Response(url.includes("/live.m3u8") ? MEDIA_OK : ADVERT);
    });
    const stream = await resolveSuperchatStream(context(fetch), { id: "x", username: "X", pageUrl: roomUrl("X") });
    expect(stream.url).toContain("/live.m3u8");
    expect(stream.url).not.toContain("/advert.m3u8");
  });

  it("fails rather than silently recording the advert reel", async () => {
    const fetch = playerFetch({ variantBody: ADVERT });
    await expect(resolveSuperchatStream(context(fetch), { id: "x", username: "X", pageUrl: roomUrl("X") }))
      .rejects.toThrow("No public SuperChat HLS host returned a live manifest");
  });

  it("refuses a room that is not broadcasting a public show", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/users/user-ids/")) return Response.json({ id: 5 });
      return Response.json({ streamName: "5", model: { status: "private", isLive: true }, cam: { modelToken: "paid" } });
    });
    await expect(resolveSuperchatStream(context(fetch), { id: "x", username: "X", pageUrl: roomUrl("X") }))
      .rejects.toThrow("is not broadcasting a public show");
  });

  it("records the challenged playlist through ffmpeg's TS-first live capture", async () => {
    const fetch = playerFetch();
    const download = await resolveSuperchatDownload(context(fetch), {
      externalId: "superchat:oshun_:live", identityKey: "OSHUN_", pageUrl: roomUrl("OSHUN_"),
      mediaType: "video", filename: "oshun-live.mp4", metadata: { live: true },
    });
    expect(download).toEqual({
      kind: "command", command: "ffmpeg", filename: "oshun-live.mp4",
      args: expect.arrayContaining([
        "-i", "https://media-hls.doppiocdn.media/b-hls-21/156104630/156104630.m3u8?playlistType=standard&psch=v2&pkey=1Dzcc6OjP73LKbtI",
        "-c", "copy", "-f", "mpegts", "{outputDir}/capture.ts",
      ]),
    });
  });

  it("resolves the room from the page URL when the caller holds only a display title", async () => {
    // A recorder item can arrive with the room's display title in its username field. The page URL
    // is built from the room name by `roomUrl()`, so of the two it is the one worth trusting.
    const fetch = playerFetch();
    await resolveSuperchatStream(context(fetch), {
      id: "52358393", username: "Anais Bloom ( Anna)", pageUrl: roomUrl("Anais_Bloom"),
    });
    const lookup = fetch.mock.calls.map(([url]) => String(url)).find((url) => url.includes("/users/user-ids/"));
    expect(lookup).toContain("/Anais_Bloom");
    expect(lookup).not.toContain("Anais%20Bloom");
  });

  it("still refuses a name that is neither a room nor recoverable from the URL", async () => {
    const fetch = playerFetch();
    await expect(resolveSuperchatStream(context(fetch), {
      id: "x", username: "Anais Bloom ( Anna)", pageUrl: "https://vr.superchat.live/",
    })).rejects.toThrow("invalid room name");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to record a playlist that only the server proxy can decrypt", async () => {
    // A keymapped challenge is what yields a decryption key, so these addresses can only be
    // unwrapped while the server rewrites the playlist. Handed the raw playlist instead, ffmpeg
    // fetches the decoys it literally names and the capture dies on the stall timeout.
    const master = [
      "#EXTM3U", `#EXT-X-MOUFLON:PSCH:v2:${Object.keys(MOUFLON_KEYMAP)[0]}`,
      "#EXT-X-STREAM-INF:BANDWIDTH=4566425,RESOLUTION=1920x1080,NAME=\"source\"",
      "https://media-hls.doppiocdn.media/b-hls-21/156104630/156104630.m3u8?playlistType=standard",
    ].join("\n");
    await expect(resolveSuperchatDownload(context(playerFetch({ master })), {
      externalId: "superchat:oshun_:live", pageUrl: roomUrl("OSHUN_"), mediaType: "video",
      filename: "oshun-live.mp4", metadata: { live: true },
    })).rejects.toThrow("live capture path");
  });
});

describe("SuperChat media listing", () => {
  it("announces a live room and carries the room name as its identity key", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/users/user-ids/")) return Response.json({ id: 156104630 });
      return Response.json({ streamName: "156104630", model: { status: "public", isLive: true, name: "OSHUN_", viewersCount: 325 }, cam: {} });
    });
    await expect(listSuperchatMedia(context(fetch), {
      id: "s1", externalId: "OSHUN_", performerId: "p1", profileUrl: roomUrl("OSHUN_"), domain: "vr.superchat.live",
    })).resolves.toEqual([expect.objectContaining({
      externalId: "superchat:oshun_:live", identityKey: "OSHUN_", filename: "OSHUN_-live.mp4",
      metadata: expect.objectContaining({ live: true }),
    })]);
  });

  it("reports an offline room as no media instead of an error", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/users/user-ids/")) return Response.json({ id: 7 });
      return Response.json({ streamName: "7", model: { status: "offline", isLive: false }, cam: {} });
    });
    await expect(listSuperchatMedia(context(fetch), {
      id: "s1", externalId: "x", performerId: "p1", profileUrl: roomUrl("OfflineRoom"), domain: "vr.superchat.live",
    })).resolves.toEqual([]);
  });

  it("treats an unknown room as offline", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Not Found" }), { status: 404 }));
    await expect(listSuperchatMedia(context(fetch), {
      id: "s1", externalId: "x", performerId: "p1", profileUrl: roomUrl("Ghost"), domain: "vr.superchat.live",
    })).resolves.toEqual([]);
  });
});

describe("SuperChat favourites", () => {
  it("skips synchronization when no session is connected, without failing the page", async () => {
    await expect(superchatFollowedSnapshot(context(vi.fn()))).resolves.toEqual(expect.objectContaining({
      cams: [], authoritative: false, skippedReason: expect.stringContaining("Connect a SuperChat account"),
    }));
  });

  it("reports an unwritable favourite rather than claiming success", async () => {
    await expect(setSuperchatFavorite(context(vi.fn()), { id: "oshun_", username: "OSHUN_", pageUrl: roomUrl("OSHUN_") }, true))
      .resolves.toEqual({ synchronized: false });
  });

  it("degrades to a skipped snapshot when the stored session cannot be read", async () => {
    const session = context(vi.fn(), { cookiesFile: "no-such-file-in-this-test.txt" });
    await expect(superchatFollowedSnapshot(session)).resolves.toEqual(expect.objectContaining({
      cams: [], authoritative: false, skippedReason: expect.any(String),
    }));
  });
});

describe("SuperChat sweep budget", () => {
  it("stops the catalogue sweep at the budget the context carries", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const exclude = (JSON.parse(String(init?.body)) as { excludeModelIds: number[] }).excludeModelIds;
      const models = Array.from({ length: 60 }, (_, index) => room({ id: exclude.length + index + 1, username: `budget-${exclude.length + index + 1}` }));
      return new Response(JSON.stringify({ models }), { status: 200 });
    });
    const log = vi.fn();
    const context = { config: {}, fetch, log, runCommand: vi.fn(), budgetMs: 0 } as unknown as PluginContext;
    const page = await superchatPlugin.listLiveCams!(context, { page: 1, pageSize: 24 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.cams).toHaveLength(24);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("0ms budget"));
  });
});
