import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "./catalog.js";
import { LibraryDatabase } from "./library-database.js";

const cleanups: Array<() => unknown> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/**
 * The library never opened a file during a scan, so a recording nobody had played or previewed
 * reported no runtime: an empty card, and a "total available runtime" figure that silently counted
 * only the videos someone happened to open. Measured on a live box: 12 of 33 files, 68 GB of
 * multi-hour recordings, all reported as zero.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-catalog-runtime-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, "media"), dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(mediaRoot, "Performer", "example.test"), { recursive: true });
  const file = path.join(mediaRoot, "Performer", "example.test", "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=64x64:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file]);
  const libraryDb = new LibraryDatabase(dataDir); cleanups.push(() => libraryDb.close());
  const catalog = new Catalog(libraryDb, mediaRoot, dataDir, false);
  return { mediaRoot, dataDir, file, libraryDb, catalog };
}

describe("library runtimes", () => {
  it("fills in the runtime a scan could not know", async () => {
    const { libraryDb, catalog } = fixture();
    await catalog.scan();
    const indexed = libraryDb.listMedia().items;
    expect(indexed).toHaveLength(1);
    // Indexing never opens the file, so the row starts without a runtime.
    expect(indexed[0].duration).toBe(0);
    await catalog.backfillDurations();
    const items = libraryDb.listMedia().items;
    expect(items[0].duration).toBeGreaterThan(1.5);
    expect(items[0].width).toBe(64);
  }, 30_000);

  it("leaves a readable file alone on the next pass", async () => {
    const { libraryDb, catalog } = fixture();
    await catalog.scan();
    await catalog.backfillDurations();
    const before = libraryDb.listMedia().items[0].duration;
    await catalog.backfillDurations();
    expect(libraryDb.listMedia().items[0].duration).toBe(before);
    // Nothing left to inspect: the query that drives the pass must come back empty.
    expect(libraryDb.mediaWithoutRuntime()).toHaveLength(0);
  }, 30_000);
});
