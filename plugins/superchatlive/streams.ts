/**
 * SuperChat VR (vr.superchat.live) stream plumbing.
 *
 * The site is a white-label front end that shares Stripchat's back end and CDN, so the
 * HLS shape is the same: one master playlist per room, addressed through a `cdnHost`
 * placeholder. Unlike Stripchat, no playback key is needed for a public room, and the
 * URL template is served by the API instead of being scraped out of the page — which is
 * why this plugin is API-first and never parses room HTML.
 *
 * Everything a probe confirmed is captured here as a constant fallback, so a config
 * outage degrades a stream to "probably still resolvable" instead of "unavailable".
 */

export const SUPERCHAT_ORIGIN = "https://vr.superchat.live";
export const SUPERCHAT_API = `${SUPERCHAT_ORIGIN}/api/vr`;

/** initial.common.hlsStreamUrlTemplate, verbatim from GET /api/vr/v3/config/initial. */
export const DEFAULT_HLS_TEMPLATE = "https://edge-hls.{cdnHost}/hls/{streamName}/master/{streamName}{suffix}.m3u8";

/**
 * Mirror of initial.common.hlsStreamHosts. Ordered by what actually answered during
 * probing: `defaultHlsStreamHost` (doppiocdn.media) served every suffix on the first
 * attempt, so it leads.
 */
export const FALLBACK_HLS_HOSTS = [
  "doppiocdn.media", "doppiocdn.org", "doppiocdn.com", "doppiocdn.net", "doppiocdn.live", "doppiocdn1.com",
];

/**
 * The CDN only answered with a room referer, and `ffmpegLiveCaptureCommand` derives its
 * own User-Agent, so this deliberately carries no user-agent key.
 */
export const SUPERCHAT_STREAM_HEADERS: Record<string, string> = {
  referer: `${SUPERCHAT_ORIGIN}/`,
  origin: SUPERCHAT_ORIGIN,
};

export type SuperchatStreamConfig = {
  template: string;
  hosts: string[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A hostname we are willing to interpolate into the template. */
function hostname(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const bare = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(bare) ? bare : undefined;
}

/**
 * Read the HLS template and the CDN host order out of `GET /api/vr/v3/config/initial`.
 * Any shape drift falls back to the constants above rather than failing the request.
 */
export function superchatStreamConfig(payload: unknown): SuperchatStreamConfig {
  const common = record(record(record(payload)?.initial)?.common) ?? {};
  const template = text(common.hlsStreamUrlTemplate) ?? DEFAULT_HLS_TEMPLATE;

  const hosts: string[] = [];
  const push = (value: unknown) => {
    const host = hostname(value);
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  push(common.defaultHlsStreamHost);
  const labelled = record(common.hlsStreamHosts);
  if (labelled) for (const value of Object.values(labelled)) push(value);
  push(common.hlsStreamHost);
  for (const host of FALLBACK_HLS_HOSTS) push(host);
  return { template, hosts };
}

/**
 * The room's own playlist names the CDN that is currently serving it, which is more
 * accurate than guessing from the host list — try it first when it is present.
 */
export function hlsHostFromPlaylist(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    return hostname(/^edge-hls\.(.+)$/i.exec(new URL(raw).hostname)?.[1]);
  } catch {
    return undefined;
  }
}

/**
 * Fill the server template. `{streamName}` appears twice in the real template, so every
 * placeholder is replaced globally.
 */
export function buildSuperchatHlsUrl(template: string, host: string, streamName: string, suffix: string): string {
  const name = encodeURIComponent(streamName);
  return template
    .replace(/\{cdnHost\}/g, host)
    .replace(/\{streamName\}/g, name)
    .replace(/\{suffix\}/g, suffix);
}

/** Variant playlists referenced by a master playlist, resolved against it. */
export function playlistUrls(manifest: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const line of manifest.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#") || !/\.m3u8(?:$|\?)/i.test(value)) continue;
    try { urls.push(new URL(value, baseUrl).toString()); } catch { /* Ignore malformed variants. */ }
  }
  return urls;
}

/**
 * ------------------------------------------------------------------ MOUFLON
 *
 * The CDN wraps every playlist in its anti-leech scheme: a challenge that must be echoed back
 * as `?psch=&pkey=`, a decoy address on each URI line, and an encrypted real address on the
 * preceding `#EXT-X-MOUFLON:URI:` hint. All of it — including the token decryption — lives in
 * `packages/hls-mouflon.ts`, because the server's live proxy has to apply the same decode when
 * it rewrites a playlist for ffmpeg. Re-exported here so this plugin reads as one unit.
 */
export {
  MOUFLON_MARKER,
  MOUFLON_ADDRESS,
  MOUFLON_ADVERT,
  MOUFLON_KEYMAP,
  MOUFLON_SCHEMES,
  parseMouflonChallenge,
  parseMouflonChallenges,
  selectMouflonChallenge,
  mouflonDecryptKey,
  decodeMouflonToken,
  decodeMouflonAddress,
  coerceMouflonPlaylist,
  isMouflonObfuscated,
  isMasterPlaylist,
  mouflonSegmentUrls,
  mouflonMarkers,
  isMouflonLivePlaylist as isLivePlaylist,
  type MouflonChallenge,
} from "../../packages/hls-mouflon.js";

import type { MouflonChallenge } from "../../packages/hls-mouflon.js";

/** Append the challenge the way the player does, preserving any parameters already present. */
export function applyMouflonChallenge(url: string, challenge: MouflonChallenge): string {
  const withParams = new URL(url);
  withParams.searchParams.set("psch", challenge.scheme);
  withParams.searchParams.set("pkey", challenge.key);
  return withParams.toString();
}

/** Strip a room playlist down to a stable identity, for deduplicating live sessions. */
export function streamKeyFromUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}
