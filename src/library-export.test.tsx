import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExportLinksButton, linkExportName, linkExportText } from "./library-app.js";

describe("library link export", () => {
  it("writes one absolute stream URL per line", () => {
    const text = linkExportText(
      [{ streamUrl: "/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream" }, { streamUrl: "/api/media/bbbbbbbbbbbbbbbbbbbbbbb/stream" }],
      "http://open-easyx.local:3210",
    );
    expect(text).toBe(
      "http://open-easyx.local:3210/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream\n" +
      "http://open-easyx.local:3210/api/media/bbbbbbbbbbbbbbbbbbbbbbb/stream\n",
    );
  });

  it("keeps a token query string intact, because that is what makes the link downloadable", () => {
    const streamUrl = "/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream?exp=1799999999&token=Zm9vYmFy";
    expect(linkExportText([{ streamUrl }], "https://open-easyx.example"))
      .toBe("https://open-easyx.example/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream?exp=1799999999&token=Zm9vYmFy\n");
  });

  it("stays a single newline for an empty selection, so the file is never malformed", () => {
    expect(linkExportText([], "http://open-easyx.local:3210")).toBe("\n");
  });

  it("names the file after the export day, not the first video", () => {
    expect(linkExportName(new Date("2026-10-23T11:44:46.000Z"))).toBe("open-easyx-links-2026-10-23.txt");
  });

  it("shows the count and disables itself with nothing selected", () => {
    const ready = renderToStaticMarkup(<ExportLinksButton count={2} disabled={false} onExport={() => {}} />);
    expect(ready).toContain("Links (2)");
    expect(ready).toContain("Export 2 video links to a text file");
    expect(ready).not.toContain("disabled");

    const empty = renderToStaticMarkup(<ExportLinksButton count={0} disabled onExport={() => {}} />);
    expect(empty).toContain("Select at least one video");
    expect(empty).toContain("disabled");
    expect(empty).not.toContain("Links (0)");
  });
});
