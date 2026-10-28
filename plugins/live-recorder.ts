// Shared segmented live recorder. The queue signals its entire process group on POSIX.
export const LIVE_RECORDER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [mediaUrl, masterUrl, headersJson, output, gapArg, pollArg, userAgent, refreshUrl, refreshField] = process.argv.slice(1);
const headers = JSON.parse(headersJson);
let currentMasterUrl = masterUrl;
const gapMs = Number(gapArg) || 0;
const pollMs = Number(pollArg) || 20000;
const stallMs = Number(process.env.EASYX_LIVE_STALL_MS) || 60000;
const partsDir = path.join(path.dirname(output), "live-parts");
fs.rmSync(partsDir, { recursive: true, force: true });
fs.mkdirSync(partsDir, { recursive: true });
const controller = new AbortController();
let stopping = false, cancelled = false, child, wake = () => {};
const say = (text) => process.stderr.write("[live-recorder] " + text + "\n");
process.on("SIGINT", () => { stopping = true; if (process.platform === "win32") child?.kill("SIGINT"); controller.abort(); wake(); });
process.on("SIGTERM", () => { stopping = true; cancelled = true; child?.kill("SIGKILL"); controller.abort(); wake(); });
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
const run = (args, watchPath) => new Promise((resolve) => {
  child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
  // The queue's own stall timer kills this whole process group, which turns a CDN hiccup into a
  // failed item: the re-resolve below never gets to run. Watching the output here instead keeps the
  // recovery local -- ffmpeg is restarted, the stream is resolved again, and the recording continues
  // in the same item as the next part. Only ffmpeg is signalled, never this wrapper.
  let guard;
  if (stallMs > 0 && watchPath) {
    let lastSize = -1, lastGrowth = Date.now();
    guard = setInterval(() => {
      const now = size(watchPath);
      if (now !== lastSize) { lastSize = now; lastGrowth = Date.now(); return; }
      if (Date.now() - lastGrowth < stallMs) return;
      lastGrowth = Date.now(); // one restart per stall window, even if the kill is ignored
      say("no output for " + Math.round(stallMs / 1000) + "s; restarting this capture attempt");
      try { child?.kill("SIGKILL"); } catch {}
    }, 2000);
    guard.unref?.();
  }
  const finish = (code) => { if (guard) clearInterval(guard); child = undefined; resolve(code); };
  child.once("error", () => finish(-1));
  child.once("close", (code) => finish(code));
});
const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const isLive = (text) => text.trimStart().startsWith("#EXTM3U") && !text.includes("#EXT-X-MOUFLON-ADVERT")
  && !text.includes("#EXT-X-ENDLIST") && (text.includes("#EXTINF:") || text.includes("#EXT-X-PART:"));
