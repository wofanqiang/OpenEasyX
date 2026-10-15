import { definePlugin, type MediaCandidate, type PluginContext } from "../../packages/plugin-sdk/index.js";
import { decodeHtml, plainHtml } from "../browser-html-utils.js";
import { htmlPublishedDate } from "../media-utils.js";
import { positiveInteger } from "../yt-dlp-utils.js";

const HOME = "https://viralxxxporn.com/";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const LIST_BLOCKS = ["list_videos_videos_list_search_result", "list_videos_common_videos_list", "list_videos_most_recent_videos", "list_videos_shorts"];

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map((match) => [match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? "")]));
}

function pageUrl(value: string, base = HOME): URL {
  const url = new URL(decodeHtml(value), base);
  if (!["http:", "https:"].includes(url.protocol) || !["viralxxxporn.com", "www.viralxxxporn.com"].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error("ViralXXXPorn only supports viralxxxporn.com page URLs");
  }
  url.protocol = "https:";
  url.hostname = "viralxxxporn.com";
  url.hash = "";
  return url;
}

function mediaUrl(value: string | undefined, base: string): string | undefined {
  if (!value || /^function\//i.test(value)) return undefined;
  try {
    const url = new URL(decodeHtml(value).replace(/\\\//g, "/"), base);
    if (url.protocol === "https:" && /(^|\.)viralxxxporn\.com$/i.test(url.hostname) && !url.username && !url.password && !url.port) return url.href;
  } catch { /* Ignore unsupported player sources. */ }
  return undefined;
}

function videoId(url: URL): string | undefined {
  return url.pathname.match(/^\/(?:video|short|embed)\/(\d+)(?:\/|$)/)?.[1];
}

function candidate(url: URL, title: string, thumbnailUrl?: string): MediaCandidate {
  const id = videoId(url)!;
  url.search = "";
  return {
    externalId: `viralxxxporn:video:${id}`, identityKey: `viralxxxporn:video:${id}`,
    title: title || id, pageUrl: url.href, mediaType: "video", filename: `${id}.mp4`,
    metadata: { thumbnailUrl },
  };
}

function headers(referer = HOME): Record<string, string> {
  return { "user-agent": USER_AGENT, referer, accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
}

async function fetchPage(context: PluginContext, value: string): Promise<{ html: string; url: string }> {
  const requested = pageUrl(value);
  const timeout = AbortSignal.timeout(45_000);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const response = await context.fetch(requested, { headers: headers(), signal });
  if (!response.ok) throw new Error(`ViralXXXPorn returned HTTP ${response.status}`);
  return { html: await response.text(), url: pageUrl(response.url || requested.href).href };
}

// Keep scans inside the selected collection instead of importing recommendations.
function divContent(html: string, id: string): string | undefined {
  let depth = 0;
  let start: number | undefined;
  for (const match of html.matchAll(/<\/?div\b[^>]*>/gi)) {
    if (start === undefined) {
      if (attributes(match[0]).id !== id) continue;
      start = match.index + match[0].length;
      depth = 1;
    } else {
      depth += /^<\//.test(match[0]) ? -1 : 1;
      if (depth === 0) return html.slice(start, match.index);
    }
  }
  return undefined;
}

export function parseViralXXXPornListing(html: string, sourceUrl: string): { items: MediaCandidate[]; nextPage?: string } {
  const source = pageUrl(sourceUrl);
  const selected = source.searchParams.get("block_id");
  const block = selected && LIST_BLOCKS.includes(selected) ? selected : LIST_BLOCKS.find((id) => divContent(html, `${id}_items`) !== undefined);
  const content = block ? divContent(html, `${block}_items`) : undefined;
  if (content === undefined) throw new Error("ViralXXXPorn did not expose a supported video collection on this page");
  const found = new Map<string, MediaCandidate>();
  for (const match of content.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(match[1]);
    if (!attrs.href || !/<img\b/i.test(match[2])) continue;
    let url: URL;
    try { url = pageUrl(attrs.href, source.href); } catch { continue; }
    if (!videoId(url)) continue;
    const img = attributes(match[2].match(/<img\b[^>]*>/i)?.[0] ?? "");
    const item = candidate(url, plainHtml(attrs.title || img.alt || ""), mediaUrl(img["data-original"] ?? img["data-src"] ?? img.src, source.href));
    found.set(item.externalId, item);
  }

  let nextPage: string | undefined;
  const pagination = divContent(html, `${block}_pagination`) ?? "";
  for (const tag of pagination.match(/<a\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (!/(?:^|\s)vx-next(?:\s|$)/.test(attrs.class ?? "")) continue;
    if (attrs.href && !attrs.href.startsWith("#")) {
      try { nextPage = pageUrl(attrs.href, source.href).href; } catch { /* Ignore foreign pagination. */ }
    } else if (attrs["data-block-id"] === block && attrs["data-parameters"]) {
      const url = new URL(source);
      url.searchParams.set("mode", "async");
      url.searchParams.set("function", "get_block");
      url.searchParams.set("block_id", block);
      for (const part of attrs["data-parameters"].split(";")) {
        const separator = part.indexOf(":");
        if (separator < 1) continue;
        for (const key of part.slice(0, separator).split("+")) url.searchParams.set(key, part.slice(separator + 1));
      }
      nextPage = url.href;
    }
    break;
  }
  return { items: [...found.values()], nextPage };
}

export function parseViralXXXPornDetail(html: string, sourceUrl: string): MediaCandidate {
  const url = pageUrl(sourceUrl);
  if (!videoId(url)) throw new Error("ViralXXXPorn requires an individual video URL");
  // Shorts use a VideoObject rather than the standard KVS player.
  if (url.pathname.startsWith("/short/")) {
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (attributes(script[1]).type !== "application/ld+json") continue;
      let data;
      try { data = JSON.parse(script[2]); } catch { continue; }
      const nodes = Array.isArray(data) ? data : Array.isArray(data?.["@graph"]) ? data["@graph"] : [data];
      for (const node of nodes) {
        if (node?.["@type"] !== "VideoObject") continue;
        let identity: URL;
        try { identity = pageUrl(node.url ?? node["@id"]); } catch { continue; }
        if (videoId(identity) !== videoId(url) || !identity.pathname.startsWith("/short/")) continue;
        const direct = mediaUrl(typeof node.contentUrl === "string" ? node.contentUrl : undefined, url.href);
        if (!direct || !/\.mp4(?:\/|$|[?#])/i.test(direct)) continue;
        const item = candidate(url, plainHtml(typeof node.name === "string" ? node.name : ""), mediaUrl(typeof node.thumbnailUrl === "string" ? node.thumbnailUrl : undefined, url.href));
        const width = Number(node.width); const height = Number(node.height);
        return {
          ...item, publishedAt: htmlPublishedDate(JSON.stringify(node)),
          qualityScore: Number.isFinite(width * height) && width > 0 && height > 0 ? width * height : 0,
          metadata: { ...item.metadata, downloadUrl: direct },
        };
      }
    }
    throw new Error("ViralXXXPorn did not expose a supported public short on this page");
  }
  const player = html.match(/\bvar\s+flashvars\s*=\s*\{([\s\S]*?)\}\s*;/)?.[1] ?? "";
  const values: Record<string, string> = {};
  // Parse string data only; never execute scripts supplied by a source page.
  for (const match of player.matchAll(/\b(\w+)\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g)) {
    values[match[1]] = (match[2] ?? match[3]).replace(/\\(['"/\\])/g, "$1");
  }
  if (values.video_id && values.video_id !== videoId(url)) throw new Error("ViralXXXPorn returned a different video");
  const formats = Object.entries(values).flatMap(([key, value]) => {
    if (!/^video_(?:url|alt_url\d*)$/.test(key)) return [];
    const direct = mediaUrl(value, url.href);
    if (!direct || !/\.mp4(?:\/|$|[?#])/i.test(direct)) return [];
    const height = Number(values[`${key}_text`]?.match(/(\d{3,4})p/i)?.[1] ?? 0);
    return [{ url: direct, height }];
  }).sort((a, b) => b.height - a.height);
  if (!formats.length) throw new Error("ViralXXXPorn did not expose a supported public video on this page");
  const item = candidate(url, plainHtml(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? values.video_title ?? ""), mediaUrl(values.preview_url, url.href));
  return {
    ...item, publishedAt: htmlPublishedDate(html), qualityScore: formats[0].height ** 2,
    metadata: { ...item.metadata, downloadUrl: formats[0].url, height: formats[0].height },
  };
}

export default definePlugin({
  manifest: {
    id: "org.easyx.viralxxxporn", name: "ViralXXXPorn", version: "1.0.0", author: "Open EasyX", homepage: HOME,
    description: "List public ViralXXXPorn model videos, search results and video collections, and download individual videos at the best available quality.",
    capabilities: ["media-listing", "download-resolver"],
    sourceUrlPatterns: ["http://viralxxxporn.com/*", "https://viralxxxporn.com/*", "http://www.viralxxxporn.com/*", "https://www.viralxxxporn.com/*"],
    polling: { mode: "periodic", defaultIntervalSeconds: 21_600, minimumIntervalSeconds: 900 },
    settings: [{ key: "maxItems", label: "Maximum videos per scan", type: "number", default: 100 }],
  },
  async testConnection(context) {
    try {
      const page = await fetchPage(context, HOME);
      parseViralXXXPornListing(page.html, page.url);
      return { ok: true, message: "ViralXXXPorn is reachable." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  async listMedia(context, source) {
    const start = pageUrl(source.profileUrl);
    if (videoId(start)) {
      const page = await fetchPage(context, start.href);
      return [parseViralXXXPornDetail(page.html, page.url)];
    }
    const maximum = positiveInteger(context.config.maxItems, 100, 500);
    const found = new Map<string, MediaCandidate>();
    const visited = new Set<string>();
    let next: string | undefined = start.href;
    while (next && found.size < maximum && visited.size < 100) {
      if (visited.has(next)) break;
      visited.add(next);
      const page = await fetchPage(context, next);
      const listing = parseViralXXXPornListing(page.html, page.url);
      for (const item of listing.items) {
        found.set(item.externalId, item);
        if (found.size >= maximum) break;
      }
      if (!listing.items.length) break;
      next = listing.nextPage;
    }
    return [...found.values()];
  },
  async resolveDownload(context, item) {
    if (!item.pageUrl) throw new Error("ViralXXXPorn requires a video page URL to refresh its download link");
    const page = await fetchPage(context, item.pageUrl);
    const current = parseViralXXXPornDetail(page.html, page.url);
    if (current.externalId !== item.externalId) throw new Error("ViralXXXPorn redirected to a different video");
    return { url: current.metadata!.downloadUrl as string, filename: current.filename, headers: headers(page.url) };
  },
});
