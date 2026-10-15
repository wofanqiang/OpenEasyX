import { describe, expect, it } from "vitest";
import { firstMediaDate, oldestMediaDate, validMediaDate } from "./media-date.js";

describe("media dates", () => {
  it.each([undefined, null, "", "invalid", 0, "0", "0000000000", "0000000000000", -1, "1970-01-01T00:00:00Z", "1969-12-31T19:00:00-05:00", 1e30])("rejects missing or epoch metadata: %s", (value) => {
    expect(validMediaDate(value)).toBeUndefined();
  });
  it("normalizes extractor timestamps and date-only publication metadata", () => {
    for (const value of [1706955630, "1706955630", 1706955630000, "1706955630000"]) {
      expect(validMediaDate(value)).toBe("2024-02-03T10:20:30.000Z");
    }
    expect(validMediaDate("20240203")).toBe("2024-02-03T00:00:00.000Z");
    expect(validMediaDate("2024-02-03")).toBe("2024-02-03T00:00:00.000Z");
    expect(validMediaDate("2024-02-03 10:20:30")).toBe("2024-02-03T10:20:30.000Z");
  });
  it("does not let an epoch placeholder beat a real publication date", () => {
    expect(oldestMediaDate(0, "1970-01-01T00:00:00Z", "2024-02-03", "2025-01-01")).toBe("2024-02-03T00:00:00.000Z");
    expect(firstMediaDate(null, "2025-01-01", "2024-02-03")).toBe("2025-01-01T00:00:00.000Z");
  });
});