async function get(url) {
  const response = await fetch(url, { headers: { ...headers, "user-agent": userAgent }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
  return response.ok ? response.text() : undefined;
}
// Why nothing is servable matters more than the fact itself: a broadcast that has ended should
// free the capture slot at once, while a provider we merely cannot reach is exactly what the wait
// window exists to wait out. Only an unambiguous "gone" counts -- 404/410, or a playlist whose own
// ENDLIST says the stream closed. A 403 does not, because rate limiting answers the same way.
async function masterGone() {
  try {
    const response = await fetch(currentMasterUrl, { headers: { ...headers, "user-agent": userAgent }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    if (response.status === 404 || response.status === 410) return true;
    if (!response.ok) return false;
    const text = await response.text();
    if (!text.trimStart().startsWith("#EXTM3U")) return false;
    return text.includes("#EXT-X-ENDLIST");
  } catch { return false; }
}
async function variants(refresh = false) {
  if (refresh && refreshUrl && refreshField) {
    const body = await get(refreshUrl);
    if (!body) return [];
    const data = JSON.parse(body);
    const next = data && data[refreshField];
    if (typeof next !== "string" || !/^https?:\/\//i.test(next)) return [];
    currentMasterUrl = next;
  }
  const text = await get(currentMasterUrl);
  if (!text || !text.trimStart().startsWith("#EXTM3U") || text.includes("#EXT-X-MOUFLON-ADVERT")) return [];
  if (isLive(text)) return [{ url: currentMasterUrl, resolution: "", bandwidth: 0 }];
  const pkey = new URL(currentMasterUrl).searchParams.get("pkey");
  const list = []; let info = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) { info = line; continue; }
    if (!line || line.startsWith("#") || !/\.m3u8(?:$|\?)/i.test(line)) continue;
    const url = new URL(line, currentMasterUrl);
    if (pkey && !url.searchParams.has("pkey")) url.searchParams.set("pkey", pkey);
    list.push({ url: url.toString(), bandwidth: Number((info.match(/(?:^|[:,])BANDWIDTH=(\d+)/i) || [])[1] || 0), resolution: (info.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || "", codecs: (info.match(/CODECS="([^"]+)"/i) || [])[1] || "" });
    info = "";
  }
  return list.sort((a, b) => b.bandwidth - a.bandwidth);
}
// "avc1.4d401f,mp4a.40.2" -> "avc1,mp4a". The profile and level inside a family can differ (that is
// still H.264, still spliceable); a family change -- hvc1, av01 -- is what a -c copy splice cannot
// carry, so that is the only thing that still finishes a video.
function codecFamilies(value) {
  return (value || "").split(",").map((part) => part.trim().toLowerCase().split(".")[0]).filter(Boolean).sort().join(",");
}
function sameCodecs(left, right) {
  if (!left || !right) return true; // the master did not advertise them: do not split on a guess
  return codecFamilies(left) === codecFamilies(right);
}
async function liveVariant(resolution, codecs) {
  const list = await variants(true);
  // Collect what is actually broadcasting before deciding: "no variant is live" and "a different
  // variant is live" need opposite answers from the caller.
  const live = [];
  for (const item of list) {
    try { const text = await get(item.url); if (text && isLive(text)) live.push(item); } catch {}
  }
  if (!resolution) return live[0];
  const preferred = live.find((item) => item.resolution === resolution);
  if (preferred) return preferred;
  if (!live.length) return undefined;
  // The quality this recording started at is gone, but another one is still broadcasting.
  // Switching is better than finishing the file: verified that a 720p part followed by a 480p part
  // concatenated with -c copy decodes cleanly and the frames switch resolution at the join, and one
  // continuous video beats two files plus the minutes lost while the watcher notices the room again.
  const compatible = live.find((item) => sameCodecs(item.codecs, codecs));
  return compatible ?? { url: "", resolution: "changed" };
}
(async () => {
  const parts = [];
  let url = mediaUrl, resolution, codecs;
  try {
    const initial = (await variants()).find((item) => item.url === mediaUrl);
    resolution = initial?.resolution; codecs = initial?.codecs;
  } catch {}
  while (!stopping) {
    const part = path.join(partsDir, "part-" + String(parts.length + 1).padStart(3, "0") + ".ts");
    const headerLines = Object.entries(headers).map(([name, value]) => name + ": " + value).join("\r\n") + "\r\n";
    const code = await run(["-hide_banner", "-loglevel", "warning", "-rw_timeout", "15000000", "-user_agent", userAgent, "-headers", headerLines, "-i", url,
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "mpegts", "-y", part], part);
    const recorded = size(part) > 0;
    if (recorded) parts.push(part); else fs.rmSync(part, { force: true });
    if (stopping || !recorded || gapMs <= 0) break;
    if (resolution === undefined) {
      try {
        const first = new URL(mediaUrl).pathname;
        const match = (await variants()).find((item) => new URL(item.url).pathname === first);
        resolution = match?.resolution || ""; codecs = match?.codecs || codecs;
      } catch { resolution = ""; }
    }
    say("stream stopped (ffmpeg exit " + code + "); waiting up to " + (gapMs >= 60000 ? Math.round(gapMs / 60000) + " min" : Math.round(gapMs / 1000) + " s") + " for the room to return");
    const deadline = Date.now() + gapMs;
    url = "";
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      if (stopping) break;
      let found;
      try { found = await liveVariant(resolution, codecs); } catch {}
      if (found && found.resolution === "changed") { say("room is back with different codecs; finishing this video"); break; }
      if (found && found.url) {
        if (found.resolution && found.resolution !== resolution) { resolution = found.resolution; say("quality changed to " + resolution + "; continuing the same video"); }
        url = found.url; say("room is public again; continuing the recording"); break;
      }
      // Nothing servable right now. Stop at once if the broadcast is unambiguously over, so the
      // capture slot goes back to the queue instead of being parked for the rest of the window.
      if (await masterGone()) { say("the broadcast has ended; finishing this video"); break; }
    }
    if (!url) break;
  }
  if (cancelled) { fs.rmSync(partsDir, { recursive: true, force: true }); process.exit(143); }
  if (!parts.length) { fs.rmSync(partsDir, { recursive: true, force: true }); say("no video was recorded"); process.exit(1); }
  const list = path.join(partsDir, "parts.txt");
  fs.writeFileSync(list, parts.map((part) => "file '" + path.basename(part) + "'").join("\n") + "\n");
  stopping = false;
  const joined = await run(["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", output]);
  if (joined !== 0 || size(output) === 0) { say("joining " + parts.length + " part(s) failed"); process.exit(1); }
  fs.rmSync(partsDir, { recursive: true, force: true });
  if (parts.length > 1) say("joined " + parts.length + " parts into one video");
  process.exit(0);
})().catch((error) => { say(String((error && error.stack) || error)); process.exit(1); });
`;


export async function retryDelay(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
