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
      "http://open-easyx.local:3210/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream?download=1\n" +
      "http://open-easyx.local:3210/api/media/bbbbbbbbbbbbbbbbbbbbbbb/stream?download=1\n",
    );
  });

  it("keeps a token query string intact, because that is what makes the link downloadable", () => {
    const streamUrl = "/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream?exp=1799999999&token=Zm9vYmFy";
    expect(linkExportText([{ streamUrl }], "https://open-easyx.example"))
      .toBe("https://open-easyx.example/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream?exp=1799999999&token=Zm9vYmFy&download=1\n");
  });

  it("asks for a file rather than a stream, so the browser does not try to play it", () => {
    expect(linkExportText([{ streamUrl: "/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream" }], "https://open-easyx.example"))
      .toContain("download=1");
  });

  it("exports over http when the host is a bare address, because https on one cannot be trusted", () => {
    // A certificate authority issues names, not addresses: an https link to a bare IP is refused
    // by wget, aria2c and the browser alike, so the export would be a file of broken links.
    expect(linkExportText([{ streamUrl: "/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream" }], "https://67.217.58.122"))
      .toBe("http://67.217.58.122/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream?download=1\n");
    // A named host keeps its scheme.
    expect(linkExportText([{ streamUrl: "/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream" }], "https://easyx.example.com"))
      .toBe("https://easyx.example.com/api/media/aaaaaaaaaaaaaaaaaaaaaaa/stream?download=1\n");
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
    expect(ready).toContain("Export 2 video links as download-URLs for wget, aria2c or a download manager");
    expect(ready).not.toContain("disabled");

    const empty = renderToStaticMarkup(<ExportLinksButton count={0} disabled onExport={() => {}} />);
    expect(empty).toContain("Select at least one video");
    expect(empty).toContain("disabled");
    expect(empty).not.toContain("Links (0)");
  });
});
