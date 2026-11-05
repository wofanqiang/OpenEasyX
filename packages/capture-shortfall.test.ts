import { describe, expect, it } from "vitest";
import { shortfallReason } from "./capture-shortfall.js";

describe("shortfall wording", () => {
  it("names both shapes of shortfall when both were measured", () => {
    expect(shortfallReason({ expectedSec: 292, actualSec: 18, containerSec: 118, videoSec: 42 }))
      .toBe("captured 18s of a 292s session; picture stopped at 42s of 118s");
  });

  it("says only what was actually measured", () => {
    // The wall-clock check is skipped for a manual stop and for anything under a minute, so the
    // wording must not invent a session length it never compared against.
    expect(shortfallReason({ expectedSec: 292, actualSec: 18 })).toBe("captured 18s of a 292s session");
    expect(shortfallReason({ containerSec: 118, videoSec: 42 })).toBe("picture stopped at 42s of 118s");
  });

  it("rounds to whole seconds, which is the precision the numbers were measured at", () => {
    expect(shortfallReason({ expectedSec: 291.6, actualSec: 17.7 })).toBe("captured 18s of a 292s session");
  });

  it("says nothing when nothing fell short", () => {
    expect(shortfallReason({})).toBeUndefined();
  });
});
