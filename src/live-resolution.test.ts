import { describe, expect, it } from "vitest";
import { settingsSchema } from "../server/output-settings.js";
import { RECORDING_MAX_HEIGHT_DEFAULT, recordingHeight, recordingHeightOptions } from "./live-resolution.js";

describe("recording height options", () => {
  it("offers only ceilings the server accepts", () => {
    // The failure this guards against is silent on both sides: the page renders, the operator picks
    // a height, and the whole settings save comes back 400 with nothing pointing at the reason.
    for (const option of recordingHeightOptions) {
      expect(settingsSchema.safeParse({ recordingMaxHeight: option.id }).success).toBe(true);
    }
  });

  it("keeps a description for every option", () => {
    for (const option of recordingHeightOptions) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(40);
    }
  });

  it("defaults to 1080p, so a tall broadcast no longer breaks a recording apart", () => {
    expect(RECORDING_MAX_HEIGHT_DEFAULT).toBe(1080);
    expect(recordingHeightOptions.some((option) => option.id === RECORDING_MAX_HEIGHT_DEFAULT)).toBe(true);
    expect(recordingHeight(undefined)).toBe(RECORDING_MAX_HEIGHT_DEFAULT);
    expect(recordingHeight("")).toBe(RECORDING_MAX_HEIGHT_DEFAULT);
    expect(recordingHeight(123)).toBe(RECORDING_MAX_HEIGHT_DEFAULT);
  });

  it("keeps an explicit choice, including 'best available'", () => {
    expect(recordingHeight(720)).toBe(720);
    expect(recordingHeight("1440")).toBe(1440);
    // 0 is a real choice ("best available"), not a missing value.
    expect(recordingHeight(0)).toBe(0);
  });
});
