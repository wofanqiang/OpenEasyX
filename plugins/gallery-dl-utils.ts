import { oldestMediaDate as oldestDate } from "../packages/media-date.js";
import type { CommandDownloadRequest, MediaCandidate, PluginContext } from "../packages/plugin-sdk/index.js";
import { positiveInteger } from "./yt-dlp-utils.js";

type GalleryMessage = [number, ...unknown[]];
type GalleryRecord = Record<string, unknown>;

export type GalleryPlatform = "facebook" | "fansly" | "instagram" | "patreon" | "tiktok" | "tumblr" | "twitter";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function galleryArgs(config: Record<string, unknown>, platform: GalleryPlatform): string[] {
  const args = ["--config-ignore"];
  const cookiesFile = text(config.cookiesFile);
  if (cookiesFile) args.push("--cookies", cookiesFile);
  if (platform === "fansly") {
    const token = text(config.token);
    if (token) args.push("-o", `extractor.fansly.token=${token}`);
  }
  if (platform === "tiktok") {
    args.push(
      "-o", "extractor.tiktok.browser=chrome",
      "-o", "extractor.tiktok.retries=0",
      "-o", "extractor.tiktok.audio=false",
      "-o", "extractor.tiktok.covers=false",
    );
  }
  return args;
}

export async function testGalleryDl(context: PluginContext, label: string): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await context.runCommand("gallery-dl", ["--version"], { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 });
    const version = result.stdout.trim();
    return result.exitCode === 0
      ? { ok: true, message: `${label} extractor is ready (gallery-dl ${version || "installed"}).` }
      : { ok: false, message: `gallery-dl exited with code ${result.exitCode}: ${(result.stderr || result.stdout).trim()}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function parseMessages(output: string): Array<{ url: string; metadata: GalleryRecord }> {
  let messages: GalleryMessage[];
  try { messages = JSON.parse(output) as GalleryMessage[]; }
  catch { throw new Error("gallery-dl returned invalid JSON metadata"); }
  if (!Array.isArray(messages)) throw new Error("gallery-dl returned an unexpected metadata document");
  const records: Array<{ url: string; metadata: GalleryRecord }> = [];
  const errors: string[] = [];
  for (const message of messages) {
    if (Array.isArray(message) && message[0] === -1 && message[1] && typeof message[1] === "object") {
      const failure = message[1] as GalleryRecord;
      errors.push(text(failure.message) ?? text(failure.error) ?? "gallery-dl extraction failed");
      continue;
    }
    if (!Array.isArray(message) || message[0] !== 3 || typeof message[1] !== "string" || !message[1]) continue;
    const metadata = message[2];
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    records.push({ url: message[1], metadata: metadata as GalleryRecord });
  }
  if (!records.length && errors.length) throw new Error(errors.join("; "));
  return records;
}

function mediaType(extension: string, metadata: GalleryRecord): MediaCandidate["mediaType"] {
  const kind = text(metadata.type) ?? text((metadata.file as GalleryRecord | undefined)?.type);
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (["jpg", "jpeg", "png", "gif", "webp", "avif"].includes(extension)) return "image";
  if (["mp4", "m4v", "mov", "webm", "mkv", "ts"].includes(extension)) return "video";
  return "other";
}

function stablePage(platform: GalleryPlatform, metadata: GalleryRecord, sourceUrl: string): string {
  const postUrl = text(metadata.post_url) ?? text(metadata.url_post) ?? text(metadata.permalink_url) ?? text(metadata.permalink);
  if (postUrl && /^https?:\/\//i.test(postUrl)) return postUrl;
  const id = scalar(metadata.post_id) ?? scalar(metadata.tweet_id) ?? scalar(metadata.id);
  if (!id) return sourceUrl;
  switch (platform) {
    case "facebook": return ["mp4", "m4v", "mov", "webm"].includes(text(metadata.extension)?.toLowerCase() ?? "") ? `https://www.facebook.com/watch/?v=${id}` : `https://www.facebook.com/photo/?fbid=${id}`;
    case "fansly": return `https://fansly.com/post/${id}`;
    case "instagram": {
      const shortcode = scalar(metadata.post_shortcode) ?? scalar(metadata.shortcode);
      return shortcode ? `https://www.instagram.com/p/${shortcode}/` : sourceUrl;
    }
    case "patreon": return `https://www.patreon.com/posts/${id}`;
    case "tiktok": {
      const username = scalar(metadata.username) ?? scalar((metadata.author as GalleryRecord | undefined)?.uniqueId);
      return username ? `https://www.tiktok.com/@${username}/video/${id}` : sourceUrl;
    }
    case "tumblr": {
      const blog = scalar(metadata.blog_name) ?? scalar(metadata.blog);
      return blog ? `https://www.tumblr.com/${blog}/${id}` : sourceUrl;
    }
    case "twitter": {
      const user = scalar(metadata.author_name) ?? scalar(metadata.username) ?? scalar((metadata.author as GalleryRecord | undefined)?.name);
      return user ? `https://x.com/${user}/status/${id}` : `https://x.com/i/web/status/${id}`;
    }
  }
}

