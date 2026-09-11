import type { CommandDownloadRequest, EasyXPlugin, LiveCam, LiveStream, MediaCandidate, PluginContext } from "./plugin-sdk/index.js";

const FFMPEG_CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Build an ffmpeg command that captures a live HLS stream straight to MPEG-TS.
 * Capturing to TS (instead of letting yt-dlp record the whole session) keeps
 * memory in the tens of MB per stream and tolerates an abrupt stop: the
 * downloader remuxes the TS to MP4 afterwards and deletes the TS. `-reconnect`
 * lets a transient network error or a segment 403 self-heal inside the same
 * ffmpeg process instead of tearing the whole recording down.
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
    "-nostdin", "-hide_banner", "-loglevel", "warning", "-y",
    "-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_on_network_error", "1",
    "-reconnect_on_http_error", "5xx", "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-user_agent", FFMPEG_CHROME_USER_AGENT,
  ];
  if (headerArg.trim()) args.push("-headers", headerArg);
  args.push("-i", stream.url);
  if (stream.audioUrl) args.push("-i", stream.audioUrl, "-map", "0", "-map", "1:a:0?");
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
