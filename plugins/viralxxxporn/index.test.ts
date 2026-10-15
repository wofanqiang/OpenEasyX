import { describe, expect, it, vi } from "vitest";
import type { MediaSource, PluginContext } from "../../packages/plugin-sdk/index.js";
import plugin, { parseViralXXXPornDetail, parseViralXXXPornListing } from "./index.js";

const HOME = "https://viralxxxporn.com/";
const BLOCK = "list_videos_common_videos_list";
const card = (id: number, route = "video") => `<a class="vx-media" href="/${route}/${id}/example/" title="Example &amp; video"><img src="data:image/gif;base64,placeholder" data-original="//imgcdn.viralxxxporn.com/${id}.jpg"></a>`;
const listing = (body: string, next = "", block = BLOCK) => `<div id="${block}_items">${body}</div><div id="${block}_pagination">${next}</div>`;
const detail = (token = "current") => `<h1>Example &amp; video</h1><script type="application/ld+json">{"uploadDate":"2026-09-26"}</script>
<script>var flashvars = { video_id: '42', video_url: 'https://viralxxxporn.com/get_file/low.mp4/?token=${token}', video_url_text: '480p',
video_alt_url2: 'https://viralxxxporn.com/get_file/high.mp4/?token=${token}', video_alt_url2_text: '1080p',
video_alt_url: 'https://viralxxxporn.com/get_file/mid.mp4/', video_alt_url_text: '720p', preview_url: '//imgcdn.viralxxxporn.com/42.jpg' };</script>`;
const source = (url = `${HOME}models/example/`): MediaSource => ({ id: "s", externalId: "s", performerId: "p", profileUrl: url, domain: "viralxxxporn.com" });
const context = (mock: typeof fetch, config: Record<string, unknown> = {}): PluginContext => ({ fetch: mock, config, runCommand: vi.fn(), log: () => undefined });
const response = (html: string) => new Response(html, { headers: { "content-type": "text/html" } });

