import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Database } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";
import { scanCaptureProcesses, type OrphanProcess } from "./process-reap.js";

const asyncExecFile = promisify(execFile);

export type DiagnosticCheck = { id: string; label: string; ok: boolean; detail: string };
export type DiagnosticsReport = { ranAt: string; ok: boolean; checks: DiagnosticCheck[] };

export type DiagnosticsOptions = {
  db: Database;
  plugins: PluginManager;
  mediaRoot: string;
  /** Process ids of ffmpeg children this process owns, so live captures are not mistaken for strays. */
  activePids: () => number[];
  /** Injectable so tests can run without ffmpeg on PATH, without a real filesystem and without /proc. */
  binaryVersion?: (binary: string) => Promise<string>;
  diskUsage?: (directory: string) => Promise<{ totalBytes: number; freeBytes: number } | undefined>;
  /** Injectable so tests never touch the real filesystem: default writes and removes a probe file. */
  probeWrite?: (directory: string) => void;
  scanOrphans?: (mediaRoot?: string) => OrphanProcess[];
  pluginTimeoutMs?: number;
  /** A download whose status has not advanced for this long counts as stuck. */
  stuckAfterMs?: number;
};

const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

async function defaultBinaryVersion(binary: string): Promise<string> {
  const { stdout } = await asyncExecFile(binary, ["-version"], { timeout: 10_000 });
  return stdout.split("\n")[0]?.trim() ?? "";
}

async function defaultDiskUsage(directory: string): Promise<{ totalBytes: number; freeBytes: number } | undefined> {
  try {
    const stats = fs.statfsSync(directory);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return undefined;
  }
}

/**
 * One pass over everything a recording depends on: disk floor, ffmpeg tools, media directory
 * permissions, plugin connectivity, queue health and stray capture processes. Every check is
 * isolated -- one failure must never abort the report, because the point of the page is to
 * answer "what exactly is broken" in a single click.
 */