export async function listGalleryMedia(context: PluginContext, sourceUrl: string, platform: GalleryPlatform): Promise<MediaCandidate[]> {
  const maxItems = positiveInteger(context.config.maxItems, 30);
  const result = await context.runCommand("gallery-dl", [
    ...galleryArgs(context.config, platform), "--no-download", "--range", `1-${maxItems}`, "--dump-json", sourceUrl,
  ], { timeoutMs: 180_000, maxOutputBytes: 50 * 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).trim() || `gallery-dl exited with code ${result.exitCode}`);
  const rows = parseMessages(result.stdout);
  const candidates = new Map<string, MediaCandidate>();
  for (const { url, metadata } of rows) {
    const extension = (text(metadata.extension) ?? new URL(url.replace(/^ytdl:/, "")).pathname.split(".").at(-1) ?? "bin").toLowerCase();
    const filenameBase = text(metadata.filename) ?? scalar(metadata.id) ?? `media-${candidates.size + 1}`;
    const filename = filenameBase.toLowerCase().endsWith(`.${extension}`) ? filenameBase : `${filenameBase}.${extension}`;
    const primary = scalar(metadata.post_id) ?? scalar(metadata.tweet_id) ?? scalar(metadata.id) ?? filenameBase;
    const identity = `${platform}:${primary}:${filename}`;
    candidates.set(identity, {
      externalId: identity,
      identityKey: identity,
      title: text(metadata.caption) ?? text(metadata.content) ?? text(metadata.title) ?? filenameBase,
      pageUrl: stablePage(platform, metadata, sourceUrl),
      mediaType: mediaType(extension, metadata),
      publishedAt: oldestDate(
        metadata.date, metadata.date_published, metadata.published_at, metadata.published,
        metadata.created_at, metadata.date_created, metadata.created_time,
        metadata.upload_date, metadata.uploaded_at, metadata.date_posted, metadata.posted_at,
        metadata.timestamp,
      ),
      filename,
      qualityScore: Number(metadata.width ?? 0) * Number(metadata.height ?? 0),
      metadata: { galleryDirectUrl: url, galleryFilename: filenameBase, galleryPlatform: platform },
    });
  }
  return [...candidates.values()];
}

export function galleryDownload(item: MediaCandidate, config: Record<string, unknown>, platform: GalleryPlatform): CommandDownloadRequest {
  const pageUrl = item.pageUrl;
  if (!pageUrl) throw new Error("The extractor did not provide a stable post URL");
  const galleryFilename = text(item.metadata?.galleryFilename);
  if (!galleryFilename) throw new Error("The extractor did not provide a media filename");
  return {
    kind: "command",
    command: "gallery-dl",
    args: [
      ...galleryArgs(config, platform), "--no-mtime", "--directory", "{outputDir}", "--filename", "{outputName}",
      "--filter", `filename == ${JSON.stringify(galleryFilename)}`, pageUrl,
    ],
    filename: item.filename ?? `${item.externalId}.bin`,
  };
}

export function normalizeProfileUrl(rawUrl: string, platform: GalleryPlatform): string {
  const url = new URL(rawUrl);
  url.search = ""; url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (platform === "facebook" && !/\/(?:photos|videos)$/.test(url.pathname)) url.pathname += "/photos";
  if (platform === "fansly" && !/\/(?:media|posts)$/.test(url.pathname)) url.pathname += "/media";
  if (platform === "instagram" && !/\/(?:posts|reels|tagged|stories)(?:\/|$)/.test(url.pathname)) url.pathname += "/posts";
  if (platform === "patreon") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] !== "c") url.pathname = `/c/${parts[0]}`;
  }
  if (platform === "tiktok" && !/\/(?:video|photo)\/\d+\/?$/.test(url.pathname) && !/\/(?:posts|likes|reposts|stories)$/.test(url.pathname)) url.pathname += "/posts";
  if (platform === "twitter" && !/\/(?:media|with_replies|likes)$/.test(url.pathname)) url.pathname += "/media";
  return url.href;
}
