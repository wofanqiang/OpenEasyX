import { oldestMediaDate } from "../packages/media-date.js";
import type { MediaCandidate } from "../packages/plugin-sdk/index.js";

const MEDIA_EXTENSIONS = /\.(?:avif|bmp|gif|jpe?g|png|webp|mp4|m4v|mov|mkv|webm|avi|ts|zip|rar|7z)(?:$|[?#])/i;
const VIDEO_EXTENSIONS = /\.(?:mp4|m4v|mov|mkv|webm|avi|ts)(?:$|[?#])/i;
const ARCHIVE_EXTENSIONS = /\.(?:zip|rar|7z)(?:$|[?#])/i;

export function decodeMarkup(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) result[match[1].toLowerCase()] = decodeMarkup(match[2] ?? match[3] ?? match[4] ?? "");
  return result;
}

function absoluteUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return undefined;
  try {
    const url = new URL(value, baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function filename(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
    return name || undefined;
  } catch {
    return undefined;
  }
}

function mediaType(url: string, hint?: string): MediaCandidate["mediaType"] {
  const normalized = `${hint ?? ""} ${url}`.toLowerCase();
  if (hint?.startsWith("video") || VIDEO_EXTENSIONS.test(url)) return "video";
  if (ARCHIVE_EXTENSIONS.test(url)) return "archive";
  if (hint?.startsWith("image") || /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:$|[?#])/i.test(url)) return "image";
  return normalized.includes("video") ? "video" : normalized.includes("image") ? "image" : "other";
}

export function sourcePublishedDate(...values: unknown[]): string | undefined {
  return oldestMediaDate(...values.map((value) => typeof value === "string" ? decodeMarkup(value.trim()) : value));
}

export function directCandidate(url: string, options: { hint?: string; title?: string; pageUrl?: string; width?: number; height?: number; expectedBytes?: number; publishedAt?: string } = {}): MediaCandidate {
  const cleanTitle = options.title?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    externalId: url,
    identityKey: url.split("#")[0],
    title: cleanTitle || filename(url),
    pageUrl: options.pageUrl,
    mediaType: mediaType(url, options.hint),
    filename: filename(url),
    qualityScore: options.width && options.height ? options.width * options.height : 0,
    expectedBytes: options.expectedBytes,
    publishedAt: options.publishedAt,
    metadata: { downloadUrl: url },
  };
}

function srcsetUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const choices = value.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
  return choices.at(-1);
}

export function extractHtmlMedia(html: string, baseUrl: string, pageUrl = baseUrl, maxItems = 200): MediaCandidate[] {
  const found = new Map<string, MediaCandidate>();
  const publishedAt = htmlPublishedDate(html);
  for (const tag of html.match(/<(?:meta|img|video|source|a)\b[^>]*>/gi) ?? []) {
    const name = tag.match(/^<([\w:-]+)/)?.[1]?.toLowerCase();
    const attrs = attributes(tag);
    const property = (attrs.property ?? attrs.name ?? "").toLowerCase();
    const candidates: Array<{ value?: string; hint?: string }> = [];
    if (name === "meta" && /(?:^|:)(?:image|video)(?::|$)/.test(property)) candidates.push({ value: attrs.content, hint: property.includes("video") ? "video" : "image" });
    if (name === "img") candidates.push({ value: srcsetUrl(attrs.srcset) ?? attrs["data-src"] ?? attrs.src, hint: "image" });
    if (name === "video") {
      candidates.push({ value: attrs.src, hint: "video" });
      candidates.push({ value: attrs.poster, hint: "image" });
    }
    if (name === "source") candidates.push({ value: attrs.src, hint: attrs.type ?? "video" });
    if (name === "a" && MEDIA_EXTENSIONS.test(attrs.href ?? "")) candidates.push({ value: attrs.href });
    for (const candidate of candidates) {
      const url = absoluteUrl(candidate.value, baseUrl);
      if (!url) continue;
      const width = Number(attrs.width || 0) || undefined; const height = Number(attrs.height || 0) || undefined;
      const item = directCandidate(url, { hint: candidate.hint, title: attrs.alt ?? attrs.title, pageUrl, width, height, publishedAt });
      const old = found.get(url);
      if (!old || (item.qualityScore ?? 0) > (old.qualityScore ?? 0)) found.set(url, item);
      if (found.size >= maxItems) return [...found.values()];
    }
  }
  return [...found.values()];
}

export function htmlPublishedDate(html: string): string | undefined {
  const values: unknown[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag); const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase();
    if (["article:published_time", "datepublished", "uploaddate", "pubdate", "date"].includes(key) && attrs.content) values.push(attrs.content);
  }
  for (const tag of html.match(/<time\b[^>]*>/gi) ?? []) { const value = attributes(tag).datetime; if (value) values.push(value); }
  for (const match of html.matchAll(/\\?"(?:datePublished|uploadDate|dateCreated|taken_at|created_at)\\?"\s*:\s*\\?"([^"]+)\\?"/gi)) values.push(match[1].replace(/\\+$/, ""));
  for (const match of html.matchAll(/\\?"(?:taken_at_timestamp|created_time|timestamp)\\?"\s*:\s*\\?"?(\d{10,13})/gi)) values.push(match[1]);
  return sourcePublishedDate(...values);
}

function xmlValue(block: string, tagName: string): string | undefined {
  const escaped = tagName.replace(":", "\\:");
  const match = block.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeMarkup(match[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : undefined;
}

function entryLink(block: string, baseUrl: string): string | undefined {
  const atom = block.match(/<link\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*>/i);
  return absoluteUrl(atom?.[1] ?? atom?.[2] ?? xmlValue(block, "link"), baseUrl);
}

export function extractFeedMedia(xml: string, feedUrl: string, maxItems = 200): MediaCandidate[] {
  const entries = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [xml];
  const found = new Map<string, MediaCandidate>();
  for (const entry of entries) {
    const title = xmlValue(entry, "title");
    const pageUrl = entryLink(entry, feedUrl) ?? feedUrl;
    const publishedAt = xmlValue(entry, "pubDate") ?? xmlValue(entry, "published") ?? xmlValue(entry, "updated");
    const tags = entry.match(/<(?:enclosure|media:content|media:thumbnail)\b[^>]*>/gi) ?? [];
    for (const tag of tags) {
      const attrs = attributes(tag); const url = absoluteUrl(attrs.url ?? attrs.href, feedUrl);
      if (!url) continue;
      const item = directCandidate(url, {
        hint: attrs.type ?? (tag.toLowerCase().startsWith("<media:thumbnail") ? "image" : attrs.medium), title, pageUrl,
        width: Number(attrs.width || 0) || undefined, height: Number(attrs.height || 0) || undefined,
        expectedBytes: Number(attrs.length || 0) || undefined,
      });
      if (!found.has(url)) found.set(url, { ...item, publishedAt });
    }
    for (const bodyTag of ["content:encoded", "content", "description", "summary"]) {
      const escaped = bodyTag.replace(":", "\\:");
      const match = entry.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
      if (!match) continue;
      for (const item of extractHtmlMedia(decodeMarkup(match[1]), pageUrl, pageUrl, maxItems)) {
        if (!found.has(item.externalId)) found.set(item.externalId, { ...item, title: title ?? item.title, publishedAt });
      }
    }
    if (found.size >= maxItems) break;
  }
  return [...found.values()].slice(0, maxItems);
}

export function mediaFilters(config: Record<string, unknown>): { maxItems: number; includeImages: boolean; includeVideos: boolean } {
  return {
    maxItems: Math.max(1, Math.min(1000, Number(config.maxItems ?? 200))),
    includeImages: config.includeImages !== false,
    includeVideos: config.includeVideos !== false,
  };
}

export function filterMedia(items: MediaCandidate[], config: Record<string, unknown>): MediaCandidate[] {
  const filters = mediaFilters(config);
  return items.filter((item) => (item.mediaType !== "image" || filters.includeImages) && (item.mediaType !== "video" || filters.includeVideos)).slice(0, filters.maxItems);
}

export function downloadRequest(item: MediaCandidate) {
  const url = item.metadata?.downloadUrl;
  if (typeof url !== "string") throw new Error("The scraper did not provide a direct media URL");
  return { url, filename: item.filename, headers: { "user-agent": "OpenEasyX/1.0 (+https://github.com/raccommode/OpenEasyX)" } };
}
