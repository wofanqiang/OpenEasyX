import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MergeDialog, mediaOrderKey, moveInOrder, orderedForMerge } from "./library-app";

/**
 * The merge order is decided in two places and they have to agree: the dialog shows the operator
 * the sequence, and the server joins the files in it. When the two disagreed the operator would
 * read one order and get another -- so the rule lives in one place on each side and is pinned
 * here: content date first, the file's own modified time next, the ingest time only as a last
 * resort.
 */
const clip = (id: string, relativePath: string, dates: { mediaDate?: string; modifiedAt?: string; addedAt?: string }) => ({
  id, relativePath, kind: "video" as const, title: id, performer: "Alice", source: "chat.test",
  extension: ".mp4", mimeType: "video/mp4", size: 10,
  modifiedAt: dates.modifiedAt ?? "2026-09-20T08:00:00.000Z",
  addedAt: dates.addedAt, mediaDate: dates.mediaDate,
  duration: 60, width: 64, height: 64, favorite: false, progressSeconds: 0,
  completed: false, viewCount: 0, thumbnailUrl: "", previewUrl: "", streamUrl: "",
});

describe("merge ordering", () => {
  it("prefers the content date over the ingest time", () => {
    // A library that was imported or rescanned: both rows were ingested at the same moment, but
    // they were recorded a day apart. The content date is the one that tells them apart.
    const imported = "2026-09-21T12:00:00.000Z";
    const older = clip("a", "alice/a.mp4", { mediaDate: "2026-09-20T08:00:00.000Z", addedAt: imported });
    const newer = clip("b", "alice/b.mp4", { mediaDate: "2026-09-20T09:00:00.000Z", addedAt: imported });

    expect(mediaOrderKey(older)).toBeLessThan(mediaOrderKey(newer));
    expect(orderedForMerge([newer, older]).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("falls back to the file's modified time, and to nothing at all when that is unusable", () => {
    // No content date: the file's own modified time decides.
    const byModified = clip("a", "alice/a.mp4", { modifiedAt: "2026-09-20T10:00:00.000Z" });
    // A content date beats a later modified time -- it is the one the library shows.
    const byMediaDate = clip("b", "alice/b.mp4", { mediaDate: "2026-09-20T08:00:00.000Z", modifiedAt: "2026-09-20T11:00:00.000Z" });
    expect(mediaOrderKey(byMediaDate)).toBeLessThan(mediaOrderKey(byModified));

    // Nothing usable sorts to the front, where the path breaks the tie.
    const unknown = clip("c", "alice/c.mp4", { modifiedAt: "not a date", addedAt: "not a date" });
    expect(mediaOrderKey(unknown)).toBe(0);
    expect(orderedForMerge([clip("d", "alice/d.mp4", {}), unknown]).map((item) => item.id)).toEqual(["c", "d"]);
  });

  it("moves an item one place and leaves the ends alone", () => {
    const list = ["a", "b", "c"];
    expect(moveInOrder(list, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(list, 1, 1)).toEqual(["a", "c", "b"]);
    // The ends do not move, and the list that came in is never edited in place.
    expect(moveInOrder(list, 0, -1)).toEqual(list);
    expect(moveInOrder(list, 2, 1)).toEqual(list);
    expect(moveInOrder(list, 5, -1)).toEqual(list);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("offers the operator a way to change the order", () => {
    const items = [clip("a", "alice/a.mp4", {}), clip("b", "alice/b.mp4", {})] as never[];
    const html = renderToStaticMarkup(
      <MergeDialog items={items} busy={false} close={vi.fn()} submit={vi.fn()} />,
    );
    expect(html).toContain("Move a up");
    expect(html).toContain("Move a down");
    expect(html).toContain("Move b up");
    // The first row cannot move up and the last cannot move down.
    expect(html).toMatch(/aria-label="Move a up"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Move b down"[^>]*disabled/);
  });
});
