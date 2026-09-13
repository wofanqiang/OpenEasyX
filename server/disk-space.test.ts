import { describe, expect, it } from "vitest";
import { GIB, recordingDiskGuard } from "./disk-space.js";

const gb = (value: number) => value * GIB;

describe("recordingDiskGuard", () => {
  it("pauses below the 1 GB default and clears above it", async () => {
    expect((await recordingDiskGuard({}, "/media", async () => gb(0.4))).paused).toBe(true);
    expect((await recordingDiskGuard({}, "/media", async () => gb(1))).paused).toBe(false);
    expect((await recordingDiskGuard({}, "/media", async () => gb(9))).paused).toBe(false);
  });

  it("honours a configured floor with no upper bound", async () => {
    const settings = { minFreeDiskGb: 250 };
    expect((await recordingDiskGuard(settings, "/media", async () => gb(249))).paused).toBe(true);
    expect((await recordingDiskGuard(settings, "/media", async () => gb(251))).paused).toBe(false);
  });

  it("never pauses when the floor is zero or the probe fails", async () => {
    // 0 disables the guard outright; a broken probe must not stop every recording.
    expect((await recordingDiskGuard({ minFreeDiskGb: 0 }, "/media", async () => 0)).paused).toBe(false);
    expect((await recordingDiskGuard({}, "/media", async () => undefined)).paused).toBe(false);
  });

  it("falls back to the default floor for values that are not numbers", async () => {
    expect((await recordingDiskGuard({ minFreeDiskGb: "wide" }, "/media", async () => gb(0.9))).paused).toBe(true);
  });

  it("reports how much room is left so the pause is explainable", async () => {
    const guard = await recordingDiskGuard({}, "/media", async () => gb(0.5));
    expect(guard.freeGb).toBeCloseTo(0.5, 5);
    expect(guard.thresholdGb).toBe(1);
  });

  it("probes the media root it is given", async () => {
    const seen: string[] = [];
    await recordingDiskGuard({}, "/srv/media", async (directory) => { seen.push(directory); return gb(4); });
    expect(seen).toEqual(["/srv/media"]);
  });
});
