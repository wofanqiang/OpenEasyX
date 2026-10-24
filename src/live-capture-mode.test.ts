import { describe, expect, it } from "vitest";
import { settingsSchema } from "../server/output-settings.js";
import { LIVE_CAPTURE_INPUT_DEFAULT, captureMode, liveCaptureInputOptions } from "./live-capture-mode.js";

describe("live capture mode options", () => {
  it("offers only modes the server accepts", () => {
    // The failure this guards against is silent on both sides: the page renders, the operator picks
    // the new mode, and the whole settings save comes back 400 with nothing pointing at the reason.
    for (const mode of liveCaptureInputOptions) {
      expect(settingsSchema.safeParse({ liveCaptureInput: mode.id }).success).toBe(true);
    }
  });

  it("keeps a description for every option", () => {
    for (const mode of liveCaptureInputOptions) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.description.length).toBeGreaterThan(40);
    }
  });

  it("defaults to the mode every existing install already records with", () => {
    expect(LIVE_CAPTURE_INPUT_DEFAULT).toBe("split");
    expect(liveCaptureInputOptions.some((mode) => mode.id === LIVE_CAPTURE_INPUT_DEFAULT)).toBe(true);
    expect(captureMode(undefined)).toBe(LIVE_CAPTURE_INPUT_DEFAULT);
  });

  it("reads an unusable stored value as the default", () => {
    // Blank, absent, the wrong case and a stray number all mean "nobody set this" rather than a mode.
    for (const value of [undefined, null, "", " ", "MASTER", "two-inputs", 3, {}, ["master"]]) {
      expect(captureMode(value)).toBe(LIVE_CAPTURE_INPUT_DEFAULT);
    }
    expect(settingsSchema.safeParse({ liveCaptureInput: "nonsense" }).success).toBe(false);
  });

  it("passes a known mode through unchanged", () => {
    expect(captureMode("master")).toBe("master");
    expect(captureMode("auto")).toBe("auto");
    expect(captureMode("split")).toBe("split");
  });
});
