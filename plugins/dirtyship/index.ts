import { definePlugin, type MediaCandidate, type PluginContext } from "../../packages/plugin-sdk/index.js";
import { decodeHtml, plainHtml } from "../browser-html-utils.js";
import { positiveInteger } from "../yt-dlp-utils.js";
import { fetchPublic } from "../../packages/public-fetch.js";

const DIRTYSHIP_HOME = "https://dirtyship.com/";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MEDIA_HOST = /(^|\.)dirtyship\.(?:com|net)$/i;
const VIDEO_EXTENSION = /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i;

type ListingResult = { items: MediaCandidate[]; nextPage?: string };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    found[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return found;
}

function safeDirtyShipUrl(value: string, base = DIRTYSHIP_HOME): URL {
  let url: URL;
  try { url = new URL(decodeHtml(value), base); }
  catch { throw new Error("DirtyShip received an invalid URL"); }
  if (!/(^|\.)dirtyship\.com$/i.test(url.hostname)) throw new Error("DirtyShip only supports dirtyship.com URLs");
  url.protocol = "https:";
  url.hash = "";
  return url;
}

function directMediaUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(decodeHtml(value), base);
    return url.protocol === "https:" && MEDIA_HOST.test(url.hostname) ? url.href : undefined;
  } catch { return undefined; }
}

function slug(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "media"); }
  catch { return "media"; }
}

function filename(url: string, fallback: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? fallback) || fallback; }
  catch { return fallback; }
}

function requestHeaders(referer = DIRTYSHIP_HOME): Record<string, string> {
  return { accept: "text/html,application/xhtml+xml,video/*,image/*;q=0.9,*/*;q=0.5", "accept-language": "en-US,en;q=0.8", referer, "user-agent": USER_AGENT };
}

async function fetchHtml(context: PluginContext, pageUrl: string): Promise<{ html: string; url: string }> {
  const requested = safeDirtyShipUrl(pageUrl);
  const timeout = AbortSignal.timeout(45_000);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  // `redirect: "follow"` used to hand the whole chain to the platform and only check the final URL
  // afterwards -- by then the request had already gone wherever the page pointed. Following manually
  // lets every hop pass the same dirtyship.com allowlist.
  const response = await fetchPublic(context, requested.href, "DirtyShip", { headers: requestHeaders(), signal },
    { assertHop: (url) => { safeDirtyShipUrl(url.toString()); } });
  if (!response.ok) throw new Error(`DirtyShip returned HTTP ${response.status}`);
  const finalUrl = safeDirtyShipUrl(response.url || requested.href).href;
  const html = await response.text();
  if (!/DirtyShip/i.test(html)) throw new Error("DirtyShip returned an unexpected page");
  return { html, url: finalUrl };
}

