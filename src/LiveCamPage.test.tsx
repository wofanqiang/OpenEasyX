import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCamAutoRecordButton, LiveCamCard, LiveCamFavoriteButton, LiveCamPerformerButton, LiveCamRecordButton, LiveCamUnavailable, LivePlayer, liveCamListUrl, liveCamPresetFromSearch, liveCamUrl, markLiveCamInterrupted, mergeLiveCamRefresh, shouldRecoverNativeLiveMediaError } from "./LiveCamPage";

afterEach(() => vi.unstubAllGlobals());

describe("Live Cam availability", () => {
  it("explains that a live source plugin is needed instead of presenting a broken empty grid", () => {
    const html = renderToStaticMarkup(<LiveCamUnavailable reason="Live Cam works only with Open EasyX."/>);
    expect(html).toContain("No live-cam plugin is ready");
    expect(html).toContain("Plugins → Sources &amp; live");
  });

  it("uses the custom video controls for live streams", () => {
    const html = renderToStaticMarkup(<LivePlayer cam={{ id: "alice", username: "alice", pageUrl: "https://example.test/alice", providerId: "test", providerName: "Test Live" }} close={() => {}}/>);
    expect(html).toContain("custom-player live-custom-player");
    expect(html).toContain("ON AIR");
    expect(html).not.toContain("controls=\"\"");
    expect(html).not.toContain("Autoplay");
    expect(html).not.toContain("Subtitles");
  });

  it("restores the saved player volume for live streams", () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ volume: 0.35, muted: false }), setItem: vi.fn() });
    const html = renderToStaticMarkup(<LivePlayer cam={{ id: "alice", username: "alice", pageUrl: "https://example.test/alice", providerId: "test", providerName: "Test Live" }} close={() => {}}/>);
    expect(html).toContain('aria-label="Volume"');
    expect(html).toContain('value="0.35"');
    expect(html).not.toContain('<video playsInline="" muted=""');
  });

  it("creates shareable URLs for filters and individual live cams", () => {
    expect(liveCamListUrl({ query: "alice", providerId: "test.live", gender: "female", favoritesOnly: true, page: 3 }))
      .toBe("/live-cam?q=alice&source=test.live&gender=female&page=3&favorites=1");
    expect(liveCamPresetFromSearch("?q=alice&source=test.live&gender=female&favorites=1&page=3"))
      .toEqual({ query: "alice", providerId: "test.live", gender: "female", favoritesOnly: true, page: 3 });
    expect(liveCamPresetFromSearch("?source=test.live", "/live-cam/favorites")).toMatchObject({ favoritesOnly: true, providerId: "test.live" });
    expect(liveCamListUrl({ favoritesOnly: true })).toBe("/live-cam?favorites=1");
    expect(liveCamUrl({ providerId: "test.live", id: "alice/bob" })).toBe("/live-cam/test.live/alice%2Fbob");
  });

  it("offers direct recording from a live room", () => {
    const html = renderToStaticMarkup(<LiveCamRecordButton cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live" }}/>);
    expect(html).toContain("Record live");
  });

  it("offers direct performer creation from a live room", () => {
    const html = renderToStaticMarkup(<LiveCamPerformerButton cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live" }}/>);
    expect(html).toContain("Add performer");
  });

  it("offers performer management after reloading an already linked live room", () => {
    const html = renderToStaticMarkup(<LiveCamPerformerButton cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live", performerId: "person-alice" }}/>);
    expect(html).toContain("Manage performer");
    expect(html).toContain("/performers?performer=person-alice");
    expect(html).not.toContain("Add performer");
  });

  it("offers a performer-level auto-record switch outside the favorite flow", () => {
    const base = { id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live" };
    const off = renderToStaticMarkup(<LiveCamAutoRecordButton cam={base}/>);
    expect(off).toContain("Auto-record"); expect(off).toContain('aria-pressed="false"');
    const on = renderToStaticMarkup(<LiveCamAutoRecordButton cam={{ ...base, autoRecord: true }}/>);
    expect(on).toContain("Auto-record on"); expect(on).toContain('aria-pressed="true"');
  });

  it("offers a persistent creator favorite action", () => {
    const html = renderToStaticMarkup(<LiveCamFavoriteButton cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live", favorite: true }}/>);
    expect(html).toContain("Favorited"); expect(html).toContain('aria-pressed="true"');
  });

  it("keeps confirmed offline rooms disabled without diagnostic status labels", () => {
    const html = renderToStaticMarkup(<LiveCamCard cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live", favorite: true, online: false }} open={() => {}}/>);
    expect(html).not.toContain("OFFLINE"); expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('href="/live-cam/');
  });

  it("recovers Safari media error 4 after a tab suspension without hiding real playback errors", () => {
    expect(shouldRecoverNativeLiveMediaError(4, true, 0, 10_000)).toBe(true);
    expect(shouldRecoverNativeLiveMediaError(4, false, 9_000, 10_000)).toBe(true);
    expect(shouldRecoverNativeLiveMediaError(4, false, 1_000, 10_000)).toBe(false);
    expect(shouldRecoverNativeLiveMediaError(3, true, 0, 10_000)).toBe(false);
  });

  it("allows retrying a room whose status lookup failed without diagnostic labels", () => {
    const html = renderToStaticMarkup(<LiveCamCard cam={{ id: "alice", username: "alice", pageUrl: "https://live.test/alice", providerId: "test.live", providerName: "Test Live", favorite: true, online: false, statusUnavailable: true }} open={() => {}}/>);
    expect(html).not.toContain("STATUS UNAVAILABLE"); expect(html).not.toContain("Your favorite is saved");
    expect(html).toContain('href="/live-cam/test.live/alice"');
    expect(html).not.toContain("OFFLINE"); expect(html).not.toContain("Not broadcasting right now");
  });

  it("retains rooms while their provider refreshes and removes them when an empty result is complete", () => {
    const previous = { available: true, items: [{ id: "alice", username: "alice", providerId: "test.live", providerName: "Test Live", pageUrl: "https://live.test/alice" }], total: 1, page: 1, pageSize: 24, pages: 1, providers: [{ id: "test.live", name: "Test Live", ok: true, count: 1 }], complete: true };
    const pending = { ...previous, items: [], total: 0, providers: [{ ...previous.providers[0], count: 0, pending: true }], complete: false };
    expect(mergeLiveCamRefresh(previous, pending)).toMatchObject({ items: previous.items, total: 1 });
    expect(mergeLiveCamRefresh(previous, { ...pending, complete: true })).toMatchObject({ items: [], total: 0 });
    expect(mergeLiveCamRefresh(null, pending)).toEqual(pending);
  });

  it("stops advertising a provider that never answered as still loading", () => {
    const result = {
      available: true,
      items: [{ id: "alice", username: "alice", providerId: "fast.live", providerName: "Fast Live", pageUrl: "https://live.test/alice" }],
      total: 1, page: 1, pageSize: 24, pages: 1, complete: false,
      providers: [
        { id: "fast.live", name: "Fast Live", ok: true, count: 1 },
        { id: "slow.live", name: "Slow Live", ok: true, count: 0, pending: true },
      ],
    };
    const interrupted = markLiveCamInterrupted(result);
    expect(interrupted.items).toEqual(result.items);
    expect(interrupted.providers[0]).toBe(result.providers[0]);
    expect(interrupted.providers[1]).toMatchObject({ id: "slow.live", pending: false, ok: false, error: expect.stringContaining("Did not respond") });
    // A snapshot with nothing outstanding is returned untouched.
    const settled = { ...result, providers: result.providers.map((provider) => ({ ...provider, pending: false })) };
    expect(markLiveCamInterrupted(settled)).toBe(settled);
  });
});
