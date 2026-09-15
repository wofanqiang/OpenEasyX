import fs from "node:fs";
import path from "node:path";

/** A live-capture child we may need to reap: ffmpeg/yt-dlp pulling from a network source
 *  and writing a `capture.ts` under the media volume. */
export interface OrphanProcess {
  pid: number;
  cmdline: string;
}

const NETWORK_INPUT = /(?:https?|rtmp|rtsp|mms):\/\/|\.m3u8\b/i;
const OUR_BINARY = /\b(?:ffmpeg|yt[-_]?dlp)\b/i;
// A10 segmented captures write capture_part000.ts... instead of one capture.ts.
const SEGMENT_OUTPUT = /capture_part\d+\.ts/i;

/**
 * True only for a *live capture* we started: it writes `capture.ts` (or its rolling
 * `capture_partNNN.ts` segments) while reading from a network source. Remux/thumbnail
 * ffmpeg also touch `capture.ts` but read it from disk (no network input), so they are
 * excluded — killing one of those would orphan a half-written mp4.
 */
export function isLiveCaptureCmdline(cmdline: string): boolean {
  const lower = cmdline.toLowerCase();
  if (!OUR_BINARY.test(lower)) return false;
  if (!lower.includes("capture.ts") && !SEGMENT_OUTPUT.test(lower)) return false;
  return NETWORK_INPUT.test(cmdline);
}

/** Extract the staging directory that owns a `capture.ts` (or capture_partNNN.ts) from a command line, or undefined. */
export function captureStagingDir(cmdline: string): string | undefined {
  const match = cmdline.match(/(\S*capture(?:\.ts|_part\d+\.ts))/i);
  if (!match) return undefined;
  const file = match[1];
  if (!path.isAbsolute(file)) return undefined;
  return path.dirname(path.resolve(file));
}

/** Linux-only: enumerate /proc/<pid>/cmdline for live-capture orphans. Non-Linux returns []. */
export function scanCaptureProcesses(_mediaRoot?: string): OrphanProcess[] {
  if (process.platform === "win32" || !fs.existsSync("/proc")) return [];
  const out: OrphanProcess[] = [];
  for (const pidStr of fs.readdirSync("/proc")) {
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let cmd = "";
    try {
      const buf = fs.readFileSync(path.join("/proc", pidStr, "cmdline"));
      cmd = buf.toString("utf8").split("\0").filter(Boolean).join(" ").trim();
    } catch {
      continue;
    }
    if (cmd && isLiveCaptureCmdline(cmd)) out.push({ pid, cmdline: cmd });
  }
  return out;
}

/** SIGTERM the whole process group, then SIGKILL any survivor after `timeoutMs`. */
export function killProcessGroup(pid: number, timeoutMs = 10_000): void {
  const deliver = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  deliver("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  const probe = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(probe);
      return;
    }
    if (Date.now() >= deadline) {
      deliver("SIGKILL");
      clearInterval(probe);
    }
  }, 200);
  if (typeof probe.unref === "function") probe.unref();
}

export type ReapMode = "off" | "log" | "kill";

export function reapModeFromEnv(fallback: ReapMode = "kill"): ReapMode {
  const raw = (process.env.EASYX_ORPHAN_REAP ?? "").toLowerCase().trim();
  if (raw === "off" || raw === "log" || raw === "kill") return raw;
  return fallback;
}

/**
 * Scan for and (in `kill` mode) terminate orphaned live-capture processes left behind by a
 * previous crash/OOM/SIGKILL. In `log` mode nothing is killed; the staging dirs of the
 * detected orphans are returned so the caller can avoid deleting files out from under them.
 * `scan`/`kill` are injectable for tests.
 */
export function reapOrphans(opts: {
  mode: ReapMode;
  scan?: () => OrphanProcess[];
  kill?: (pid: number) => void;
  log?: (level: string, scope: string, message: string, meta?: Record<string, unknown>) => void;
}): Set<string> {
  const protectedDirs = new Set<string>();
  if (opts.mode === "off") return protectedDirs;
  const scan = opts.scan ?? scanCaptureProcesses;
  const killFn = opts.kill ?? ((pid: number) => killProcessGroup(pid));
  const targets = scan();
  for (const target of targets) {
    const dir = captureStagingDir(target.cmdline);
    opts.log?.("warn", "download", `orphan capture process detected (pid ${target.pid}); reap mode=${opts.mode}`, {
      cmdline: target.cmdline.slice(0, 240),
    });
    if (opts.mode === "kill") {
      killFn(target.pid);
    } else if (dir) {
      protectedDirs.add(dir);
    }
  }
  if (targets.length) {
    opts.log?.("warn", "download", `reaped ${targets.length} orphan capture process(es) (mode=${opts.mode})`);
  }
  return protectedDirs;
}