function thumbnailFromBlock(block: string, baseUrl: string): string | undefined {
  for (const tag of block.match(/<(?:img|div)\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const candidate = text(attrs["data-thumbs"])?.split(",", 1)[0] ?? attrs["data-src"] ?? attrs.src;
    const resolved = directMediaUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return undefined;
}

function listingCandidate(pageUrl: string, title: string, thumbnailUrl?: string): MediaCandidate {
  const id = slug(pageUrl);
  return {
    externalId: `dirtyship:video:${id}`,
    identityKey: `dirtyship:video:${id}`,
    title,
    pageUrl,
    mediaType: "video",
    filename: `${id}.mp4`,
    metadata: { dirtyShipPageUrl: pageUrl, thumbnailUrl },
  };
}

export function parseDirtyShipListing(html: string, sourceUrl: string, maxItems = 100): ListingResult {
  const source = safeDirtyShipUrl(sourceUrl);
  const found = new Map<string, MediaCandidate>();
  for (const match of html.matchAll(/<li\b[^>]*class\s*=\s*(["'])[^"']*\bthumi\b[^"']*\1[^>]*>[\s\S]*?<\/li>/gi)) {
    const block = match[0];
    const anchors = block.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
    const titleAnchor = anchors.find((anchor) => /\bclass\s*=\s*(["'])[^"']*\btitle\b[^"']*\1/i.test(anchor));
    if (!titleAnchor) continue;
    const openTag = titleAnchor.match(/^<a\b[^>]*>/i)?.[0];
    const attrs = openTag ? attributes(openTag) : {};
    const href = text(attrs.href);
    if (!href) continue;
    let page: URL;
    try { page = safeDirtyShipUrl(href, source.href); } catch { continue; }
    if (!/^\/(?!gallery\/|performer\/|category\/|phototype\/|page\/)[^/]+\/?$/i.test(page.pathname)) continue;
    page.search = "";
    const cleanTitle = plainHtml(titleAnchor.replace(/^<a\b[^>]*>|<\/a>$/gi, "")) || text(attrs.title) || slug(page.href);
    const item = listingCandidate(page.href, cleanTitle, thumbnailFromBlock(block, source.href));
    found.set(item.externalId, item);
    if (found.size >= maxItems) break;
  }

  let nextPage: string | undefined;
  for (const anchor of html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
    const openTag = anchor.match(/^<a\b[^>]*>/i)?.[0];
    const attrs = openTag ? attributes(openTag) : {};
    if (!/(?:^|\s)next(?:\s|$)/i.test(attrs.class ?? "") || !attrs.href) continue;
    try { nextPage = safeDirtyShipUrl(attrs.href, source.href).href; } catch { /* Ignore malformed pagination. */ }
    break;
  }
  return { items: [...found.values()], nextPage };
}

function pageTitle(html: string, fallback: string): string {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const og = (html.match(/<meta\b[^>]*(?:property|name)\s*=\s*(["'])og:title\1[^>]*>/i)?.[0]);
  const ogTitle = og ? attributes(og).content : undefined;
  return plainHtml(h1 ?? ogTitle ?? "") || slug(fallback).replace(/[-_]+/g, " ");
}

function publicationDate(html: string): string | undefined {
  const values: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (["article:published_time", "datepublished", "uploaddate"].includes(key) && attrs.content) values.push(attrs.content);
  }
  for (const match of html.matchAll(/"(?:datePublished|uploadDate)"\s*:\s*"([^"]+)"/gi)) values.push(match[1].replace(/\\\//g, "/"));
  return values.map((value) => new Date(value)).filter((date) => !Number.isNaN(date.valueOf())).sort((a, b) => a.valueOf() - b.valueOf())[0]?.toISOString();
}

function largestSrcsetUrl(value: string | undefined, baseUrl: string): { url?: string; width: number } {
  let best: { url?: string; width: number } = { width: 0 };
  for (const part of (value ?? "").split(",")) {
    const match = part.trim().match(/^(\S+)(?:\s+(\d+)w)?$/);
    if (!match) continue;
    const url = directMediaUrl(match[1], baseUrl);
    const width = Number(match[2] ?? 0);
    if (url && (!best.url || width >= best.width)) best = { url, width };
  }
  return best;
}

export function parseDirtyShipDetail(html: string, pageUrl: string): MediaCandidate[] {
  const page = safeDirtyShipUrl(pageUrl);
  const pageSlug = slug(page.href);
  const title = pageTitle(html, page.href);
  const publishedAt = publicationDate(html);
  const gallery = /^\/gallery\//i.test(page.pathname);
  const found = new Map<string, MediaCandidate>();

  if (gallery) {
    for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
      const attrs = attributes(tag);
      if (!/(?:^|\s)gallery-img(?:\s|$)/i.test(attrs.class ?? "")) continue;
      const largest = largestSrcsetUrl(attrs.srcset, page.href);
      const url = largest.url ?? directMediaUrl(attrs["data-src"] ?? attrs.src, page.href);
      if (!url) continue;
      const mediaFilename = filename(url, `${pageSlug}-${found.size + 1}.jpg`);
      const identity = `dirtyship:gallery:${pageSlug}:${mediaFilename}`;
      found.set(identity, {
        externalId: identity,
        identityKey: identity,
        title: `${title} (${found.size + 1})`,
        pageUrl: page.href,
        mediaType: "image",
        filename: mediaFilename,
        qualityScore: largest.width ? largest.width * largest.width : 0,
        publishedAt,
        metadata: { downloadUrl: url },
      });
    }
    return [...found.values()];
  }

  for (const tag of html.match(/<(?:video|source)\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    const url = directMediaUrl(attrs.src ?? attrs["data-src"], page.href);
    if (!url || (!VIDEO_EXTENSION.test(url) && !/^video\//i.test(attrs.type ?? ""))) continue;
    const extension = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "mp4";
    const mediaFilename = `${pageSlug}.${extension}`;
    const identity = `dirtyship:video:${pageSlug}`;
    found.set(identity, {
      externalId: identity,
      identityKey: identity,
      title,
      pageUrl: page.href,
      mediaType: "video",
      filename: mediaFilename,
      publishedAt,
      metadata: { downloadUrl: url, dirtyShipPageUrl: page.href },
    });
  }
  return [...found.values()];
}

async function performerMedia(context: PluginContext, sourceUrl: string, maximum: number): Promise<MediaCandidate[]> {
  const found = new Map<string, MediaCandidate>();
  const visited = new Set<string>();
  let nextPage: string | undefined = sourceUrl;
  while (nextPage && found.size < maximum && visited.size < 100) {
    const currentPage = safeDirtyShipUrl(nextPage).href;
    if (visited.has(currentPage)) break;
    visited.add(currentPage);
    const { html, url } = await fetchHtml(context, currentPage);
    const listing = parseDirtyShipListing(html, url, maximum - found.size);
    for (const item of listing.items) found.set(item.externalId, item);
    nextPage = listing.nextPage;
  }
  if (!found.size) throw new Error("DirtyShip did not expose any videos for this performer");
  return [...found.values()].slice(0, maximum);
}

export default definePlugin({
  manifest: {
    id: "org.easyx.dirtyship",
    name: "DirtyShip",
    version: "1.0.0",
    author: "Open EasyX",
    homepage: DIRTYSHIP_HOME,
    description: "List public DirtyShip performer videos, inspect individual video pages, and download full-resolution gallery images.",
    capabilities: ["media-listing", "download-resolver"],
    sourceUrlPatterns: ["http://dirtyship.com/*", "https://dirtyship.com/*", "http://www.dirtyship.com/*", "https://www.dirtyship.com/*"],
    polling: { mode: "periodic", defaultIntervalSeconds: 21_600, minimumIntervalSeconds: 900 },
    settings: [
      { key: "maxItems", label: "Maximum media per scan", type: "number", default: 100 },
    ],
  },
  async testConnection(context) {
    try {
      const { html } = await fetchHtml(context, DIRTYSHIP_HOME);
      return /DirtyShip/i.test(html) ? { ok: true, message: "DirtyShip is reachable." } : { ok: false, message: "DirtyShip returned an unexpected page." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  async listMedia(context, source) {
    const page = safeDirtyShipUrl(source.profileUrl);
    const maximum = positiveInteger(context.config.maxItems, 100, 500);
    if (/^\/performer\/[^/]+\/?$/i.test(page.pathname)) return performerMedia(context, page.href, maximum);
    const { html, url } = await fetchHtml(context, page.href);
    const items = parseDirtyShipDetail(html, url).slice(0, maximum);
    if (!items.length) throw new Error("DirtyShip did not expose downloadable media on this page");
    return items;
  },
  async resolveDownload(context, item) {
    let downloadUrl = text(item.metadata?.downloadUrl);
    let resolvedFilename = item.filename;
    const pageUrl = text(item.metadata?.dirtyShipPageUrl) ?? item.pageUrl;
    if (!downloadUrl && pageUrl) {
      const { html, url } = await fetchHtml(context, pageUrl);
      const candidates = parseDirtyShipDetail(html, url);
      const resolved = candidates.find((candidate) => candidate.mediaType === item.mediaType) ?? candidates[0];
      downloadUrl = text(resolved?.metadata?.downloadUrl);
      resolvedFilename = resolved?.filename ?? resolvedFilename;
    }
    const direct = directMediaUrl(downloadUrl, pageUrl ?? DIRTYSHIP_HOME);
    if (!direct) throw new Error("DirtyShip did not expose a supported direct media URL");
    if (item.mediaType === "video") {
      const directHost = new URL(direct).hostname;
      return {
        kind: "command",
        command: "yt-dlp",
        args: [
          "--progress", "--no-warnings", "--newline", "--progress-delta", "0.5", "--progress-template", "download:easyx-progress:%(progress._percent_str)s", "--no-playlist", "--retries", "5",
          ...(directHost === "dirtyship.net" || directHost.endsWith(".dirtyship.net") ? ["--no-check-certificates"] : []),
          "--referer", pageUrl ?? DIRTYSHIP_HOME, "--output", "{output}", direct,
        ],
        filename: resolvedFilename ?? `${item.externalId}.mp4`,
      };
    }
    return { url: direct, filename: resolvedFilename, headers: requestHeaders(pageUrl ?? DIRTYSHIP_HOME) };
  },
});
