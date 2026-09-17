import type { CommandDownloadRequest, EasyXPlugin, LiveCam, LiveStream, MediaCandidate, PluginContext } from "./plugin-sdk/index.js";

const FFMPEG_CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Build an ffmpeg command that captures a live HLS stream straight to MPEG-TS.
 * Capturing to TS (instead of letting yt-dlp record the whole session) keeps
 * memory in the tens of MB per stream and tolerates an abrupt stop: the
 * downloader remuxes the TS to MP4 afterwards and deletes the TS. `-reconnect`
 * lets a transient network error or a segment 403 self-heal inside the same
 * ffmpeg process instead of tearing the whole recording down.
 *
 * `-reconnect_at_eof` is deliberately NOT set: for HLS, every short segment and
 * playlist request ends at EOF, so that flag makes ffmpeg reconnect to the same
 * byte offset forever — it never finishes opening the init section and writes
 * zero bytes, until the downloader's stall timeout kills it (verified against
 * chaturbate LL-HLS on ffmpeg 5.1: without the flag the capture starts
 * immediately, with it the process hangs until killed).
 */
export function ffmpegLiveCaptureCommand(stream: LiveStream, options: { referer?: string; output: string; filename: string }): CommandDownloadRequest {
  const headerLines = new Map<string, string>();
  if (options.referer) headerLines.set("Referer", options.referer);
  for (const [key, value] of Object.entries(stream.headers ?? {})) {
    if (/^user-agent$/i.test(key)) continue; // emitted via -user_agent below
    headerLines.set(key, value);
  }
  const headerArg = [...headerLines].map(([key, value]) => `${key}: ${value}`).join("\r\n") + "\r\n";
  const args = [
    "-nostdin", "-hide_banner",
    // loglevel info (not warning) so the hls demuxer logs "Opening '<segment>'
    // for reading" on stderr; the av-sync measurement maps those first opened
    // segments to their playlist PDT to measure the constant A/V offset.
    "-loglevel", "info", "-y",
    "-reconnect", "1", "-reconnect_on_network_error", "1",
    // 403 is what an LL-HLS CDN returns for a segment evicted before a lagging recorder
    // reached it; reconnecting (and re-reading the refreshed playlist) self-heals that
    // inside this process instead of tearing the capture down. Matches the comment above.
    "-reconnect_on_http_error", "403,5xx", "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-user_agent", FFMPEG_CHROME_USER_AGENT,
  ];
  if (headerArg.trim()) args.push("-headers", headerArg);
  // -thread_queue_size must precede the input it applies to; giving both HLS
  // demuxers room stops them blocking each other on a shared video+audio capture.
  args.push("-thread_queue_size", "512", "-i", stream.url);
  if (stream.audioUrl) args.push("-thread_queue_size", "512", "-i", stream.audioUrl, "-map", "0", "-map", "1:a:0?");
  args.push("-c", "copy");
  // A10 segmented capture: write rolling MPEG-TS parts instead of one long capture.ts. A
  // crash or OOM then leaves every completed segment intact (the downloader concatenates
  // them at finalize, or salvages them into recovery), and a retried capture resumes at
  // the next segment number instead of starting over. ffmpeg's segment muxer only ever
  // cuts on TS packet boundaries, so no bytes are lost between parts. `EASYX_SEGMENTED_
  // CAPTURE=0` reverts to the legacy single capture.ts (kill switch for a gray rollout).
  if (process.env.EASYX_SEGMENTED_CAPTURE === "0") {
    args.push("-f", "mpegts", options.output);
  } else {
    const segmentSeconds = Math.max(60, Math.floor(Number(process.env.EASYX_SEGMENT_SECONDS ?? 600)));
    args.push(
      "-f", "segment", "-segment_time", String(segmentSeconds),
      "-segment_format", "mpegts", "-reset_timestamps", "1",
      "-segment_start_number", "{segmentStart}",
      options.output.replace(/capture\.ts$/, "capture_part%03d.ts"),
    );
  }
  return { kind: "command", command: "ffmpeg", args, filename: options.filename };
}

/** Use the recorded page's own origin as the referer; the stream headers win when they set one. */
export function liveReferer(pageUrl: string | undefined): string | undefined {
  if (!pageUrl) return undefined;
  try { return `${new URL(pageUrl).origin}/`; } catch { return undefined; }
}

/**
 * Resolve a live recording centrally so the TS-first capture takes priority over
 * whatever a plugin's own `resolveDownload` would return. This makes every live
 * item record through ffmpeg to MPEG-TS no matter which plugin produced it — the
 * plugin only has to expose its stream via `resolveLiveStream`, which every
 * live-cam plugin already must implement. Returns undefined when the item is not
 * a live capture or offers no live resolver, so the caller falls back to the
 * plugin's normal download path.
 */
/**
 * True when a candidate describes a live broadcast rather than a stored file. Scrapers use it to
 * announce that a room is on air, but it is not a downloadable asset: acting on it opens a second
 * ffmpeg on a broadcast that may already be recording, which ends both captures. The sync path
 * therefore drops these and leaves live capture to the recorder.
 */
export function isLiveCandidate(candidate: MediaCandidate): boolean {
  return (candidate.metadata as Record<string, unknown> | undefined)?.live === true;
}

/**
 * @param rewrite  Optional hook that replaces the stream's address before ffmpeg sees it. A
 *   provider whose playlist is obfuscated (or needs private headers) cannot be recorded
 *   directly: ffmpeg parses the playlist as written and fetches the decoys. The server's HLS
 *   proxy rewrites it on the way through, so callers that have one pass a hook here. The
 *   proxied address carries no headers of its own - the proxy replays the provider's.
 */
export async function liveRecordingRequest(
  plugin: EasyXPlugin,
  context: PluginContext,
  item: MediaCandidate,
  rewrite?: (stream: LiveStream) => string | undefined,
): Promise<CommandDownloadRequest | undefined> {
  const meta = item.metadata as Record<string, unknown> | undefined;
  if (meta?.live !== true || !plugin.resolveLiveStream) return undefined;
  const pageUrl = item.pageUrl ?? (typeof meta.extractorUrl === "string" ? meta.extractorUrl : undefined);
  if (!pageUrl) return undefined;
  // `username` is the room name, and a plugin keys its room lookup on it, so a display title must
  // not stand in for one: a title like "Anais Bloom ( Anna)" fails a room-name check outright and
  // the plugin then refuses to resolve the broadcast at all. `liveRoom` is the room key a capture
  // records alongside its metadata, which makes it the right stand-in when no identity key exists;
  // the title stays only as the last resort it has always been, for plugins that never validate.
  const roomName = item.identityKey ?? (typeof meta?.liveRoom === "string" ? meta.liveRoom.trim() : undefined);
  const cam: LiveCam = { id: item.externalId, username: roomName || item.title || "live", title: item.title, pageUrl };
  try {
    const stream = await plugin.resolveLiveStream(context, cam);
    const proxied = rewrite?.(stream);
    // A proxied stream needs no identity of its own: the proxy attaches the provider's headers
    // and referer upstream, so sending them here too would only confuse the hop.
    const referer = proxied ? undefined : liveReferer(pageUrl);
    return ffmpegLiveCaptureCommand(proxied ? { url: proxied } : stream, { referer, output: "{outputDir}/capture.ts", filename: item.filename ?? `${item.externalId}.mp4` });
  } catch (error) {
    context.log("warn", "Live stream capture resolution failed; falling back to the plugin download path", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
