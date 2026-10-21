import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
import plugin, { parseDirtyShipDetail, parseDirtyShipListing } from "./index.js";

function htmlResponse(html: string, url: string) {
  const response = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function context(fetchMock: typeof fetch, config: Record<string, unknown> = {}): PluginContext {
  return { config, fetch: fetchMock, runCommand: vi.fn(), log: () => undefined };
}

describe("DirtyShip plugin", () => {
  it("parses performer cards and pagination", () => {
    const html = `
      <ul class="Thumbnail_List"><li class="thumi">
        <a href="https://dirtyship.com/example-video/" title="Example"><div data-thumbs="https://dirtyship.com/wp-content/thumb.jpg"></div></a>
        <a class="title" href="https://dirtyship.com/example-video/"><h3>A &amp; B</h3></a>
      </li></ul>
      <a class="next page-numbers" href="/performer/example/page/2/">Next</a>`;

    expect(parseDirtyShipListing(html, "https://dirtyship.com/performer/example/")).toMatchObject({
      items: [{
        externalId: "dirtyship:video:example-video",
        identityKey: "dirtyship:video:example-video",
        title: "A & B",
        pageUrl: "https://dirtyship.com/example-video/",
        filename: "example-video.mp4",
        metadata: { thumbnailUrl: "https://dirtyship.com/wp-content/thumb.jpg" },
      }],
      nextPage: "https://dirtyship.com/performer/example/page/2/",
    });
  });

  it("extracts and deduplicates a direct video source", () => {
    const html = `
      <meta property="article:published_time" content="2026-08-25T02:25:34+00:00">
      <h1>Public &amp; direct video</h1>
      <video><source src="https://cdn10.dirtyship.net/dirtyship/cdn3/clip.mp4" type="video/mp4"></video>
      <source src="https://cdn10.dirtyship.net/dirtyship/cdn3/clip.mp4" type="video/mp4">`;

    expect(parseDirtyShipDetail(html, "https://dirtyship.com/public-video/")).toMatchObject([{
      externalId: "dirtyship:video:public-video",
      title: "Public & direct video",
      mediaType: "video",
      filename: "public-video.mp4",
      publishedAt: "2026-08-25T02:25:34.000Z",
      metadata: { downloadUrl: "https://cdn10.dirtyship.net/dirtyship/cdn3/clip.mp4" },
    }]);
  });

  it("selects full-resolution images from a gallery and ignores unrelated artwork", () => {
    const html = `
      <h1>Photo set</h1>
      <img src="https://dirtyship.com/logo.png">
      <img class="gallery-img" src="https://dirtyship.com/wp-content/photo-225x300.jpg"
        srcset="https://dirtyship.com/wp-content/photo-225x300.jpg 225w, https://dirtyship.com/wp-content/photo.jpg 1279w">
      <img class="gallery-img" src="https://dirtyship.com/wp-content/second.jpg">`;

    const items = parseDirtyShipDetail(html, "https://dirtyship.com/gallery/photo-set/");

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      externalId: "dirtyship:gallery:photo-set:photo.jpg",
      title: "Photo set (1)",
      mediaType: "image",
      filename: "photo.jpg",
      metadata: { downloadUrl: "https://dirtyship.com/wp-content/photo.jpg" },
    });
    expect(items[1].filename).toBe("second.jpg");
  });

  it("paginates performer archives without opening every video page", async () => {
    const first = `<title>DirtyShip</title><li class="thumi"><a class="title" href="/one/"><h3>One</h3></a></li><a class="next" href="/performer/example/page/2/">Next</a>`;
    const second = `<title>DirtyShip</title><li class="thumi"><a class="title" href="/two/"><h3>Two</h3></a></li>`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(htmlResponse(first, "https://dirtyship.com/performer/example/"))
      .mockResolvedValueOnce(htmlResponse(second, "https://dirtyship.com/performer/example/page/2/"));

    const items = await plugin.listMedia!(context(fetchMock as typeof fetch), {
      id: "s", externalId: "s", performerId: "p", profileUrl: "https://dirtyship.com/performer/example/", domain: "dirtyship.com",
    });

    expect(items.map((item) => item.externalId)).toEqual(["dirtyship:video:one", "dirtyship:video:two"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves a performer item to its current direct MP4", async () => {
    const detail = `<title>DirtyShip</title><h1>One</h1><source src="https://cdn2.dirtyship.net/files/current.mp4" type="video/mp4">`;
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(detail, "https://dirtyship.com/one/"));
    const item = parseDirtyShipListing(`<li class="thumi"><a class="title" href="/one/">One</a></li>`, "https://dirtyship.com/performer/example/").items[0];

    const request = await plugin.resolveDownload!(context(fetchMock as typeof fetch), item);

    expect(request).toMatchObject({
      kind: "command",
      command: "yt-dlp",
      filename: "one.mp4",
    });
    expect(request.kind === "command" ? request.args : []).toEqual(expect.arrayContaining([
      "--no-check-certificates", "--referer", "https://dirtyship.com/one/", "https://cdn2.dirtyship.net/files/current.mp4",
    ]));
  });

  it("advertises DirtyShip URLs and rejects foreign hosts", async () => {
    expect(plugin.manifest.sourceUrlPatterns).toContain("https://dirtyship.com/*");
    await expect(plugin.listMedia!(context(fetch), {
      id: "s", externalId: "s", performerId: "p", profileUrl: "https://example.test/video/", domain: "example.test",
    })).rejects.toThrow("only supports dirtyship.com URLs");
  });
});

describe("DirtyShip redirect guard", () => {
  it("refuses a page that redirects into the host network", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: "http://10.0.0.1/admin" } }));
    await expect(plugin.listMedia!(context(fetchMock as typeof fetch), {
      id: "s", externalId: "s", performerId: "p", profileUrl: "https://dirtyship.com/performer/example/", domain: "dirtyship.com",
    })).rejects.toThrow(/inside this host's network/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that leaves dirtyship.com", async () => {
    // `redirect: "follow"` used to hand the chain to the platform and only check the final URL,
    // which meant the foreign request had already been made by the time it was refused.
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: "https://example.test/elsewhere" } }));
    await expect(plugin.listMedia!(context(fetchMock as typeof fetch), {
      id: "s", externalId: "s", performerId: "p", profileUrl: "https://dirtyship.com/performer/example/", domain: "dirtyship.com",
    })).rejects.toThrow("only supports dirtyship.com URLs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
