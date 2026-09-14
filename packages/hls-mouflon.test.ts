import { describe, expect, it } from "vitest";
import {
  MOUFLON_KEYMAP,
  coerceMouflonPlaylist,
  decodeMouflonAddress,
  decodeMouflonToken,
  isMouflonLivePlaylist,
  isMouflonObfuscated,
  isMasterPlaylist,
  mouflonDecryptKey,
  mouflonSegmentUrls,
  parseMouflonChallenges,
  selectMouflonChallenge,
} from "./hls-mouflon.js";

/**
 * Golden vectors lifted from a live room and confirmed against the CDN: every decoded address in
 * this table was fetched with HTTP 200 and returned a real fragmented MP4 (`ftyp`/`sidx` boxes).
 * They pin the reverse -> base64 -> XOR(SHA-256(key)) routine to observed behaviour, not to a
 * reading of the minified player.
 */
const VECTORS: Array<[encrypted: string, clear: string]> = [
  ["Ao5b8oKcwmYOOsIxLlofVy", "gFbIS9EhCnNf0nWm"],
  ["Qv9/c29MAps+NroUJhdD1w", "mAWYzYYTwQJQJgSp"],
  ["g+Iv93BwHzp/tn4cIsbfmw", "lvQmhIkT295mLsf7"],
];

const KEY = MOUFLON_KEYMAP["Ook7quaiNgiyuhai"]!;

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  "#EXT-X-MOUFLON:PSCH:v2:7uUnbD0jMCB9GH32",
  "#EXT-X-MOUFLON:PSCH:v2:Ook7quaiNgiyuhai",
  "#EXT-X-STREAM-INF:BANDWIDTH=8746496,RESOLUTION=2880x1440,NAME=\"1440p60\"",
  "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60.m3u8?playlistType=lowLatency",
].join("\n");

const MEDIA = [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  "#EXT-X-MOUFLON:PSCH:v2:Ook7quaiNgiyuhai",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MEDIA-SEQUENCE:5385",
  '#EXT-X-MAP:URI="https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_init_jTdPdxMGUO9mHHRQ.mp4"',
  "#EXT-X-MOUFLON:URI:https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_Ao5b8oKcwmYOOsIxLlofVy_1789400984_part0.mp4",
  '#EXT-X-PART:DURATION=0.500,URI="https://media-hls.doppiocdn.org/b-hls-31/media.mp4",INDEPENDENT=YES',
  "#EXTINF:2.000",
  "#EXT-X-MOUFLON:URI:https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_Ao5b8oKcwmYOOsIxLlofVy_1789400984.mp4",
  "https://media-hls.doppiocdn.org/b-hls-31/media.mp4",
  "#EXTINF:2.000",
  "#EXT-X-MOUFLON:URI:https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5386_Qv9/c29MAps+NroUJhdD1w_1789400986.mp4",
  "https://media-hls.doppiocdn.org/b-hls-31/media.mp4",
  "",
].join("\n");

describe("mouflon token decryption", () => {
  it("recovers every observed clear token", () => {
    for (const [encrypted, clear] of VECTORS) {
      expect(decodeMouflonToken(encrypted, KEY)).toBe(clear);
    }
  });

  it("needs the right key — a wrong one does not produce a clear token", () => {
    const wrong = decodeMouflonToken(VECTORS[0]![0], "not-the-key");
    expect(wrong).not.toBe(VECTORS[0]![1]);
    expect(/^[A-Za-z0-9]{8,32}$/.test(wrong)).toBe(false);
  });

  it("rewrites the encrypted token inside a segment address and leaves the rest alone", () => {
    const address = "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_Ao5b8oKcwmYOOsIxLlofVy_1789400984_part0.mp4";
    expect(decodeMouflonAddress(address, KEY))
      .toBe("https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_gFbIS9EhCnNf0nWm_1789400984_part0.mp4");
  });

  it("keeps a mid-path token (which contains a slash) intact", () => {
    const address = "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5386_Qv9/c29MAps+NroUJhdD1w_1789400986.mp4";
    expect(decodeMouflonAddress(address, KEY)).toBe(
      "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5386_mAWYzYYTwQJQJgSp_1789400986.mp4",
    );
  });

  it("leaves addresses without an encrypted token alone", () => {
    const init = "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_init_jTdPdxMGUO9mHHRQ.mp4";
    expect(decodeMouflonAddress(init, KEY)).toBe(init);
    expect(decodeMouflonAddress("https://example.test/plain.mp4", KEY)).toBe("https://example.test/plain.mp4");
  });

  it("falls back to the raw address when the key is wrong, instead of emitting garbage", () => {
    const address = "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_Ao5b8oKcwmYOOsIxLlofVy_1789400984_part0.mp4";
    expect(decodeMouflonAddress(address, "rotated-away-key")).toBe(address);
  });
});

