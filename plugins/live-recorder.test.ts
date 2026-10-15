import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_RECORDER_SCRIPT, retryDelay } from "./live-recorder.js";
const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
async function fixture(mode: "merge" | "stop" | "cancel" | "finite" | "refresh") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-recorder-'quoted-")); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const sample = path.join(root, "sample.ts");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10", "-t", "0.5", "-c:v", "libx264", "-f", "mpegts", sample]);
  const ffmpeg = execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  // Controlled stream endings; real FFmpeg remuxes the captured MPEG-TS parts.
  fs.writeFileSync(path.join(bin, "ffmpeg"), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args.includes('concat')){const result=spawnSync(${JSON.stringify(ffmpeg)},args,{stdio:'inherit'});process.exit(result.status??1)}fs.appendFileSync(${JSON.stringify(path.join(root, "inputs.txt"))}, args[args.indexOf('-i')+1]+'\\n');fs.copyFileSync(${JSON.stringify(sample)},args.at(-1));if(${JSON.stringify(mode)}==='stop'||${JSON.stringify(mode)}==='cancel'){setInterval(()=>{},1000);process.on('SIGINT',()=>process.exit(0))}`);
  fs.chmodSync(path.join(bin, "ffmpeg"), 0o755);
  const output = path.join(root, "output.mp4");
  const server = http.createServer((request, response) => {
    if (request.url === "/streamInfo") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ cdnURL: `http://${request.headers.host}/second.m3u8` })); return; }
    const firstEnded = mode === "refresh" && request.url === "/live.m3u8" && fs.existsSync(path.join(root, "live-parts", "part-001.ts"));
    const second = fs.existsSync(path.join(root, "live-parts", "part-002.ts"));
    response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1\nsegment.ts\n" + ((second || firstEnded || mode === "finite") ? "#EXT-X-ENDLIST\n" : ""));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); cleanup.push(() => server.close());
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/live.m3u8`;
  const child = spawn(process.execPath, ["-e", LIVE_RECORDER_SCRIPT, url, url, "{}", output, "300", "20", "Test", ...(mode === "refresh" ? [`http://127.0.0.1:${address.port}/streamInfo`, "cdnURL"] : [])], { detached: true, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  cleanup.push(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
  const finished = once(child, "close"); let logs = ""; child.stderr.on("data", (chunk) => { logs += chunk; });
  return { root, output, child, finished, logs: () => logs };
}
describe("segmented live recorder", () => {
  it("joins two public stretches into a playable MP4, including paths containing apostrophes", async () => {
    const f = await fixture("merge"); expect((await f.finished)[0], f.logs()).toBe(0);
    const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f.output], { encoding: "utf8" }));
    expect(duration).toBeGreaterThan(.7); expect(f.logs()).toContain("joined 2 parts");
    expect(fs.existsSync(path.join(f.root, "live-parts"))).toBe(false);
  }, 10_000);
  it("refreshes the room address when CAM4 returns on a different stream", { timeout: 10_000 }, async () => {
    const f = await fixture("refresh"); expect((await f.finished)[0], f.logs()).toBe(0);
    const inputs = fs.readFileSync(path.join(f.root, "inputs.txt"), "utf8").trim().split("\n");
    expect(inputs).toHaveLength(2); expect(inputs[0]).toContain("/live.m3u8"); expect(inputs[1]).toContain("/second.m3u8");
    expect(f.logs()).toContain("joined 2 parts");
    const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f.output], { encoding: "utf8" }));
    expect(duration).toBeGreaterThan(.7);
  });
  it("does not resume a finite playlist", async () => {
    const f = await fixture("finite"); expect((await f.finished)[0], f.logs()).toBe(0);
    expect(f.logs()).not.toContain("continuing the recording"); expect(fs.statSync(f.output).size).toBeGreaterThan(0);
  }, 10_000);
  it.each(["stop", "cancel"] as const)("handles process-group %s without orphaning the encoder", async (mode) => {
    const f = await fixture(mode); const deadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(f.root, "live-parts", "part-001.ts"))) {
      if (Date.now() > deadline) throw new Error(f.logs());
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(-f.child.pid!, mode === "stop" ? "SIGINT" : "SIGTERM");
    expect((await f.finished)[0], f.logs()).toBe(mode === "stop" ? 0 : 143);
    expect(fs.existsSync(f.output)).toBe(mode === "stop");
    expect(fs.existsSync(path.join(f.root, "live-parts"))).toBe(false);
  }, 10_000);
  it("cancels a pending resolver retry immediately", async () => {
    const controller = new AbortController(); const pending = retryDelay(10_000, controller.signal);
    controller.abort(new Error("Stopped")); await expect(pending).rejects.toThrow("Stopped");
  });
});
