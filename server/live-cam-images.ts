import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LiveCam } from "../packages/plugin-sdk/index.js";
import { liveProfileImages, profileImageUrl } from "../plugins/live-profile-image.js";
import type { Database, Performer } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";

const run = promisify(execFile);

export class LiveCamImages {
  private pending = new Map<string, Promise<void>>();
  private retryAt = new Map<string, number>();
  private retrySignature = new Map<string, string>();
  private nextRequestAt = 0;
  private tail = Promise.resolve();
  constructor(private db: Database, private plugins: PluginManager, private directory: string) {}

  ensure(providerId: string, cam: LiveCam, performer: Performer): Promise<void> {
    const stableUrl = (value?: string) => { try { const url = new URL(value!); return `${url.origin}${url.pathname}`; } catch { return value; } };
    const signature = JSON.stringify([providerId, cam.online, stableUrl(cam.profileImageUrl), stableUrl(cam.thumbnailUrl)]);
    if (performer.imageUrl?.startsWith("/api/") || ((this.retryAt.get(performer.id) ?? 0) > Date.now() && this.retrySignature.get(performer.id) === signature)) return Promise.resolve();
    const pending = this.pending.get(performer.id); if (pending) return pending;
    const task = this.tail.then(async () => {
      const delay = this.nextRequestAt - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try { await this.store(providerId, cam, performer); }
      finally { this.nextRequestAt = Date.now() + 1_000; }
    }).catch(() => {
      this.retrySignature.set(performer.id, signature);
      this.retryAt.set(performer.id, Date.now() + 30 * 60_000);
    }).finally(() => this.pending.delete(performer.id));
    this.pending.set(performer.id, task); this.tail = task;
    return task;
  }

  private async store(providerId: string, cam: LiveCam, performer: Performer) {
    const context = this.plugins.context(providerId, AbortSignal.timeout(20_000));
    const candidates = await liveProfileImages(context, cam).catch(() => [] as string[]);
    const fallback = cam.online !== false ? profileImageUrl(cam.thumbnailUrl, cam.pageUrl) : undefined;
    if (fallback) candidates.push(fallback);
    // Preserve existing manually selected images, including edits while a fetch is in flight.
    const previous = performer.imageUrl;
    fs.mkdirSync(this.directory, { recursive: true });
    for (const url of new Set(candidates)) {
      const temporary = path.join(this.directory, `${performer.id}.download`);
      const converted = path.join(this.directory, `${performer.id}.tmp.jpg`);
      try {
        const response = await context.fetch(url, { headers: { referer: cam.pageUrl, "user-agent": "Mozilla/5.0" }, signal: context.signal });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("image/") || !response.body) continue;
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value: chunk, done } = await reader.read(); if (done) break;
            size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error("Profile image is too large");
            chunks.push(chunk);
          }
        } finally { await reader.cancel(); }
        fs.writeFileSync(temporary, Buffer.concat(chunks), { mode: 0o600 });
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file,pipe", "-i", temporary, "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease", converted], { timeout: 15_000 });
        const current = this.db.getPerformer(performer.id);
        if (!current || current.imageUrl !== previous) return;
        fs.renameSync(converted, path.join(this.directory, `${performer.id}.jpg`));
        this.db.updatePerformer(current.id, { name: current.name, aliases: current.aliases, imageUrl: `/api/performers/${current.id}/image` });
        return;
      } catch { /* A provider image can expire; try the next current image. */ }
      finally { fs.rmSync(temporary, { force: true }); fs.rmSync(converted, { force: true }); }
    }
    throw new Error("No provider portrait is currently available");
  }
}
