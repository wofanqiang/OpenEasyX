import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import { coerceMouflonPlaylist } from "../packages/hls-mouflon.js";
import { isInternalHost } from "../packages/public-fetch.js";
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

type ProxyEntry = { url?: string; body?: string; headers: Record<string, string>; decodeKey?: string; fingerprint?: boolean; expiresAt: number; reject?: { status: number; until: number }; refresher?: StreamRefresher; slot?: "video" | "audio" };

/**
 * How a dead stream gets a new address.
 *
 * A resolved stream carries the provider's session in its URL, and that session does not live
 * forever: when it expires the CDN answers 403 and the recorder has nothing to follow, so the
 * capture dies on a stream that is still broadcasting. Re-resolving the room produces a fresh
 * address, and the capture simply continues -- the playlist it polls never changed, only the
 * address behind it.
 *
 * One refresher serves both renditions of a stream (a video and an audio playlist), because
 * re-resolving twice would spawn the provider's extractor twice for the same room.
 */
type StreamRefresher = {
  resolve: () => Promise<LiveStream | undefined>;
  pending?: Promise<LiveStream | undefined>;
  /** When the last refresh was started, so a burst of refusals cannot turn into a spawn storm. */
  lastAt?: number;
  entries: Set<ProxyEntry>;
};

const ENTRY_TTL_MS = 15 * 60_000;
/**
 * How long a definitive rejection (403/410/429) is remembered for one URL.
 *
 * The recorder retries a playlist far faster than a CDN can change its mind: a broadcast that
 * ended produced 22 upstream requests in 2.4 seconds on a live box, and a CDN that is rate-limiting
 * gets that pressure multiplied back at it exactly when it asked for less. Answering those retries
 * from memory keeps the refusal cheap for both sides. The verdict is per URL, so a re-resolved
 * stream -- which gets a new URL, and therefore a new entry -- is never blocked by it.
 */
const DEFAULT_REJECT_BACKOFF_MS = 5_000;
/** Statuses that mean "no" rather than "not now": a 5xx or a dropped connection is worth retrying. */
const REJECT_STATUSES = new Set([403, 410, 429]);
/**
 * How long one re-resolve may take before another is attempted, and how long the proxy keeps
 * answering from memory while it runs.
 *
 * The refresher is the provider's extractor (yt-dlp for Chaturbate), which takes seconds and
 * costs a process. A refusal storm must not turn into a spawn storm, and the CDN that just said
 * no must not be asked again while the new address is on its way.
 */
const REFRESH_COOLDOWN_MS = 30_000;
const REFRESH_MEMORY_MS = 30_000;
/**
 * How long a refused playlist may be held open while the re-resolve runs.
 *
 * The recorder runs with `-rw_timeout 15s` (see `packages/live-capture.ts`), and a stall is what
 * that timeout ends, so the hold has to stay inside it. Measured on the recorder's own binary
 * (ffmpeg 5.1.9 in the image): a playlist request held for 10 s, and another held for 14 s, both
 * left the capture running -- 12 s keeps a normal re-resolve (2-10 s) and a few seconds of retry
 * inside the budget without reaching the timeout.
 */
const PLAYLIST_WAIT_MS = 12_000;
/**
 * How often expired entries are actually swept. `url()` runs on every line of every rewritten
 * playlist, and a full scan per line made the proxy's cost grow with the recording's length; a
 * sweep 30 seconds apart keeps the map at its steady state for free. The cost of waiting is that
 * a link can outlive its TTL by at most one interval -- still far below anything a stale client
 * could use.
 */
export const PRUNE_EVERY_MS = 30_000;
export { ENTRY_TTL_MS };
const PLAYLIST_MIME = "application/vnd.apple.mpegurl";
/**
 * Route prefix the proxy lives behind. Recorded here rather than only in the router because
 * the recorder has to reach it *without* a login session — see `isLiveProxyPath`.
 */
export const LIVE_PROXY_PREFIX = "/api/live-cams/proxy/";
/**
 * True for the proxy route, which is deliberately reachable without a session.
 *
 * ffmpeg runs inside the server process and has no cookie, so a gate here would make every
 * proxied recording fail with a 401. That is safe because the token in the path is a 192-bit
 * random value that only ever reaches a client who already resolved the stream, and entries
 * expire: possession of the URL *is* the authorisation, exactly as it is for the player.
 */
export function isLiveProxyPath(path: string): boolean {
  return path.startsWith(LIVE_PROXY_PREFIX);
}
// Low-latency HLS clients ask for a specific media sequence/part; forward them or the
// upstream answers with an older window than the client asked for.
const FORWARDED_QUERY = ["_HLS_msn", "_HLS_part", "_HLS_skip"];

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