describe("ViralXXXPorn plugin", () => {
  it("reads lazy thumbnails, decodes titles and deduplicates videos and shorts by numeric ID", () => {
    const result = parseViralXXXPornListing(listing(card(42) + card(42, "short") + '<a href="https://evil.test/video/7/test/"><img src="x"></a>'), HOME);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ externalId: "viralxxxporn:video:42", identityKey: "viralxxxporn:video:42", title: "Example & video", filename: "42.mp4", metadata: { thumbnailUrl: "https://imgcdn.viralxxxporn.com/42.jpg" } });
  });

  it("scopes collections to their own cards and pagination, excluding recommendations", () => {
    const html = card(99) + listing(card(98), '', 'list_videos_related_videos') + listing(`<div>${card(42)}</div>`) + listing(card(97), '', 'list_videos_shorts');
    expect(parseViralXXXPornListing(html, source().profileUrl).items.map((item) => item.externalId)).toEqual(["viralxxxporn:video:42"]);
  });

  it("handles regular and KVS search pagination without losing query parameters", () => {
    expect(parseViralXXXPornListing(listing('', '<a class="vx-next" href="/latest-updates/2/">Next</a>'), HOME).nextPage).toBe(`${HOME}latest-updates/2/`);
    const result = parseViralXXXPornListing(listing('', `<a class="vx-next" href="#search" data-block-id="${BLOCK}" data-parameters="q:example;category_ids:;sort_by:;from_videos+from_albums:2">Next</a>`), `${HOME}search/example/`);
    const next = new URL(result.nextPage!);
    expect(next.pathname).toBe("/search/example/");
    expect(Object.fromEntries(next.searchParams)).toMatchObject({ mode: "async", function: "get_block", block_id: BLOCK, q: "example", from_videos: "2", from_albums: "2" });
    expect(parseViralXXXPornListing(listing('', '<a class="vx-next" href="https://evil.test/">Next</a>'), HOME).nextPage).toBeUndefined();
  });

  it("chooses the highest public MP4 quality and keeps the publication date", () => {
    expect(parseViralXXXPornDetail(detail(), "https://www.viralxxxporn.com/video/42/renamed/?tracking=1")).toMatchObject({
      externalId: "viralxxxporn:video:42", title: "Example & video", pageUrl: `${HOME}video/42/renamed/`, qualityScore: 1080 ** 2,
      publishedAt: "2026-09-26T00:00:00.000Z", metadata: { height: 1080, downloadUrl: `${HOME}get_file/high.mp4/?token=current` },
    });
  });

  it("does not resolve unrelated recommendations, previews, encrypted or foreign player links", () => {
    expect(() => parseViralXXXPornDetail(card(99), `${HOME}video/42/example/`)).toThrow("supported public video");
    for (const url of ["https://evil.test/video.mp4", "function/0/https://viralxxxporn.com/video.mp4", "javascript:alert(1)"]) {
      expect(() => parseViralXXXPornDetail(`var flashvars = {video_url: '${url}', preview_url: '${HOME}preview.mp4'};`, `${HOME}video/42/example/`)).toThrow("supported public video");
    }
    expect(() => parseViralXXXPornDetail(detail().replace("video_id: '42'", "video_id: '99'"), `${HOME}video/42/example/`)).toThrow("different video");
  });

  it("extracts a short's own VideoObject without confusing thumbnails or other videos", () => {
    const object = { "@type": "VideoObject", "@id": `${HOME}short/42/`, name: "Example short", contentUrl: `${HOME}get_file/42_short.mp4/`, thumbnail: { contentUrl: `${HOME}preview.jpg` }, width: 1080, height: 1920, uploadDate: "2026-09-26T00:00:00Z" };
    const html = `<script type="application/ld+json">${JSON.stringify({ "@graph": [{ ...object, "@id": `${HOME}short/99/` }, object] })}</script>`;
    expect(parseViralXXXPornDetail(html, `${HOME}short/42/`)).toMatchObject({ externalId: "viralxxxporn:video:42", title: "Example short", qualityScore: 1080 * 1920, publishedAt: "2026-09-26T00:00:00.000Z", metadata: { downloadUrl: `${HOME}get_file/42_short.mp4/` } });
    expect(() => parseViralXXXPornDetail(html, `${HOME}short/7/`)).toThrow("supported public short");
  });

  it("paginates, deduplicates across pages and respects the scan limit", async () => {
    const mock = vi.fn().mockResolvedValueOnce(response(listing(card(42), '<a class="vx-next" href="/models/example/2/">Next</a>')))
      .mockResolvedValueOnce(response(listing(card(42) + card(43) + card(44))));
    const items = await plugin.listMedia!(context(mock, { maxItems: 2 }), source());
    expect(items.map((item) => item.externalId)).toEqual(["viralxxxporn:video:42", "viralxxxporn:video:43"]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("stops pagination loops and accepts empty search results", async () => {
    const mock = vi.fn().mockResolvedValue(response(listing(card(42), '<a class="vx-next" href="/models/example/">Next</a>')));
    expect(await plugin.listMedia!(context(mock), source())).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(await plugin.listMedia!(context(vi.fn().mockResolvedValue(response(listing('No results')))), source())).toEqual([]);
  });

  it("lists individual videos and refreshes expired links before downloading", async () => {
    const mock = vi.fn().mockResolvedValueOnce(response(detail("expired"))).mockResolvedValueOnce(response(detail("fresh")));
    const ctx = context(mock);
    const items = await plugin.listMedia!(ctx, source(`${HOME}video/42/example/`));
    expect(items).toHaveLength(1);
    expect(await plugin.resolveDownload!(ctx, items[0])).toMatchObject({ url: `${HOME}get_file/high.mp4/?token=fresh`, filename: "42.mp4", headers: { referer: `${HOME}video/42/example/` } });
  });

  it("rejects foreign and credentialed URLs before fetching", async () => {
    const mock = vi.fn();
    for (const url of ["https://viralxxxporn.com.evil.test/video/42/", "https://evil.test/", "ftp://viralxxxporn.com/", "https://user:pass@viralxxxporn.com/"]) {
      await expect(plugin.listMedia!(context(mock), source(url))).rejects.toThrow("only supports viralxxxporn.com");
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("reports HTTP failures and invalid responses, and propagates cancellation", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("blocked", { status: 403 }));
    expect(await plugin.testConnection!(context(mock))).toMatchObject({ ok: false, message: "ViralXXXPorn returned HTTP 403" });
    await expect(plugin.listMedia!(context(vi.fn().mockResolvedValue(response("Unexpected service"))), source())).rejects.toThrow("supported video collection");
    const controller = new AbortController();
    await plugin.testConnection!({ ...context(mock), signal: controller.signal });
    controller.abort();
    expect(mock.mock.calls.at(-1)![1].signal.aborted).toBe(true);
  });
});
