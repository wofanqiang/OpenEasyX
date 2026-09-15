import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LiveCam } from "../packages/plugin-sdk/index.js";
import { liveProfileImages, profileImageUrl } from "../plugins/live-profile-image.js";
import type { Database, Performer } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";

const run = promisify(execFile);

const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

/**
 * Portrait URLs come from provider listings and room metadata, which means somebody who
 * controls a listing can point them at addresses the server can reach but the caller
 * cannot -- cloud metadata endpoints, the Docker bridge, anything on the private network.
 * Reject non-web protocols, reserved IP literals and obvious internal host names. This
 * cannot stop DNS rebinding on its own, which is why redirects are resolved by hand
 * below so every hop is checked the same way.
 */
export function isSafeImageUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  if (host.startsWith("::ffff:")) return isSafeImageUrl(`${url.protocol}//${host.slice(7)}`);
  if (host === "::1" || host === "::") return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]); const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return false;          // "this" network, private, loopback
    if (a === 172 && b >= 16 && b <= 31) return false;           // private 172.16/12
    if (a === 192 && b === 168) return false;                    // private 192.168/16
    if (a === 169 && b === 254) return false;                    // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return false;          // carrier-grade NAT
    if (a >= 224) return false;                                  // multicast and reserved
    return true;
  }
  // IPv6 literals: block loopback, unique-local, link-local and multicast.
  if (/^[a-f0-9:]+$/.test(host) && /^(::1|fc|fd|fe[89ab]|ff)/.test(host)) return false;
  return true;
}

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

  /** Fetches without automatic redirects, so every hop passes isSafeImageUrl(). */
  private async fetchChecked(context: { fetch: typeof fetch; signal?: AbortSignal }, url: string, init: RequestInit): Promise<Response> {
    let current = url;
    for (let hop = 0; hop < 3; hop++) {
      if (!isSafeImageUrl(current)) throw new Error("Refusing to fetch an image from a non-public address");
      const response = await context.fetch(current, { ...init, redirect: "manual", signal: context.signal });
      const status = response.status;
      if (status < 300 || status > 399) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      current = new URL(location, current).toString();
    }
    throw new Error("Too many redirects while fetching a portrait");
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
      if (!isSafeImageUrl(url)) continue;
      try {
        const response = await this.fetchChecked(context, url, { headers: { referer: cam.pageUrl, "user-agent": "Mozilla/5.0" } });
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
