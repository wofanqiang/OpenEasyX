/**
 * MOUFLON — the anti-leech wrapper Tencent's live CDN stamps onto HLS playlists.
 *
 * The CDN identifies itself as `Server: MC_VCLOUD_LIVE` and fronts the `doppiocdn` hosts used
 * by Stripchat and its white labels (vr.superchat.live among them). A plain client that asks
 * for a room's media playlist gets something that parses but points at nothing usable. Three
 * layers, all reproduced here:
 *
 *  1. Challenge. Every master advertises `#EXT-X-MOUFLON:PSCH:<scheme>:<key>` lines (eleven of
 *     them, freshly randomised per fetch). A media playlist only returns the live window when
 *     the request echoes one back as `?psch=<scheme>&pkey=<key>`; otherwise the CDN answers
 *     with a finite advert reel tagged `#EXT-X-MOUFLON-ADVERT`.
 *
 *     Not every token is usable. The player ships a keymap and picks the first advertised
 *     `(scheme, key)` pair whose key appears in it — see `selectMouflonChallenge`. Any token
 *     appears to satisfy the challenge, but only a keymapped one decrypts the addresses.
 *
 *  2. Address substitution. Inside a media playlist the address that is literally written on
 *     the URI line is a decoy (`.../media.mp4`), and the real address arrives on the preceding
 *     `#EXT-X-MOUFLON:URI:` hint. `coerceMouflonPlaylist` moves it where a parser expects it.
 *
 *  3. Address encryption. The hint itself is still opaque: the token in
 *     `<prefix>_<seq>_<token>_<ts>_part<n>.mp4` is encrypted. The player's `V2PostParse`
 *     reverses the string, base64-decodes it and XORs the bytes with `SHA-256(keymap[key])`
 *     (cycled over 32 bytes) to recover a 16-character alphanumeric token. `decodeMouflonToken`
 *     is that routine.
 *
 * Layer 1 is why a recorder needs `?psch=&pkey=`; layers 2 and 3 are why it needs the playlist
 * rewritten between the CDN and ffmpeg. Both live here so the plugin that resolves streams and
 * the server proxy that rewrites them share one implementation.
 */
import { createHash } from "node:crypto";

export const MOUFLON_MARKER = "#EXT-X-MOUFLON";
/** Carries the real segment address, ahead of the decoy written on the URI line. */
export const MOUFLON_ADDRESS = "#EXT-X-MOUFLON:URI:";
/** Marks the finite advert reel the CDN serves when the challenge is missing or stale. */
export const MOUFLON_ADVERT = "#EXT-X-MOUFLON-ADVERT";

/**
 * The keymap the CDN's own player bundles (`TimeCoerceCoordinator`). Only a `PSCH` key listed
 * here yields a decryption key; `test` is the player's own debug entry and is kept so a
 * debug-tagged playlist behaves exactly as the site does.
 */
export const MOUFLON_KEYMAP: Readonly<Record<string, string>> = {
  Ook7quaiNgiyuhai: "EQueeGh2kaewa3ch",
  test: "secret",
};

/** Scheme versions the bundled player knows how to unwrap. */
export const MOUFLON_SCHEMES: readonly string[] = ["v2", "v1"];

export type MouflonChallenge = {
  scheme: string;
  key: string;
};