describe("mouflon challenges", () => {
  it("parses every advertised pair in order", () => {
    const challenges = parseMouflonChallenges(MASTER);
    expect(challenges).toEqual([
      { scheme: "v2", key: "7uUnbD0jMCB9GH32" },
      { scheme: "v2", key: "Ook7quaiNgiyuhai" },
    ]);
  });

  it("selects the keymapped pair rather than the first one advertised", () => {
    expect(selectMouflonChallenge(MASTER)).toEqual({ scheme: "v2", key: "Ook7quaiNgiyuhai" });
  });

  it("exposes the decryption key only for keys the player trusts", () => {
    expect(mouflonDecryptKey({ scheme: "v2", key: "Ook7quaiNgiyuhai" })).toBe("EQueeGh2kaewa3ch");
    expect(mouflonDecryptKey({ scheme: "v2", key: "7uUnbD0jMCB9GH32" })).toBeUndefined();
  });

  it("still returns a challenge when nothing is keymapped, so the fetch can be attempted", () => {
    const strange = "#EXTM3U\n#EXT-X-MOUFLON:PSCH:v9:unknownkey\n";
    expect(selectMouflonChallenge(strange)).toEqual({ scheme: "v9", key: "unknownkey" });
    expect(selectMouflonChallenge("#EXTM3U\n")).toBeUndefined();
  });
});

describe("mouflon playlist coercion", () => {
  it("puts the real part address on the #EXT-X-PART line", () => {
    const coerced = coerceMouflonPlaylist(MEDIA, KEY);
    expect(coerced).toContain('URI="https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_gFbIS9EhCnNf0nWm_1789400984_part0.mp4"');
  });

  it("puts the real full-segment address on the bare URL line", () => {
    const coerced = coerceMouflonPlaylist(MEDIA, KEY);
    expect(coerced.split("\n")).toContain(
      "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_gFbIS9EhCnNf0nWm_1789400984.mp4",
    );
  });

  it("never leaves the decoy as a fetchable address", () => {
    const coerced = coerceMouflonPlaylist(MEDIA, KEY);
    expect(mouflonSegmentUrls(coerced, KEY).every((url) => !url.endsWith("/media.mp4"))).toBe(true);
  });

  it("keeps the initialisation segment untouched (it is not obfuscated)", () => {
    expect(coerceMouflonPlaylist(MEDIA, KEY)).toContain("156104630_vr_1440p60_h264_init_jTdPdxMGUO9mHHRQ.mp4");
  });

  it("returns the decrypted real addresses for the proxy to fetch", () => {
    expect(mouflonSegmentUrls(MEDIA, KEY)).toEqual([
      "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_gFbIS9EhCnNf0nWm_1789400984_part0.mp4",
      "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_gFbIS9EhCnNf0nWm_1789400984.mp4",
      "https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5386_mAWYzYYTwQJQJgSp_1789400986.mp4",
    ]);
  });

  it("substitutes the hint but never decrypts when no key is known", () => {
    const coerced = coerceMouflonPlaylist(MEDIA);
    // The decoy still gets replaced by the hint, which is all a rewriting proxy can do safely...
    expect(coerced).toContain('URI="https://media-hls.doppiocdn.org/b-hls-31/156104630_vr/156104630_vr_1440p60_h264_5385_Ao5b8oKcwmYOOsIxLlofVy_1789400984_part0.mp4"');
    // ...but the encrypted token must survive untouched, because a wrong key would make it worse.
    expect(coerced).toContain("_Ao5b8oKcwmYOOsIxLlofVy_");
    expect(coerced).not.toContain("gFbIS9EhCnNf0nWm");
  });

  it("does not mistake a master playlist for an obfuscated media playlist", () => {
    expect(isMouflonObfuscated(MASTER)).toBe(false);
    expect(isMasterPlaylist(MASTER)).toBe(true);
    expect(coerceMouflonPlaylist(MASTER, KEY)).toBe(MASTER);
  });
});

describe("mouflon liveness checks", () => {
  it("accepts a real media playlist", () => {
    expect(isMouflonLivePlaylist(MEDIA)).toBe(true);
  });

  it("rejects the finite advert reel the CDN serves without a challenge", () => {
    expect(isMouflonLivePlaylist("#EXTM3U\n#EXT-X-MOUFLON-ADVERT\n#EXT-X-MEDIA-SEQUENCE:0\n")).toBe(false);
  });

  it("rejects a body that is not a playlist at all", () => {
    expect(isMouflonLivePlaylist("Not Found")).toBe(false);
    expect(isMouflonLivePlaylist("")).toBe(false);
  });
});