export class HlsProxy {
  private entries = new Map<string, ProxyEntry>();
  private reverse = new Map<string, string>();
  private lastPrune = -PRUNE_EVERY_MS;

  /**
   * `request` is what every proxied fetch leaves through. `fingerprinted` is the Chrome-impersonating
   * client (see tls-fingerprint.ts) and is spent only on streams whose plugin declared them
   * fingerprint-gated: it costs several times what a plain fetch costs, and routing a provider that
   * answers plain fetches through Python's curl_cffi taxes every byte of the recording for nothing
   * (measured: 13% of one core for a Chaturbate capture that needs no fingerprint at all).
   */
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly fingerprinted?: typeof fetch,
    /** How long a 403/410/429 is answered from memory; 0 disables the memory. */
    private readonly rejectBackoffMs = DEFAULT_REJECT_BACKOFF_MS,
  ) {}

  /**
   * Wrap a resolved stream in a proxy URL. A stream that carries both a video and an audio
   * rendition becomes a tiny master playlist so a player (or ffmpeg) can mux them itself.
   */
  register(stream: LiveStream, refresh?: () => Promise<LiveStream | undefined>): string {
    const decodeKey = stream.playlistDecodeKey;
    const fingerprint = stream.requiresTlsFingerprint === true;
    // One refresher for the whole stream: a video and an audio rendition are refreshed together.
    const refresher: StreamRefresher | undefined = refresh ? { resolve: refresh, entries: new Set<ProxyEntry>() } : undefined;
    if (stream.audioUrl) {
      const videoUrl = this.url(stream.url, stream.headers ?? {}, ".m3u8", decodeKey, fingerprint, refresher, "video");
      const audioUrl = this.url(stream.audioUrl, stream.headers ?? {}, ".m3u8", decodeKey, fingerprint, refresher, "audio");
      return this.body([
        "#EXTM3U", "#EXT-X-VERSION:6",
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioUrl}"`,
        "#EXT-X-STREAM-INF:BANDWIDTH=6500000,AUDIO=\"audio\"", videoUrl, "",
      ].join("\n"), ".m3u8");
    }
    return this.url(stream.url, stream.headers ?? {}, ".m3u8", decodeKey, fingerprint, refresher, "video");
  }

  /** Register a literal playlist body, for the synthesized master above. */
  body(content: string, suffix: string): string {
    const token = randomBytes(24).toString("base64url");
    this.entries.set(token, { body: content, headers: {}, expiresAt: Date.now() + ENTRY_TTL_MS });
    return `${LIVE_PROXY_PREFIX}${token}${suffix}`;
  }

  /**
   * Proxy one URL. Identical (url, headers) pairs reuse a token so a playlist the client
   * refetches every few seconds does not leak a new entry per refresh.
   */
  url(target: string, headers: Record<string, string>, suffix = "", decodeKey?: string, fingerprint = false, refresher?: StreamRefresher, slot: "video" | "audio" = "video"): string {
    this.prune();
    const key = JSON.stringify([target, Object.entries(headers).sort(), suffix, decodeKey ?? "", fingerprint]);
    const existingToken = this.reverse.get(key);
    const existing = existingToken ? this.entries.get(existingToken) : undefined;
    if (existing && existing.expiresAt > Date.now()) {
      existing.expiresAt = Date.now() + ENTRY_TTL_MS;
      // The newest registration owns the address: a stream resolved again hands over its refresher.
      if (refresher) {
        existing.refresher?.entries.delete(existing);
        existing.refresher = refresher;
        existing.slot = slot;
        refresher.entries.add(existing);
      }
      return `${LIVE_PROXY_PREFIX}${existingToken}${suffix}`;
    }
    const token = randomBytes(24).toString("base64url");
    const entry: ProxyEntry = { url: target, headers, decodeKey, fingerprint, expiresAt: Date.now() + ENTRY_TTL_MS, refresher, slot };
    this.entries.set(token, entry);
    refresher?.entries.add(entry);
    this.reverse.set(key, token);
    return `${LIVE_PROXY_PREFIX}${token}${suffix}`;
  }

  /**
   * Start a re-resolve for a stream whose address was refused.
   *
   * Single-flight and rate-limited: one extractor run serves every rendition of the stream, and a
   * refusal storm cannot turn into a spawn storm. While it runs, the entries answer from memory --
   * the address we hold is known to be refused, and asking again would only multiply the pressure
   * on a CDN that just said no. The refresh lands on the entries it belongs to, so the recorder
   * keeps polling the same URL and simply gets the new address behind it.
   */
  private beginRefresh(entry: ProxyEntry, log?: (message: string) => void) {
    const refresher = entry.refresher;
    if (!refresher) return;
    if (refresher.pending) return;
    if (refresher.lastAt !== undefined && Date.now() - refresher.lastAt < REFRESH_COOLDOWN_MS) return;
    refresher.lastAt = Date.now();
    for (const target of refresher.entries) {
      target.reject = { status: target.reject?.status ?? 403, until: Date.now() + REFRESH_MEMORY_MS };
    }
    const pending = refresher.resolve()
      .catch((error) => {
        log?.("live proxy: re-resolving the stream failed: " + (error instanceof Error ? error.message : String(error)));
        return undefined;
      })
      .then((fresh) => {
        if (!fresh) return undefined;
        let moved = 0;
        for (const target of refresher.entries) {
          const next = target.slot === "audio" ? fresh.audioUrl : fresh.url;
          if (!next) continue;
          target.url = next;
          target.headers = fresh.headers ?? target.headers;
          target.reject = undefined;
          moved += 1;
        }
        if (moved) log?.("live proxy: re-resolved the stream after a refusal");
        return fresh;
      })
      .finally(() => { refresher.pending = undefined; });
    refresher.pending = pending;
  }

  /**
   * True for a playlist request, which is the only kind worth holding open.
   *
   * The suffix in the token path is what the client actually asked for, so it is authoritative;
   * it is empty only when the address carried no extension, and then the entry's own address
   * decides. Media segments must answer immediately: a segment 403 is routine (an LL-HLS CDN
   * drops segments a lagging recorder never reached) and ffmpeg retries those by itself.
   */
  private isPlaylistRequest(tokenPath: string, entry: ProxyEntry): boolean {
    const token = tokenPath.split(".", 1)[0];
    const suffix = tokenPath.slice(token.length).toLowerCase();
    if (suffix === ".m3u8" || suffix === ".m3u") return true;
    if (suffix) return false;
    try { return /\.m3u8?$/i.test(new URL(entry.url!).pathname); } catch { return false; }
  }

  /**
   * Wait out an in-flight re-resolve and report whether it cleared the refusal.
   *
   * `beginRefresh` runs in the background, so without this the refusal it is repairing gets
   * answered while the repair is still on its way -- and a refused playlist is fatal, so the
   * capture dies in the gap. Bounded twice: by the refresh itself (a provider that cannot mint a
   * new address has to fail fast, or every playlist request would sit out the full timeout) and
   * by `PLAYLIST_WAIT_MS`.
   */
  private async awaitRefresh(entry: ProxyEntry, log?: (message: string) => void): Promise<boolean> {
    const pending = entry.refresher?.pending;
    if (!pending) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitedTooLong = await Promise.race([
      // A failed refresh is caught inside `beginRefresh`; a throwing `.then` is not, so treat both
      // as "nothing arrived" rather than letting the proxy throw on a refusal.
      pending.then(() => false, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), PLAYLIST_WAIT_MS); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (waitedTooLong) {
      log?.("live proxy: the re-resolve did not land in time, answering the refusal");
      return false;
    }
    // A refresh that produced nothing leaves the verdict in place; one that succeeded clears it.
    return !(entry.reject !== undefined && entry.reject.until > Date.now());
  }

  /**
   * `log` receives the proxy's failures. The route is registered with Fastify's per-request
   * logging silenced -- one capture would otherwise flood the whole log buffer with
   * "incoming request" lines and bury every real message -- so without this, a stale link or an
   * unreachable provider would fail silently exactly when someone is watching the logs for why.
   */
  async serve(tokenPath: string, reply: FastifyReply, query: Record<string, unknown> = {}, range?: string, log?: (message: string) => void) {
    const token = tokenPath.split(".", 1)[0];
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(token);
      log?.("live proxy: stream link expired");
      return reply.status(404).send({ error: "Live stream link expired" });
    }
    entry.expiresAt = Date.now() + ENTRY_TTL_MS;
    if (entry.body !== undefined) return reply.type(PLAYLIST_MIME).header("cache-control", "no-store").send(entry.body);

    // Rebuilt rather than captured, because a refusal may install a fresh address and the retry
    // has to follow it.
    const buildTarget = () => {
      const url = new URL(entry.url!);
      for (const key of FORWARDED_QUERY) { const value = text(query[key]); if (value) url.searchParams.set(key, value); }
      return url;
    };
    let sourceUrl = buildTarget();

    // Answer a remembered refusal without touching the network. Deliberately silent: the refusal
    // was logged once when it happened, and repeating it per retry is the log spam this replaces.
    if (entry.reject && entry.reject.until > Date.now()) {
      return reply.status(entry.reject.status).send({ error: `Live provider returned HTTP ${entry.reject.status}` });
    }

    let response: Response;
    try { response = await this.fetchUpstream(sourceUrl, entry.headers, range, entry.fingerprint ? this.fingerprinted : undefined); }
    catch (error) {
      log?.("live proxy: upstream unreachable: " + (error instanceof Error ? error.message : String(error)));
      return reply.status(502).send({ error: `Upstream live provider unreachable: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (!response.ok) {
      // A refusal is a verdict, not a hiccup: remember it for a few seconds so the recorder's
      // retries are answered locally instead of being multiplied at the provider.
      if (REJECT_STATUSES.has(response.status) && this.rejectBackoffMs > 0) {
        entry.reject = { status: response.status, until: Date.now() + this.rejectBackoffMs };
      }
      // A refusal can also mean the address expired rather than the broadcast ending: the session
      // in the URL has a lifetime. Re-resolving hands the recorder a fresh address, so the capture
      // continues on a stream that never stopped. Only a provider that can be asked again gets
      // this; a stream without a refresher simply keeps refusing.
      if (REJECT_STATUSES.has(response.status)) {
        this.beginRefresh(entry, log);
        // A refused PLAYLIST is fatal on the recording side. Measured against the recorder's own
        // binary (ffmpeg 5.1.9, the one in the image): a single 403 on a playlist *reload* yields
        // "Failed to reload playlist 0" and the process exits about 2 s later -- with exit status
        // 0, which is why those captures were filed as completed rather than failed -- while the
        // very same stall that never answers is survived (held 10 s, then 14 s: still capturing).
        // `-reconnect_on_http_error 403,5xx` covers opening the input, not reloading a playlist.
        // So the re-resolve is only worth anything if this request waits for it: answering 403 at
        // once throws away a capture that a few seconds of patience would have saved.
        // Segments are deliberately excluded: a segment 403 is routine, ffmpeg retries those by
        // itself, and holding every one of them open would pile up sleeping requests all broadcast.
        if (this.isPlaylistRequest(tokenPath, entry) && await this.awaitRefresh(entry, log)) {
          sourceUrl = buildTarget();
          try { response = await this.fetchUpstream(sourceUrl, entry.headers, range, entry.fingerprint ? this.fingerprinted : undefined); }
          catch { /* keep the original refusal: the retry is a second chance, not a promise */ }
        }
        // Deliberately no refusal memory on the way out: remembering this verdict would make the
        // next playlist request answer 403 on the spot, which is the behaviour being removed here.
      }
      if (!response.ok) {
        log?.("live proxy: provider returned HTTP " + response.status + " for " + sourceUrl.host + sourceUrl.pathname);
        return reply.status(response.status).send({ error: `Live provider returned HTTP ${response.status}` });
      }
    }
    entry.reject = undefined;

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
        .send(this.rewrite(playlist, baseUrl, entry.headers, entry.decodeKey, entry.fingerprint));
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
  private rewrite(body: string, sourceUrl: string, headers: Record<string, string>, decodeKey?: string, fingerprint = false): string {
    const coerced = decodeKey ? coerceMouflonPlaylist(body, decodeKey) : body;
    const proxied = (raw: string) => {
      const absolute = new URL(raw, sourceUrl).toString();
      let suffix = "";
      try { const ext = new URL(absolute).pathname.match(/\.[a-z0-9]{1,8}$/i)?.[0]; if (ext) suffix = ext; } catch { /* Keep the token extensionless. */ }
      return this.url(absolute, headers, suffix, decodeKey, fingerprint);
    };
    return coerced.split(/\r?\n/).map((line) => {
      if (!line) return line;
      if (!line.startsWith("#")) return proxied(line.trim());
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${proxied(uri)}"`);
    }).join("\n");
  }

  private async fetchUpstream(url: URL, headers: Record<string, string>, range: string | undefined, fingerprinted?: typeof fetch): Promise<Response> {
    // A playlist decides where the server fetches next: every segment address in it becomes a
    // request the server makes. A provider (or anyone who can steer one) could therefore point
    // the proxy at the machine's own network and read the answer back through the token.
    if (isInternalHost(url.hostname)) {
      throw Object.assign(new Error(`Refusing to fetch an internal address (${url.hostname})`), { statusCode: 403 });
    }
    const request = fingerprinted ?? this.request;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await request(url, { headers: { ...headers, ...(range ? { range } : {}) }, signal: AbortSignal.timeout(60_000) });
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1000 * (attempt + 1)); timer.unref?.(); });
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Upstream fetch failed");
  }

  private prune() {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(token);
    for (const [key, token] of this.reverse) if (!this.entries.has(token)) this.reverse.delete(key);
  }
}
