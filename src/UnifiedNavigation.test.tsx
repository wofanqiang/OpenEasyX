import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnifiedNavigation } from "./UnifiedNavigation";

describe("UnifiedNavigation", () => {
  it("renders one complete menu without legacy section names", () => {
    const html = renderToStaticMarkup(<UnifiedNavigation pathname="/library"/>);

    expect(html).toContain("Home");
    expect(html).not.toContain("Overview");
    expect(html).toContain("Library");
    expect(html).toContain("Live Cam");
    expect(html).not.toContain("Discover");
    expect(html).toContain("Plugins");
    expect(html).toContain("Settings");
    expect(html).not.toContain("Media &amp; Live");
    expect(html).not.toContain("Workspace");
  });

  it("keeps the favorites filter inside the Live Cam navigation entry", () => {
    const html = renderToStaticMarkup(<UnifiedNavigation pathname="/live-cam/favorites"/>);
    expect(html).not.toContain('href="/live-cam/favorites"');
    expect(html).toContain('href="/live-cam" class="active"');
    expect(html).not.toContain('href="/favorites" class="active"');
  });

  it("marks Home and Library independently", () => {
    const home = renderToStaticMarkup(<UnifiedNavigation pathname="/media"/>);
    const library = renderToStaticMarkup(<UnifiedNavigation pathname="/library"/>);

    expect(home).toContain('href="/media" class="active"');
    expect(home).not.toContain('href="/library" class="active"');
    expect(library).toContain('href="/library" class="active"');
    expect(library).not.toContain('href="/media" class="active"');
  });
});