const CHALLENGE = /^#EXT-X-MOUFLON:PSCH:([^:\r\n ]+):([^\r\n ]+)\s*$/gm;
/** `<prefix>_<seq>_<token>_<ts>[_part<n>].mp4`, anchoring the encrypted token. */
const SEGMENT = /_([^_]+)_(\d+(?:_part\d+)?)\.mp4(?:[?#].*)?$/;
/** A token that could plausibly be the CDN's base64 blob rather than an already-clear name. */
const ENCRYPTED_TOKEN = /^[A-Za-z0-9+/]{8,}={0,2}$/;
/** What a successfully decrypted token looks like; anything else means "wrong key, do not guess". */
const CLEAR_TOKEN = /^[A-Za-z0-9]{8,32}$/;

/** Every challenge a manifest advertises, in order. */
export function parseMouflonChallenges(manifest: string): MouflonChallenge[] {
  const matches = manifest.matchAll(new RegExp(CHALLENGE.source, CHALLENGE.flags));
  return [...matches].map((match) => ({ scheme: match[1], key: match[2] }));
}

/** The first challenge a manifest advertises, if any. */
export function parseMouflonChallenge(manifest: string): MouflonChallenge | undefined {
  return parseMouflonChallenges(manifest)[0];
}

/** The decryption key for a challenge, or `undefined` when the player would not trust it. */
export function mouflonDecryptKey(challenge: MouflonChallenge): string | undefined {
  return Object.prototype.hasOwnProperty.call(MOUFLON_KEYMAP, challenge.key)
    ? MOUFLON_KEYMAP[challenge.key]
    : undefined;
}

/**
 * The challenge the CDN's own player would settle on: the first advertised pair whose key is in
 * the keymap and whose scheme it understands. Falls back to the first advertised challenge so a
 * scheme we do not know still gets its playlist fetched (and then plainly fails to decode),
 * which surfaces a real warning instead of a silent "unavailable".
 */
export function selectMouflonChallenge(manifest: string): MouflonChallenge | undefined {
  const challenges = parseMouflonChallenges(manifest);
  return challenges.find((challenge) => isSupportedChallenge(challenge)) ?? challenges[0];
}

function isSupportedChallenge(challenge: MouflonChallenge): boolean {
  return MOUFLON_SCHEMES.includes(challenge.scheme) && mouflonDecryptKey(challenge) !== undefined;
}

/**
 * Recover a clear segment token from the CDN's encrypted one.
 *
 * Mirrors the player's `V2PostParse`: reverse the string, base64-decode it, then XOR every byte
 * with the SHA-256 of the keymap entry for the active challenge key (cycled). The player uses
 * `Intl.Segmenter` to reverse by grapheme cluster; these tokens are pure base64, where grapheme
 * and code-point reversal are identical, so a code-point reverse is exact.
 */
export function decodeMouflonToken(token: string, decryptKey: string): string {
  const reversed = [...token].reverse().join("");
  const encrypted = Buffer.from(reversed, "base64");
  const mask = createHash("sha256").update(decryptKey).digest();
  const plain = Buffer.alloc(encrypted.length);
  for (let index = 0; index < encrypted.length; index += 1) {
    plain[index] = encrypted[index]! ^ mask[index % mask.length]!;
  }
  return plain.toString("utf8");
}

/**
 * Decrypt the token inside one segment address, leaving everything else alone. Returns the
 * address unchanged when it carries no encrypted token or when decryption does not produce a
 * plausible token, so a scheme change degrades to "the old behaviour" rather than to a URL
 * assembled from garbage.
 */
export function decodeMouflonAddress(address: string, decryptKey: string): string {
  const match = SEGMENT.exec(address);
  if (!match) return address;
  const token = match[1]!;
  if (!ENCRYPTED_TOKEN.test(token)) return address;
  let decoded: string;
  try {
    decoded = decodeMouflonToken(token, decryptKey);
  } catch {
    return address;
  }
  if (!CLEAR_TOKEN.test(decoded)) return address;
  const start = match.index + 1;
  return `${address.slice(0, start)}${decoded}${address.slice(start + token.length)}`;
}

/** True when a playlist is hiding its segment addresses behind MOUFLON. */
export function isMouflonObfuscated(manifest: string): boolean {
  return manifest.includes(MOUFLON_ADDRESS);
}

/** True when a playlist lists variants rather than segments. */
export function isMasterPlaylist(manifest: string): boolean {
  return manifest.includes("#EXT-X-STREAM-INF:");
}

/**
 * A playlist that is genuinely live right now. The CDN's finite advert reel is a VOD and is
 * rejected; the ordinary `PSCH` watermark is present on real streams too, so only an
 * `#EXT-X-MOUFLON-ADVERT` body is disqualifying.
 */
export function isMouflonLivePlaylist(manifest: string): boolean {
  return manifest.trimStart().startsWith("#EXTM3U")
    && !manifest.includes(MOUFLON_ADVERT)
    && (manifest.includes("#EXT-X-MEDIA-SEQUENCE:") || manifest.includes("#EXT-X-PART:"));
}

/**
 * Rewrite a media playlist so a normal HLS parser finds the real addresses.
 *
 * Reproduces the player's pre-parse: an `#EXT-X-MOUFLON:URI:` value supplies the address the
 * following `#EXT-X-PART` URI or bare URL line should have carried. With a `decryptKey` the
 * address is decrypted on the way through, which is what makes the result playable.
 */
export function coerceMouflonPlaylist(manifest: string, decryptKey?: string): string {
  const address = (value: string) => (decryptKey ? decodeMouflonAddress(value, decryptKey) : value);
  const output: string[] = [];
  let pending: string | undefined;
  let afterInf = false;
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXTINF:")) {
      afterInf = true;
      output.push(line);
    } else if (trimmed.startsWith(MOUFLON_ADDRESS)) {
      pending = address(trimmed.slice(MOUFLON_ADDRESS.length).trim());
      output.push(line);
    } else if (pending && trimmed.startsWith("#EXT-X-PART:")) {
      output.push(line.replace(/URI="[^"]+"/, `URI="${pending}"`));
      pending = undefined;
    } else if (afterInf && pending && trimmed && !trimmed.startsWith("#")) {
      output.push(pending);
      pending = undefined;
      afterInf = false;
    } else {
      output.push(line);
      if (trimmed && !trimmed.startsWith("#")) afterInf = false;
    }
  }
  return output.join("\n");
}

/**
 * The real segment addresses carried by the `#EXT-X-MOUFLON:URI:` lines, decrypted when a key is
 * supplied. Exposed because the rewrite proxy needs them and because tests assert that the decoy
 * is never the address that gets fetched.
 */
export function mouflonSegmentUrls(manifest: string, decryptKey?: string): string[] {
  const urls: string[] = [];
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(MOUFLON_ADDRESS)) continue;
    const raw = trimmed.slice(MOUFLON_ADDRESS.length).trim();
    if (!raw) continue;
    const value = decryptKey ? decodeMouflonAddress(raw, decryptKey) : raw;
    if (!urls.includes(value)) urls.push(value);
  }
  return urls;
}

/** Watermark markers seen in a playlist, for warning when the CDN changes its scheme. */
export function mouflonMarkers(manifest: string): string[] {
  const markers = new Set<string>();
  for (const line of manifest.split(/\r?\n/)) {
    if (!line.startsWith(MOUFLON_MARKER)) continue;
    markers.add(line.slice(0, line.indexOf(":") + 24).trim());
  }
  return [...markers];
}
