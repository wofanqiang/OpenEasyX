import { camsodaRoomStatus } from "../live-cam-discovery.js";
import { browserHtml } from "../browser-html-utils.js";
import { createLiveCamPlugin } from "../live-cam-plugin-factory.js";

const plugin = createLiveCamPlugin({
  id: "org.easyx.camsoda", name: "CamSoda Live", prefix: "camsoda", homepage: "https://www.camsoda.com",
  discovery: "camsoda",
  description: "Check a public CamSoda room and play or record its active live stream with yt-dlp and FFmpeg.",
  sourceUrlPatterns: ["http://camsoda.com/*", "https://camsoda.com/*", "http://www.camsoda.com/*", "https://www.camsoda.com/*"],
  cookieDomains: ["camsoda.com"], loginUrl: "https://www.camsoda.com/login", minimumIntervalSeconds: 5, defaultIntervalSeconds: 10,
  // The edge (streaming-edge-front.livemediahost.com) answers 403 to ffmpeg's OpenSSL stack for
  // URLs that answer 200 through a Chrome TLS fingerprint -- playlist and segments alike, with
  // identical headers. The recorder therefore captures through the fingerprint proxy.
  fingerprintGated: true,
});

/**
 * The room's own status, which is the only thing that separates a public show from a private one.
 *
 * The homepage catalogue cannot answer it: a room in a private show is still listed there
 * (measured: `sweet-julieta1` was listed and answered `private`), so the recorder used to start a
 * capture on it and fail with "model is in a private show" once per pass. Reading the room page
 * costs one browser fetch (about 0.3 s) and answers the question before anything is queued.
 *
 * A room whose page cannot be read throws rather than guessing: an unknown status must never read
 * as "not public" for the recorder, because that would silently stop recording a healthy room.
 */
plugin.getLiveCam = async (context, cam) => {
  const html = await browserHtml(context, cam.pageUrl, { timeoutMs: 45_000 });
  const status = camsodaRoomStatus(html);
  if (!status) throw new Error("CamSoda did not return a room status");
  return { ...cam, status, online: status === "public", statusUnavailable: false };
};

export default plugin;
