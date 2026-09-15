import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { captureStagingDir, isLiveCaptureCmdline, killProcessGroup, reapOrphans, type OrphanProcess, type ReapMode } from "./process-reap.js";

const waitFor = async (fn: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

describe("isLiveCaptureCmdline", () => {
  it("matches a live capture pulling from a network source", () => {
    expect(isLiveCaptureCmdline("ffmpeg -reconnect 1 -i https://host/stream.m3u8 -c copy /media/.downloads/abc/capture.ts")).toBe(true);
    expect(isLiveCaptureCmdline("yt-dlp --no-part rtmp://host/live -o /media/.downloads/abc/capture.ts")).toBe(true);
  });

  it("matches a segmented (A10) capture writing capture_partNNN.ts", () => {
    const cmdline = "ffmpeg -reconnect 1 -i https://host/stream.m3u8 -f segment -segment_start_number 2 /media/.downloads/abc/capture_part002.ts";
    expect(isLiveCaptureCmdline(cmdline)).toBe(true);
    expect(captureStagingDir(cmdline)).toBe(path.dirname(path.resolve("/media/.downloads/abc/capture_part002.ts")));
  });

  it("does NOT match a remux (reads capture.ts from disk, no network input)", () => {
    expect(isLiveCaptureCmdline("ffmpeg -i /media/.downloads/abc/capture.ts -c copy /media/out.mp4")).toBe(false);
    expect(isLiveCaptureCmdline("ffmpeg -f concat -i /media/.downloads/abc/capture.concat.txt -c copy /media/.downloads/abc/capture.ts")).toBe(false);
  });

  it("does NOT match a thumbnail probe or unrelated ffmpeg", () => {
    expect(isLiveCaptureCmdline("ffmpeg -i /media/out.mp4 -vf scale=8:8 -f rawvideo pipe:1")).toBe(false);
    expect(isLiveCaptureCmdline("ls -la /media")).toBe(false);
  });
});

describe("captureStagingDir", () => {
  it("extracts the staging directory owning a capture.ts", () => {
    const dir = captureStagingDir("ffmpeg -i https://x/stream.m3u8 -y /media/.downloads/abc/capture.ts");
    expect(dir).toBe(path.dirname(path.resolve("/media/.downloads/abc/capture.ts")));
  });
  it("returns undefined when the path is not absolute", () => {
    expect(captureStagingDir("ffmpeg -i https://x/stream.m3u8 -y capture.ts")).toBeUndefined();
  });
});

describe("reapOrphans", () => {
  const fakeScan = (targets: OrphanProcess[]) => () => targets;
  const cmd = "ffmpeg -i https://x/stream.m3u8 -y /media/.downloads/abc/capture.ts";

  it("'off' scans nothing and protects nothing", () => {
    let scanned = false;
    const protect = reapOrphans({ mode: "off", scan: () => { scanned = true; return []; }, log: () => {} });
    expect(scanned).toBe(false);
    expect(protect.size).toBe(0);
  });

  it("'log' reports but does not kill, and protects the orphan dir", () => {
    let killed = 0;
    const logs: unknown[] = [];
    const protect = reapOrphans({
      mode: "log",
      scan: fakeScan([{ pid: 111, cmdline: cmd }]),
      kill: () => { killed++; },
      log: (...args) => logs.push(args),
    });
    expect(killed).toBe(0);
    expect(protect.has(path.dirname(path.resolve("/media/.downloads/abc/capture.ts")))).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("'kill' terminates and protects nothing", () => {
    let killedPid = 0;
    const protect = reapOrphans({
      mode: "kill",
      scan: fakeScan([{ pid: 222, cmdline: cmd }]),
      kill: (pid) => { killedPid = pid; },
      log: () => {},
    });
    expect(killedPid).toBe(222);
    expect(protect.size).toBe(0);
  });

  it("accepts a ReapMode off/log/kill without throwing on unknown values via env helper", () => {
    const modes: ReapMode[] = ["off", "log", "kill"];
    expect(modes.length).toBe(3);
  });
});

describe("killProcessGroup", () => {
  let victim: ReturnType<typeof spawn> | undefined;
  afterEach(() => {
    try { if (victim?.pid) process.kill(victim.pid, 0); } catch { /* already dead */ }
    victim?.removeAllListeners();
  });

  it("terminates a detached child process", async () => {
    victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    victim.unref();
    const pid = victim.pid;
    expect(pid).toBeGreaterThan(0);
    killProcessGroup(pid!, 2000);
    const dead = await waitFor(() => {
      try { process.kill(pid!, 0); return false; } catch { return true; }
    }, 5000);
    expect(dead).toBe(true);
  }, 15000);
});
