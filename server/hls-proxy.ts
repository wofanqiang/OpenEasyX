import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import { coerceMouflonPlaylist } from "../packages/hls-mouflon.js";
import type { LiveStream } from "../packages/plugin-sdk/index.js";

/**
 * A short-lived, in-memory HLS proxy.
 *
 * Two things make a live playlist unusable to a plain recorder, and both are fixed here rather
 * than in any one plugin:
 *
 *  - Private CDNs reject requests that do not carry the plugin's headers (Referer, cookies...).
 *    Players get those headers, `ffmpeg` does not, so the proxy replays them upstream.
 *  - Some CDNs (see `packages/hls-mouflon.ts`) obfuscate the segment addresses inside the
 *    playlist itself, so `ffmpeg` parses the decoy and records an advert reel. The proxy
 *    rewrites each playlist it forwards, which is the only place that rewrite can happen —
 *    `ffmpeg` never sees the original bytes.
 *
 * Entries are keyed by an unguessable token and expire after 15 minutes of inactivity, so the
 * URLs handed to a player or a recorder are safe to treat as capabilities.
 */

type ProxyEntry = { url?: string; body?: string; headers: Record<string, string>; decodeKey?: string; expiresAt: number };

const ENTRY_TTL_MS = 15 * 60_000;
const PLAYLIST_MIME = "application/vnd.apple.mpegurl";
// Low-latency HLS clients ask for a specific media sequence/part; forward them or the
// upstream answers with an older window than the client asked for.
const FORWARDED_QUERY = ["_HLS_msn", "_HLS_part", "_HLS_skip"];

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

export class HlsProxy {
  private entries = new Map<string, ProxyEntry>();
  private reverse = new Map<string, string>();

  constructor(private readonly request: typeof fetch = fetch) {}

