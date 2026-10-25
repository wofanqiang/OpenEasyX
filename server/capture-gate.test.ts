import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureStartGate } from "./capture-gate.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** A gate whose load is whatever the test says it is. */
function gate(loads: { value: number }, extra: Partial<ConstructorParameters<typeof CaptureStartGate>[0]> = {}) {
  return new CaptureStartGate({ cores: 1, loadAverage: () => loads.value, ...extra });
}

describe("capture start gate", () => {
  it("lets captures start on an idle machine", () => {
    const g = gate({ value: 0.2 });
    expect(g.allowsStart()).toBe(true);
    expect(g.status()).toEqual({ paused: false, load: 0.2, pauseAt: 2.5 });
  });

  it("declines a start once the load reaches the pause line", () => {
    const loads = { value: 2.6 };
    const g = gate(loads);
    expect(g.allowsStart()).toBe(false);
    expect(g.status().paused).toBe(true);
  });

  it("stays paused until the load drops below the resume line, so it cannot flap", () => {
    const loads = { value: 3 };
    const g = gate(loads);
    expect(g.allowsStart()).toBe(false);
    // Between the two lines: still paused, even though a fresh gate would have allowed it.
    loads.value = 2.0;
    expect(g.allowsStart()).toBe(false);
    loads.value = 1.7;
    expect(g.allowsStart()).toBe(true);
    expect(g.status().paused).toBe(false);
  });

  it("scales the thresholds with the core count", () => {
    const loads = { value: 6 };
    expect(gate(loads, { cores: 1 }).allowsStart()).toBe(false);
    // Six cores carry a load of six fine: the line is 6 * 2.5.
    expect(gate(loads, { cores: 6 }).allowsStart()).toBe(true);
  });

  it("lets one capture through after the starvation cap, so a busy box does not stop recording", async () => {
    const g = gate({ value: 4 }, { starveSeconds: 0.02 });
    expect(g.allowsStart()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(g.allowsStart()).toBe(true);
  });

  it("switches itself off rather than latching when the thresholds are misconfigured", () => {
    const g = gate({ value: 99 }, { loadPauseFactor: 1.8, loadResumeFactor: 1.8 });
    expect(g.allowsStart()).toBe(true);
  });

  it("reads its thresholds from the environment, and reads 0 as off", () => {
    vi.stubEnv("EASYX_CAPTURE_LOAD_PAUSE", "1.2");
    vi.stubEnv("EASYX_CAPTURE_LOAD_RESUME", "0.5");
    vi.spyOn(os, "cpus").mockReturnValue(new Array(1).fill({}) as os.CpuInfo[]);
    vi.spyOn(os, "loadavg").mockReturnValue([1.3, 0, 0]);
    expect(CaptureStartGate.fromEnv().allowsStart()).toBe(false);

    vi.stubEnv("EASYX_CAPTURE_LOAD_MAX_WAIT_SECONDS", "0");
    expect(CaptureStartGate.fromEnv().status().pauseAt).toBeCloseTo(1.2);
  });
});
