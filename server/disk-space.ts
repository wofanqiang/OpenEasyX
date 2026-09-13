import fs from "node:fs";

/** Bytes in a gibibyte. The setting is labelled GB; the guard compares against 1024^3. */
export const GIB = 1024 ** 3;

export type FreeSpaceProbe = (directory: string) => Promise<number | undefined>;

/**
 * Free bytes available to this process on the filesystem holding `directory`.
 * Returns undefined when the probe fails, so callers can fail open instead of
 * stopping every recording because a single statfs call went wrong.
 */
export async function freeBytes(directory: string): Promise<number | undefined> {
  try {
    const stats = await fs.promises.statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

export type DiskGuard = { paused: boolean; freeGb?: number; thresholdGb: number };

/**
 * Whether auto-record should stop opening new recordings because the disk that holds them
 * is nearly full. A full disk does not fail loudly: the capture keeps writing until ffmpeg
 * dies, so the floor has to be enforced before a recording is queued.
 *
 * Only auto-record is gated on this. A manual recording is an explicit decision by the
 * user and stays available even below the floor.
 */
export async function recordingDiskGuard(
  settings: Record<string, unknown>,
  mediaRoot: string,
  probe: FreeSpaceProbe = freeBytes,
  defaultThresholdGb = 1,
): Promise<DiskGuard> {
  const raw = Number(settings.minFreeDiskGb);
  const thresholdGb = Number.isFinite(raw) ? Math.max(0, raw) : defaultThresholdGb;
  if (thresholdGb <= 0) return { paused: false, thresholdGb };
  const free = await probe(mediaRoot);
  if (free === undefined) return { paused: false, thresholdGb };
  return { paused: free < thresholdGb * GIB, freeGb: free / GIB, thresholdGb };
}
