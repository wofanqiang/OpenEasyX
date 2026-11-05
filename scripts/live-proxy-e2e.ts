/**
 * Real-binary regression for the HLS proxy's refusal handling.
 *
 * Nothing is mocked: this drives the deployed `HlsProxy` module, the container's own ffmpeg 5.1.9,
 * and a fake CDN that answers a genuine 403 on a playlist reload. Two scenarios are checked:
 *
 *   fix      a playlist is refused, a re-resolve lands 4 s later at a fresh address -- the capture
 *            must survive and keep writing media across the refusal
 *   control  the same refusal, but the re-resolve finds nothing -- the capture must die with
 *            "Failed to reload playlist 0" and exit status 0 (the old failure shape)
 *
 * Run it INSIDE the recording container, where the ffmpeg that actually records lives. From the
 * repository root on the host (the container has no `scripts/` directory until it is copied in):
 *
 *   docker exec -u 0 open-easyx mkdir -p /app/scripts
 *   docker cp scripts/live-proxy-e2e.ts open-easyx:/app/scripts/live-proxy-e2e.ts
 *   docker exec -w /app open-easyx npx tsx scripts/live-proxy-e2e.ts            # both scenarios
 *   docker exec -w /app open-easyx npx tsx scripts/live-proxy-e2e.ts fix        # one scenario
 *
 * A workstation's newer ffmpeg reconnects on a refused playlist by itself, so running this outside
 * the container hides the very defect it checks: the control case will not die. Use it there only
 * to check that the harness itself runs.
 *
 * `fetchUpstream` refuses internal address literals (SSRF guard), so the fixture uses public-looking
 * hostnames and routes them to loopback through the `request` fetch that `HlsProxy` accepts -- the
 * supported injection point, also used by the unit tests. No DNS, no /etc/hosts, no network.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HlsProxy } from "../server/hls-proxy.js";

type Scenario = "fix" | "control";
const OLD_HOST = "old.cdn.example.test";
const FRESH_HOST = "fresh.cdn.example.test";
const WINDOW = 3;
const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function makeFixture(): { dir: string; segments: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-proxy-e2e-"));
  // Enough content for the live window to keep sliding past the refusal and the repair.
  execFileSync("ffmpeg", ["-y", "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15", "-t", "180",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30",
    "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", path.join(dir, "seg.m3u8")], { stdio: "ignore" });
  return { dir, segments: fs.readdirSync(dir).filter((name) => name.endsWith(".ts")).length };
}

/** A live HLS source: the media-sequence window slides one segment per second. */
function liveSource(dir: string, segments: number, host: string, options: { offset: number; refuseAfter?: number }) {
  let cursor = options.offset;
  let playlistReads = 0;
  let refused = 0;
  const clock = setInterval(() => { cursor = Math.min(cursor + 1, segments - WINDOW); }, 1000);
  clock.unref?.();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname.endsWith(".m3u8")) {
      playlistReads += 1;
      if (options.refuseAfter !== undefined && playlistReads > options.refuseAfter) {
        refused += 1;
        response.writeHead(403, { "content-type": "text/plain" });
        return response.end("no");
      }
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", `#EXT-X-MEDIA-SEQUENCE:${cursor}`];
      // Absolute addresses matter: the proxy rewrites them against the upstream response base,
      // which is a loopback address in this fixture. Absolute URLs keep that base out of the loop.
      for (let index = cursor; index < cursor + WINDOW; index += 1) {
        lines.push("#EXTINF:2.000000,", `http://${host}/seg${index}.ts`);
      }
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      return response.end(lines.join("\n") + "\n");
    }
    const file = path.join(dir, path.basename(url.pathname));
    if (!fs.existsSync(file)) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { "content-type": "video/mp2t" });
    return response.end(fs.readFileSync(file));
  });
  return { server, stats: () => ({ playlistReads, refused }), stop: () => clearInterval(clock) };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no listener port"));
      resolve(address.port);
    });
  });
}

/** Map the minimal Fastify reply API that `serve()` uses onto a bare Node response. */
function replyShim(response: http.ServerResponse) {
  const shim: any = {
    status(code: number) { response.statusCode = code; return shim; },
    type(_value: string) { return shim; },
    header(key: string, value: string) { response.setHeader(key, value); return shim; },
    send(body: any) {
      if (body && typeof body.pipe === "function") { body.on("error", () => response.end()); body.pipe(response); return shim; }
      response.end(typeof body === "string" ? body : JSON.stringify(body));
      return shim;
    },
  };
  return shim;
}

