import { describe, expect, it } from "vitest";
import { runDiagnostics, type DiagnosticsOptions } from "./diagnostics.js";
import type { OrphanProcess } from "./process-reap.js";

const ORPHAN: OrphanProcess = { pid: 4242, cmdline: "ffmpeg -i https://live.example/index.m3u8" };

function fakeDb(opts: { statuses?: Array<{ status: string; n: number }>; stuck?: Array<Record<string, string>>; minFreeDiskGb?: number } = {}) {
  return {
    getSettings: () => ({ minFreeDiskGb: opts.minFreeDiskGb ?? 1 }),
    sqlite: {
      prepare: (sql: string) => ({
        all: () => (sql.includes("GROUP BY status") ? (opts.statuses ?? []) : (opts.stuck ?? [])),
      }),
    },
  } as unknown as DiagnosticsOptions["db"];
}

function fakePlugins(entries: Array<{ id: string; name: string; test?: (ctx: unknown) => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string } }>) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    list: () => entries.map((entry) => ({ manifest: { id: entry.id, name: entry.name }, installed: true, enabled: true, config: {} })),
    ensureConfigured: () => undefined,
    get: (pluginId: string) => ({ testConnection: byId.get(pluginId)?.test }),
    context: () => ({ config: {} }),
  } as unknown as DiagnosticsOptions["plugins"];
}

function base(overrides: Partial<DiagnosticsOptions> = {}): DiagnosticsOptions {
  return {
    db: fakeDb(),
    plugins: fakePlugins([]),
    mediaRoot: "/media",
    activePids: () => [],
    binaryVersion: async (binary) => `${binary} version 7.0`,
    diskUsage: async () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }),
    probeWrite: () => undefined,
    scanOrphans: () => [],
    ...overrides,
  };
}

describe("runDiagnostics", () => {
  it("reports every check as ok on a healthy system", async () => {
    const report = await runDiagnostics(base());
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual(["disk", "ffmpeg", "ffprobe", "media-dir", "queue", "orphans"]);
  });

  it("fails the report on low disk, an unreachable plugin, stuck items and stray processes", async () => {
    const report = await runDiagnostics(base({
      db: fakeDb({
        statuses: [{ status: "downloading", n: 1 }, { status: "failed", n: 2 }],
        stuck: [{ id: "item-1", title: "Stuck capture", status: "downloading", updated_at: "2026-09-15T00:00:00.000Z" }],
      }),
      diskUsage: async () => ({ totalBytes: 100 * 1024 ** 3, freeBytes: 512 * 1024 ** 2 }),
      plugins: fakePlugins([{ id: "superchatlive", name: "SuperChat Live", test: async () => ({ ok: false, message: "login expired" }) }]),
      scanOrphans: () => [ORPHAN],
    }));
    expect(report.ok).toBe(false);
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get("disk")?.ok).toBe(false);
    expect(byId.get("disk")?.detail).toContain("below the 1 GB floor");
    expect(byId.get("plugin:superchatlive")?.ok).toBe(false);
    expect(byId.get("plugin:superchatlive")?.detail).toBe("login expired");
    expect(byId.get("queue")?.ok).toBe(false);
    expect(byId.get("queue")?.detail).toContain("Stuck capture");
    expect(byId.get("orphans")?.ok).toBe(false);
    expect(byId.get("orphans")?.detail).toContain("4242");
  });

  it("never mistakes a capture this process owns for an orphan, and isolates one failing check", async () => {
    let ffmpegProbeCalls = 0;
    const report = await runDiagnostics(base({
      activePids: () => [4242],
      scanOrphans: () => [ORPHAN],
      binaryVersion: async (binary) => {
        if (binary === "ffprobe") { ffmpegProbeCalls++; throw new Error("spawn ffprobe ENOENT"); }
        return `${binary} version 7.0`;
      },
    }));
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get("orphans")?.ok).toBe(true);
    expect(byId.get("orphans")?.detail).toBe("None");
    expect(ffmpegProbeCalls).toBe(1);
    expect(byId.get("ffprobe")?.ok).toBe(false);
    expect(report.ok).toBe(false);
    // The isolated ffprobe failure must not have swallowed the disk and queue checks.
    expect(byId.get("disk")?.ok).toBe(true);
    expect(byId.get("queue")?.ok).toBe(true);
  });
});
