import { describe, expect, it, vi } from "vitest";
import { activitySourceDomains, COMPLETED_DELETE_CONFIRMATION, confirmItemDeletion, downloadTime, formatElapsed, incompleteOf } from "./activity.js";

describe("activity source filters", () => {
  it("aggregates sources by case-insensitive domain", () => {
    expect(activitySourceDomains([
      { domain: "OnlyFans.com" }, { domain: "onlyfans.com" }, { domain: " x.com " }, { domain: "" }, { domain: "x.com" },
    ])).toEqual(["onlyfans.com", "x.com"]);
  });
});

describe("activity download timing", () => {
  it("formats short, minute, and hour durations", () => {
    expect(formatElapsed(500)).toBe("<1s");
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
  });

  it("uses the persisted finish time for completed downloads", () => {
    expect(downloadTime({
      status: "completed",
      downloadStartedAt: "2026-08-25T12:00:00.000Z",
      downloadFinishedAt: "2026-08-25T12:02:05.000Z",
    })).toBe("2m 5s");
  });

  it("shows live elapsed time only while a download is running", () => {
    expect(downloadTime({ status: "downloading", downloadStartedAt: "2026-08-25T12:00:00.000Z" }, Date.parse("2026-08-25T12:00:08.000Z"))).toBe("8s");
    expect(downloadTime({ status: "queued", downloadStartedAt: "2026-08-25T12:00:00.000Z" })).toBe("—");
    expect(downloadTime({ status: "completed" })).toBe("—");
  });
});

describe("completed recording deletion", () => {
  it("requires explicit confirmation only when the media file will also be deleted", () => {
    const confirm = vi.fn(() => false);
    expect(confirmItemDeletion("completed", confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(COMPLETED_DELETE_CONFIRMATION);
    confirm.mockClear();
    expect(confirmItemDeletion("failed", confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("incomplete recordings in the activity row", () => {
  it("reports what the recorder wrote, so the row cannot read as a finished download", () => {
    // A capture that fell behind the session is still a real file in the library; the row says so
    // instead of showing the plain `completed` badge it used to.
    expect(incompleteOf({ metadata: { incomplete: true, incompleteReason: "captured 18s of a 292s session" } }))
      .toBe("captured 18s of a 292s session");
  });

  it("still flags a capture whose reason was lost", () => {
    // The flag and the wording are written together, but a row from an older build may only carry
    // the flag: it must still be marked, with wording that does not claim a number it does not have.
    expect(incompleteOf({ metadata: { incomplete: true } })).toBe("it ended before the session did");
    expect(incompleteOf({ metadata: { incomplete: true, incompleteReason: "   " } })).toBe("it ended before the session did");
  });

  it("leaves a healthy capture alone", () => {
    expect(incompleteOf({ metadata: {} })).toBeUndefined();
    expect(incompleteOf({ metadata: { incomplete: false } })).toBeUndefined();
    // Only the boolean the recorder actually writes counts: a stray string must not paint a row.
    expect(incompleteOf({ metadata: { incomplete: "true" } })).toBeUndefined();
    expect(incompleteOf({})).toBeUndefined();
  });
});