export async function runDiagnostics(options: DiagnosticsOptions): Promise<DiagnosticsReport> {
  const { db, plugins, mediaRoot, activePids } = options;
  const binaryVersion = options.binaryVersion ?? defaultBinaryVersion;
  const diskUsage = options.diskUsage ?? defaultDiskUsage;
  const scanOrphans = options.scanOrphans ?? scanCaptureProcesses;
  const pluginTimeoutMs = options.pluginTimeoutMs ?? 10_000;
  const stuckAfterMs = options.stuckAfterMs ?? 15 * 60_000;
  const checks: DiagnosticCheck[] = [];

  // 1. Media disk free space against the configured floor the disk guard enforces.
  const minFreeGb = Math.max(0, Number(db.getSettings().minFreeDiskGb ?? 1));
  const usage = await diskUsage(mediaRoot);
  if (usage && usage.totalBytes > 0) {
    const usedPercent = Math.round(((usage.totalBytes - usage.freeBytes) / usage.totalBytes) * 100);
    const low = usage.freeBytes <= minFreeGb * 1024 ** 3;
    checks.push({
      id: "disk", label: "Media disk", ok: !low,
      detail: `${formatGb(usage.freeBytes)} free of ${formatGb(usage.totalBytes)} (${usedPercent}% used)${low ? ` · below the ${minFreeGb} GB floor` : ""}`,
    });
  } else {
    checks.push({ id: "disk", label: "Media disk", ok: false, detail: "Free space on the media disk could not be determined" });
  }

  // 2. ffmpeg / ffprobe must exist and print a version.
  for (const binary of ["ffmpeg", "ffprobe"]) {
    try {
      const version = await binaryVersion(binary);
      checks.push({ id: binary, label: binary, ok: version.length > 0, detail: version || "The binary ran but printed no version" });
    } catch (error) {
      checks.push({ id: binary, label: binary, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // 3. The media directory must accept and remove a file.
  const probeWrite = options.probeWrite ?? ((directory: string) => {
    const probe = path.join(directory, `.diagnostics-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "open easyx diagnostics probe", { mode: 0o600 });
    fs.rmSync(probe, { force: true });
  });
  try {
    probeWrite(mediaRoot);
    checks.push({ id: "media-dir", label: "Media directory", ok: true, detail: `${mediaRoot} is writable` });
  } catch (error) {
    checks.push({ id: "media-dir", label: "Media directory", ok: false, detail: `${mediaRoot} is not writable: ${error instanceof Error ? error.message : String(error)}` });
  }

  // 4. Every installed and enabled plugin gets the same connectivity test the plugins page uses,
  //    each under its own timeout so one slow provider cannot stall the whole report.
  const installed = plugins.list().filter((entry) => entry.installed && entry.enabled);
  await Promise.all(installed.map(async (entry) => {
    let ok = true;
    let detail = "Ready. This plugin validates each configured source URL when scraping starts.";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      plugins.ensureConfigured(entry.manifest.id);
      const plugin = plugins.get(entry.manifest.id, false);
      if (plugin.testConnection) {
        const result = await Promise.race([
          Promise.resolve(plugin.testConnection(plugins.context(entry.manifest.id))),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(pluginTimeoutMs / 1000)}s`)), pluginTimeoutMs);
            if (typeof timer === "object" && "unref" in timer) timer.unref();
          }),
        ]);
        const answer = result as { ok?: boolean; message?: string };
        ok = answer.ok !== false;
        detail = String(answer.message ?? (ok ? "Connected" : "The plugin reported a problem"));
      }
    } catch (error) {
      ok = false;
      detail = error instanceof Error ? error.message : String(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
    checks.push({ id: `plugin:${entry.manifest.id}`, label: `Plugin: ${entry.manifest.name}`, ok, detail });
  }));

  // 5. Queue health: status totals, plus downloads whose status has been frozen for a while.
  try {
    const rows = db.sqlite.prepare("SELECT status, COUNT(*) AS n FROM items GROUP BY status").all() as Array<{ status: string; n: number }>;
    const counts = new Map(rows.map((row) => [row.status, Number(row.n)]));
    const cutoff = new Date(Date.now() - stuckAfterMs).toISOString();
    const stuck = db.sqlite.prepare("SELECT id,title,status,updated_at FROM items WHERE status IN ('downloading','stopping','cancelling','paused') AND updated_at<=? ORDER BY updated_at LIMIT 5")
      .all(cutoff) as Array<{ id: string; title: string; status: string; updated_at: string }>;
    const summary = ["queued", "downloading", "paused", "failed", "completed"]
      .filter((status) => (counts.get(status) ?? 0) > 0)
      .map((status) => `${counts.get(status)} ${status}`)
      .join(" · ") || "no items";
    checks.push({
      id: "queue", label: "Download queue", ok: stuck.length === 0,
      detail: stuck.length === 0 ? summary
        : `${summary} · ${stuck.length} stuck (no progress for ${Math.round(stuckAfterMs / 60_000)} min, e.g. "${stuck[0].title || stuck[0].id}" since ${stuck[0].updated_at})`,
    });
  } catch (error) {
    checks.push({ id: "queue", label: "Download queue", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  // 6. Stray capture processes: live-capture ffmpeg commands on this host that this process does
  //    not own -- the crash leftovers that keep consuming CPU and disk if nobody reaps them.
  try {
    const owned = new Set(activePids());
    const orphans = scanOrphans(mediaRoot).filter((orphan) => !owned.has(orphan.pid));
    checks.push({
      id: "orphans", label: "Orphan capture processes", ok: orphans.length === 0,
      detail: orphans.length === 0 ? "None" : `${orphans.length} stray ffmpeg process(es) still writing to staging (pids ${orphans.slice(0, 5).map((orphan) => orphan.pid).join(", ")})`,
    });
  } catch (error) {
    checks.push({ id: "orphans", label: "Orphan capture processes", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  return { ranAt: new Date().toISOString(), ok: checks.every((check) => check.ok), checks };
}