  /**
   * Wrap a resolved stream in a proxy URL. A stream that carries both a video and an audio
   * rendition becomes a tiny master playlist so a player (or ffmpeg) can mux them itself.
   */
  register(stream: LiveStream): string {
    const decodeKey = stream.playlistDecodeKey;
    if (stream.audioUrl) {
      const videoUrl = this.url(stream.url, stream.headers ?? {}, ".m3u8", decodeKey);
      const audioUrl = this.url(stream.audioUrl, stream.headers ?? {}, ".m3u8", decodeKey);
      return this.body([
        "#EXTM3U", "#EXT-X-VERSION:6",
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioUrl}"`,
        "#EXT-X-STREAM-INF:BANDWIDTH=6500000,AUDIO=\"audio\"", videoUrl, "",
      ].join("\n"), ".m3u8");
    }
    return this.url(stream.url, stream.headers ?? {}, ".m3u8", decodeKey);
  }

  /** Register a literal playlist body, for the synthesized master above. */
  body(content: string, suffix: string): string {
    const token = randomBytes(24).toString("base64url");
    this.entries.set(token, { body: content, headers: {}, expiresAt: Date.now() + ENTRY_TTL_MS });
    return `/api/live-cams/proxy/${token}${suffix}`;
  }

  /**
   * Proxy one URL. Identical (url, headers) pairs reuse a token so a playlist the client
   * refetches every few seconds does not leak a new entry per refresh.
   */
  url(target: string, headers: Record<string, string>, suffix = "", decodeKey?: string): string {
    this.prune();
    const key = JSON.stringify([target, Object.entries(headers).sort(), suffix, decodeKey ?? ""]);
    const existingToken = this.reverse.get(key);
    const existing = existingToken ? this.entries.get(existingToken) : undefined;
    if (existing && existing.expiresAt > Date.now()) {
      existing.expiresAt = Date.now() + ENTRY_TTL_MS;
      return `/api/live-cams/proxy/${existingToken}${suffix}`;
    }
    const token = randomBytes(24).toString("base64url");
    this.entries.set(token, { url: target, headers, decodeKey, expiresAt: Date.now() + ENTRY_TTL_MS });
    this.reverse.set(key, token);
    return `/api/live-cams/proxy/${token}${suffix}`;
  }

  async serve(tokenPath: string, reply: FastifyReply, query: Record<string, unknown> = {}, range?: string) {
    const token = tokenPath.split(".", 1)[0];
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(token); return reply.status(404).send({ error: "Live stream link expired" });
    }
    entry.expiresAt = Date.now() + ENTRY_TTL_MS;
    if (entry.body !== undefined) return reply.type(PLAYLIST_MIME).header("cache-control", "no-store").send(entry.body);

    const sourceUrl = new URL(entry.url!);
    for (const key of FORWARDED_QUERY) { const value = text(query[key]); if (value) sourceUrl.searchParams.set(key, value); }

    let response: Response;
    try { response = await this.fetchUpstream(sourceUrl, entry.headers, range); }
    catch (error) {
      return reply.status(502).send({ error: `Upstream live provider unreachable: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (!response.ok) return reply.status(response.status).send({ error: `Live provider returned HTTP ${response.status}` });

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const contentRange = response.headers.get("content-range");
    const acceptRanges = response.headers.get("accept-ranges");
    const passthroughHeaders = () => {
      reply.header("cache-control", "no-store");
      if (contentRange) reply.header("content-range", contentRange);
      if (acceptRanges) reply.header("accept-ranges", acceptRanges);
    };

    // Playlists are tiny and must be rewritten so every nested URL points back through this
    // proxy. Buffering the whole body here is cheap and safe.
    if (contentType.includes("mpegurl")) {
      const playlist = Buffer.from(await response.arrayBuffer()).toString("utf8");
      passthroughHeaders();
      // Some fetch implementations (and some redirect chains) leave `response.url` empty; without
      // a base to resolve relative addresses against, the rewrite below cannot work at all.
      const baseUrl = response.url || sourceUrl.toString();
      return reply.status(response.status).type(PLAYLIST_MIME)
        .send(this.rewrite(playlist, baseUrl, entry.headers, entry.decodeKey));
    }
    // Media segments are opaque binary. Stream them straight through with no buffering and no
    // disk writes so playback stays real-time instead of waiting for each segment to land on
    // the server first (the old arrayBuffer() + writeProxyCache path caused stutter).
    if (!response.body) {
      const fallback = Buffer.from(await response.arrayBuffer());
      passthroughHeaders();
      return reply.status(response.status).type(contentType).send(fallback);
    }
    passthroughHeaders();
    return reply.status(response.status).type(contentType)
      .send(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
  }

  /**
   * Point every address in a playlist back through this proxy.
   *
   * An obfuscated playlist writes a decoy on the URI line and carries the real, encrypted
   * address on a `#EXT-X-MOUFLON:URI:` hint. Coerce first, so what gets proxied is the address
   * a player will actually fetch. The decode key propagates to every nested playlist, because
   * a master's variants are protected by the same challenge as its segments.
   */
  private rewrite(body: string, sourceUrl: string, headers: Record<string, string>, decodeKey?: string): string {
    const coerced = decodeKey ? coerceMouflonPlaylist(body, decodeKey) : body;
    const proxied = (raw: string) => {
      const absolute = new URL(raw, sourceUrl).toString();
      let suffix = "";
      try { const ext = new URL(absolute).pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0]; if (ext) suffix = ext; } catch { /* Keep the token extensionless. */ }
      return this.url(absolute, headers, suffix, decodeKey);
    };
    return coerced.split(/\r?\n/).map((line) => {
      if (!line) return line;
      if (!line.startsWith("#")) return proxied(line.trim());
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${proxied(uri)}"`);
    }).join("\n");
  }

  private async fetchUpstream(url: URL, headers: Record<string, string>, range: string | undefined): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.request(url, { headers: { ...headers, ...(range ? { range } : {}) }, signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1000 * (attempt + 1)); timer.unref?.(); });
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Upstream fetch failed");
  }

  private prune() {
    const now = Date.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
    for (const [key, token] of this.reverse) if (!this.entries.has(token)) this.reverse.delete(key);
  }
}