async function runScenario(mode: Scenario, fixture: { dir: string; segments: number }) {
  const startedAt = Date.now();
  const ports = new Map<string, number>();
  const routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const port = ports.get(url.hostname);
    if (!port) throw new Error(`fixture has no route for ${url.hostname}`);
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  }) as typeof fetch;

  const oldSource = liveSource(fixture.dir, fixture.segments, OLD_HOST, { offset: 0, refuseAfter: 3 });
  const freshSource = liveSource(fixture.dir, fixture.segments, FRESH_HOST, { offset: 12 });
  ports.set(OLD_HOST, await listen(oldSource.server));
  ports.set(FRESH_HOST, await listen(freshSource.server));

  let refreshCalls = 0;
  let refreshLandedMs: number | null = null;
  const proxy = new HlsProxy(routedFetch);
  const tokenPath = proxy.register({ url: `http://${OLD_HOST}/old.m3u8` }, async () => {
    refreshCalls += 1;
    if (mode === "control") return undefined;
    await sleep(4000); // a real re-resolve shells out to the provider's extractor: measured 2-10 s
    refreshLandedMs = Date.now() - startedAt;
    return { url: `http://${FRESH_HOST}/new.m3u8`, headers: {} };
  }).replace("/api/live-cams/proxy/", "");

  const log: string[] = [];
  const front = http.createServer((request, response) => {
    // The rewritten playlist uses the app's real route; strip it the way the router does.
    const token = (request.url ?? "/").replace(/^\/api\/live-cams\/proxy\//, "").replace(/^\//, "").split("?")[0];
    const query = Object.fromEntries(new URL(request.url ?? "/", "http://127.0.0.1").searchParams);
    const range = typeof request.headers.range === "string" ? request.headers.range : undefined;
    void proxy.serve(token, replyShim(response), query, range,
      (message) => log.push(`${Date.now() - startedAt}ms ${message}`))
      .catch((error) => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); });
  });
  const frontPort = await listen(front);

  const out = path.join(fixture.dir, `capture-${mode}.ts`);
  // The input-side flags are copied verbatim from packages/live-capture.ts: a weaker setup would
  // not reproduce a playlist reload failure at all.
  const ffmpeg = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "info", "-y",
    "-reconnect", "1", "-reconnect_on_network_error", "1",
    "-reconnect_on_http_error", "403,5xx", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
    "-rw_timeout", "15000000",
    "-i", `http://127.0.0.1:${frontPort}/${tokenPath}`,
    "-c", "copy", "-f", "mpegts", out], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  ffmpeg.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const closed = new Promise<number | null>((resolve) => ffmpeg.once("close", (code) => resolve(code)));
  const killer = setTimeout(() => ffmpeg.kill("SIGKILL"), 40_000);

  const bytesAfter = (ms: number) => new Promise<number>((resolve) => setTimeout(() => {
    resolve(fs.existsSync(out) ? fs.statSync(out).size : 0);
  }, ms));
  // Sampled on either side of the repair: after the refusal, then well after the re-resolve.
  const early = await bytesAfter(14_000);
  const late = await bytesAfter(32_000);
  const exitCode = await Promise.race([closed, sleep(9000).then(() => null)]);
  clearTimeout(killer);
  if (exitCode === null) ffmpeg.kill("SIGKILL");

  const report = {
    mode,
    survived: exitCode === null,
    exitCode,
    elapsedMs: Date.now() - startedAt,
    playlist403: oldSource.stats().refused,
    refreshCalls,
    refreshLandedMs,
    bytesAt14s: early,
    bytesAt32s: late,
    grewAcrossRefusal: late > early,
    failedToReload: /Failed to reload playlist/.test(stderr),
    proxyLog: log.slice(0, 4),
    ffmpegTail: stderr.split(/\r?\n/).filter((line) => /Failed to reload|Error opening/.test(line)).slice(-3),
  };

  oldSource.stop();
  freshSource.stop();
  for (const server of [front, oldSource.server, freshSource.server]) {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close();
  }

  const ok = mode === "fix"
    ? report.survived && !report.failedToReload && report.grewAcrossRefusal && report.playlist403 >= 1 && refreshCalls === 1
    : !report.survived && report.failedToReload && !report.grewAcrossRefusal && report.playlist403 >= 1 && refreshCalls === 1;
  return { ok, report };
}

const requested = process.argv[2] as Scenario | undefined;
if (requested && !["fix", "control"].includes(requested)) {
  console.error("usage: live-proxy-e2e.ts [fix|control]");
  process.exit(2);
}
const fixture = makeFixture();
try {
  const results = [];
  for (const mode of (requested ? [requested] : ["fix", "control"] as Scenario[])) {
    results.push(await runScenario(mode, fixture));
  }
  for (const { ok, report } of results) console.log(`${ok ? "PASS" : "FAIL"} ${JSON.stringify(report)}`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
} finally {
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}
