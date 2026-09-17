import { describe, expect, it } from "vitest";
import { isOfflineConfirmedError } from "./offline-error.js";

describe("isOfflineConfirmedError", () => {
  it("recognises the offline verdicts the live-cam plugins throw", () => {
    expect(isOfflineConfirmedError("The public room did not expose an HLS host")).toBe(true);
    expect(isOfflineConfirmedError("No public Stripchat HLS host returned a live manifest")).toBe(true);
    expect(isOfflineConfirmedError("No public SuperChat HLS host returned a live manifest")).toBe(true);
  });

  it("rejects transient failures and unrelated messages", () => {
    expect(isOfflineConfirmedError(undefined)).toBe(false);
    expect(isOfflineConfirmedError("")).toBe(false);
    expect(isOfflineConfirmedError("ffmpeg was killed by a signal")).toBe(false);
    expect(isOfflineConfirmedError("Download timed out (no progress received within the configured stall timeout)")).toBe(false);
    expect(isOfflineConfirmedError("Stripchat player module returned HTTP 503")).toBe(false);
    // A host name that merely contains "hls" must not match the manifest verdict.
    expect(isOfflineConfirmedError("could not resolve hls host example.com")).toBe(false);
  });
});
