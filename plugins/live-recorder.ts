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
const partsDir = path.join(path.dirname(output), "live-parts");
fs.rmSync(partsDir, { recursive: true, force: true });
fs.mkdirSync(partsDir, { recursive: true });
const controller = new AbortController();
let stopping = false, cancelled = false, child, wake = () => {};
const say = (text) => process.stderr.write("[live-recorder] " + text + "\n");
process.on("SIGINT", () => { stopping = true; if (process.platform === "win32") child?.kill("SIGINT"); controller.abort(); wake(); });
process.on("SIGTERM", () => { stopping = true; cancelled = true; child?.kill("SIGKILL"); controller.abort(); wake(); });
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
const run = (args) => new Promise((resolve) => {
  child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
  child.once("error", () => { child = undefined; resolve(-1); });
  child.once("close", (code) => { child = undefined; resolve(code); });
});
const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const isLive = (text) => text.trimStart().startsWith("#EXTM3U") && !text.includes("#EXT-X-MOUFLON-ADVERT")
  && !text.includes("#EXT-X-ENDLIST") && (text.includes("#EXTINF:") || text.includes("#EXT-X-PART:"));
async function get(url) {
  const response = await fetch(url, { headers: { ...headers, "user-agent": userAgent }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
  return response.ok ? response.text() : undefined;
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
    list.push({ url: url.toString(), bandwidth: Number((info.match(/(?:^|[:,])BANDWIDTH=(\d+)/i) || [])[1] || 0), resolution: (info.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || "" });
    info = "";
  }
  return list.sort((a, b) => b.bandwidth - a.bandwidth);
}
async function liveVariant(resolution) {
  const list = await variants(true);
  const ordered = resolution ? list.filter((item) => item.resolution === resolution) : list;
  for (const item of ordered) {
    try { const text = await get(item.url); if (text && isLive(text)) return item; } catch {}
  }
  if (!resolution || ordered.length) return undefined;
  for (const item of list) {
    try { const text = await get(item.url); if (text && isLive(text)) return { url: "", resolution: "changed" }; } catch {}
  }
  return undefined;
}
(async () => {
  const parts = [];
  let url = mediaUrl, resolution;
  try { resolution = (await variants()).find((item) => item.url === mediaUrl)?.resolution; } catch {}
  while (!stopping) {
    const part = path.join(partsDir, "part-" + String(parts.length + 1).padStart(3, "0") + ".ts");
    const headerLines = Object.entries(headers).map(([name, value]) => name + ": " + value).join("\r\n") + "\r\n";
    const code = await run(["-hide_banner", "-loglevel", "warning", "-rw_timeout", "15000000", "-user_agent", userAgent, "-headers", headerLines, "-i", url,
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "mpegts", "-y", part]);
    const recorded = size(part) > 0;
    if (recorded) parts.push(part); else fs.rmSync(part, { force: true });
    if (stopping || !recorded || gapMs <= 0) break;
    if (resolution === undefined) {
      try {
        const first = new URL(mediaUrl).pathname;
        resolution = (await variants()).find((item) => new URL(item.url).pathname === first)?.resolution || "";
      } catch { resolution = ""; }
    }
    say("stream stopped (ffmpeg exit " + code + "); waiting up to " + (gapMs >= 60000 ? Math.round(gapMs / 60000) + " min" : Math.round(gapMs / 1000) + " s") + " for the room to return");
    const deadline = Date.now() + gapMs;
    url = "";
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      if (stopping) break;
      let found;
      try { found = await liveVariant(resolution); } catch {}
      if (found && found.resolution === "changed") { say("room is back in a different quality; finishing this video"); break; }
      if (found) { url = found.url; say("room is public again; continuing the recording"); break; }
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
