import type { CommandDownloadRequest, EasyXPlugin, LiveCam, LiveStream, MediaCandidate, PluginContext } from "./plugin-sdk/index.js";

const FFMPEG_CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * ffmpeg protocol read/write timeout, in microseconds (15s). Long enough that a slow but healthy
 * segment request is never cut, short enough that a dead socket is retried while the recording can
 * still catch up with the live edge. Must stay below the live stall timeout in the downloader, or
 * the stall timer kills the capture before ffmpeg has a chance to reconnect.
 */
const LIVE_READ_TIMEOUT_US = 15_000_000;

/**
 * Marker written next to a capture that ffmpeg fed from a single input.
 *
 * The remux falls back to comparing the container's video and audio start times when nothing
 * measured the offset, and that comparison is meaningless on a single-input capture: the two
 * streams legitimately begin at different instants (each rendition's first segment covers a
 * different slice of the same timeline), so the difference is a head length, not a skew. Applying
 * it would shift an already-aligned track. No file means "not known to be single input", which is
 * exactly when the historical comparison is still the right guess.
 */
export const SINGLE_INPUT_MARKER = "capture.single-input";

/**
 * How a direct capture feeds ffmpeg.
 *
 * `split` opens one input per rendition (the historical behaviour, and the only option for a
 * provider whose video and audio cannot share a playlist). `master` opens ONE input: a master
 * playlist that names both renditions, so the HLS demuxer owns a single timeline and aligns them
 * itself. See `chooseDirectCaptureInput` for why that matters.
 */
export type DirectCaptureInput = "split" | "master";

/**
 * Whether a stream should be captured through one master playlist instead of two inputs.
 *
 * Two independent inputs each start at their own live edge, and the two renditions' segments are
 * not the same length, so "three segments before the end" lands at two different instants and the
 * capture carries a constant offset -- typically audio 1-3s ahead. Nothing in the container shows
 * it (the TS muxer rebases both streams to the same start_time), which is why the recorder measures
 * the source-side PROGRAM-DATE-TIME and shifts the audio back at remux time.
 *
 * A single master input removes the cause: one demuxer, one timeline, the audio group aligned by
 * the playlist itself -- exactly what a browser player does. Measured on a 30s capture:
 * PTS(first audio) - PTS(first video) equalled PDT(first audio segment) - PDT(first video segment)
 * to within one frame, so identical wall-clock moments keep identical timestamps. The offset
 * measurement then has nothing to correct, and the remux no longer re-encodes the audio to apply
 * a shift.
 *
 * The master itself is not a file: ffmpeg refuses `-user_agent`/`-headers` on a local input and
 * then finds no streams in it at all. It is the app's HLS proxy, which already synthesizes exactly
 * this playlist for the browser preview -- the recorder points ffmpeg at the same URL.
 *
 * Only two things can make a single input pointless, so only those two stay on `split`:
 *  - no separate audio rendition (nothing to align),
 *  - no proxy to serve the master, which is the caller's business (`rewrite` returns nothing).
 */
export function chooseDirectCaptureInput(stream: LiveStream, preference: string | undefined): DirectCaptureInput {
  if (preference !== "master" && preference !== "auto") return "split";
  return stream.audioUrl ? "master" : "split";
}

/**
 * The capture-input preference in force: a deployment override wins over the stored setting.
 *
 * The override exists so a rollout can switch one box without touching its database, and switch it
 * back just as quickly -- the same reason the segmented-capture kill switch exists.
 */
export function captureInputPreference(settingValue: unknown, envValue: string | undefined): string {
  const known = (value: unknown): string | undefined => {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    return text === "split" || text === "master" || text === "auto" ? text : undefined;
  };
  return known(envValue) ?? known(settingValue) ?? "split";
}

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
    // A read timeout is what makes `-reconnect` usable at all. The reconnect flags only react to
    // a *closed* or *errored* connection; a CDN that holds the socket open and simply stops
    // sending (a half-open TCP, the classic LL-HLS stall) blocks ffmpeg indefinitely, and the
    // only thing that used to end it was the downloader's stall timer -- which SIGKILLs the whole
    // capture, so a 30-second network hiccup cost the entire recording plus a 15-minute retry
    // backoff. 15s matches the plugin-side recorder, so both capture paths now degrade the same
    // way: the read fails, ffmpeg reconnects and re-reads the playlist, the capture survives.
    "-rw_timeout", String(LIVE_READ_TIMEOUT_US),
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
 * @param rewrite  Optional hook that replaces the stream's address before ffmpeg sees it. Two
 *   callers need it. A provider whose playlist is obfuscated (or needs private headers) cannot be
 *   recorded directly: ffmpeg parses the playlist as written and fetches the decoys, so the server's
 *   HLS proxy rewrites it on the way through. And a `master` capture is served the same way, because
 *   the proxy already synthesizes the master playlist that unifies the two renditions. Either way the
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
    const filename = item.filename ?? `${item.externalId}.mp4`;
    if (proxied) {
      // One input: the proxy's master (when it has one) names both renditions, so a single demuxer
      // owns the timeline. The remux is told, because it must not read that as an offset.
      return { ...ffmpegLiveCaptureCommand({ url: proxied }, { referer, output: "{outputDir}/capture.ts", filename }), captureInput: "master" };
    }
    // A live capture always states how it feeds ffmpeg, so the downloader can write (or clear) the
    // marker the remux reads. `split` is the two-input command with one demuxer per rendition.
    return { ...ffmpegLiveCaptureCommand(stream, { referer, output: "{outputDir}/capture.ts", filename }), captureInput: "split" };
  } catch (error) {
    context.log("warn", "Live stream capture resolution failed; falling back to the plugin download path", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
