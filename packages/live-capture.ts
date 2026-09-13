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
    "-reconnect_on_http_error", "5xx", "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-user_agent", FFMPEG_CHROME_USER_AGENT,
  ];
  if (headerArg.trim()) args.push("-headers", headerArg);
  // -thread_queue_size must precede the input it applies to; giving both HLS
  // demuxers room stops them blocking each other on a shared video+audio capture.
  args.push("-thread_queue_size", "512", "-i", stream.url);
  if (stream.audioUrl) args.push("-thread_queue_size", "512", "-i", stream.audioUrl, "-map", "0", "-map", "1:a:0?");
  args.push("-c", "copy", "-f", "mpegts", options.output);
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

export async function liveRecordingRequest(plugin: EasyXPlugin, context: PluginContext, item: MediaCandidate): Promise<CommandDownloadRequest | undefined> {
  const meta = item.metadata as Record<string, unknown> | undefined;
  if (meta?.live !== true || !plugin.resolveLiveStream) return undefined;
  const pageUrl = item.pageUrl ?? (typeof meta.extractorUrl === "string" ? meta.extractorUrl : undefined);
  if (!pageUrl) return undefined;
  const cam: LiveCam = { id: item.externalId, username: item.identityKey ?? item.title ?? "live", title: item.title, pageUrl };
  try {
    const stream = await plugin.resolveLiveStream(context, cam);
    return ffmpegLiveCaptureCommand(stream, { referer: liveReferer(pageUrl), output: "{outputDir}/capture.ts", filename: item.filename ?? `${item.externalId}.mp4` });
  } catch (error) {
    context.log("warn", "Live stream capture resolution failed; falling back to the plugin download path", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
