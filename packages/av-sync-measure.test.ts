import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { avSyncPlan, createAvSyncWatcher, readAvSyncSidecar } from "./av-sync-measure.js";

function stderrLine(url: string): string {
  return `[hls @ 0xabc] Opening '${url}' for reading\n`;
}

describe("avSyncPlan", () => {
  it("derives a plan from a dual-input capture command", () => {
    const plan = avSyncPlan(
      ["-loglevel", "info", "-i", "https://cdn.test/v.m3u8", "-i", "https://cdn.test/a.m3u8", "-c", "copy"],
      "/tmp/item_1",
    );
    expect(plan).toEqual({
      videoPlaylist: "https://cdn.test/v.m3u8",
      audioPlaylist: "https://cdn.test/a.m3u8",
      headerArg: undefined,
      sidecarPath: join("/tmp/item_1", "capture.ts.avsync.json"),
    });
  });

  it("is undefined for single-input captures", () => {
    expect(avSyncPlan(["-i", "https://cdn.test/v.m3u8", "-c", "copy"], "/tmp/item_1")).toBeUndefined();
  });
});

describe("createAvSyncWatcher", () => {
  it("writes the sidecar with the measured audio shift from the first opened segments", () => {
    const dir = mkdtempSync(join(tmpdir(), "avsync-"));
    try {
      const plan = { videoPlaylist: "https://x/v.m3u8", audioPlaylist: "https://x/a.m3u8", sidecarPath: join(dir, "capture.ts.avsync.json") };
      const video = new Map([["https://x/seg_v1.m4s", 100.0], ["https://x/seg_v2.m4s", 101.664]]);
      const audio = new Map([["https://x/seg_a1.m4s", 101.5], ["https://x/seg_a2.m4s", 103.1]]);
      const watcher = createAvSyncWatcher(video, audio, plan);
      // Playlists and init sections are opened too; only media segments count.
      watcher.onStderr("config lines\n" + stderrLine("https://x/init_v.m4s") + stderrLine("https://x/seg_v1.m4s"));
      watcher.onStderr(stderrLine("https://x/seg_a1.m4s") + "more noise\n");
      const sidecar = JSON.parse(readFileSync(plan.sidecarPath, "utf8")) as { audioShiftSec: number };
      // Audio first segment PDT (101.5) - video first segment PDT (100.0) = +1.5s
      expect(sidecar.audioShiftSec).toBe(1.5);
      watcher.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips segment URIs that both playlists share instead of guessing", () => {
    const dir = mkdtempSync(join(tmpdir(), "avsync-"));
    try {
      const plan = { videoPlaylist: "https://x/v.m3u8", audioPlaylist: "https://x/a.m3u8", sidecarPath: join(dir, "capture.ts.avsync.json") };
      const shared = new Map([["https://x/seg_both.m4s", 100.0]]);
      const watcher = createAvSyncWatcher(new Map(shared), new Map(shared), plan);
      watcher.onStderr(stderrLine("https://x/seg_both.m4s"));
      expect(() => readFileSync(plan.sidecarPath)).toThrow();
      watcher.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readAvSyncSidecar", () => {
  const dir = mkdtempSync(join(tmpdir(), "avsync-"));
  const sidecar = join(dir, "capture.ts.avsync.json");

  it("accepts a sane measured shift", () => {
    writeFileSync(sidecar, JSON.stringify({ audioShiftSec: 2.317 }));
    expect(readAvSyncSidecar(sidecar)).toBe(2.317);
  });

  it("rejects noise, absurd values and missing files", () => {
    writeFileSync(sidecar, JSON.stringify({ audioShiftSec: 0.05 }));
    expect(readAvSyncSidecar(sidecar)).toBeUndefined();
    writeFileSync(sidecar, JSON.stringify({ audioShiftSec: 120 }));
    expect(readAvSyncSidecar(sidecar)).toBeUndefined();
    writeFileSync(sidecar, "not json");
    expect(readAvSyncSidecar(sidecar)).toBeUndefined();
    expect(readAvSyncSidecar(join(dir, "missing.avsync.json"))).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
