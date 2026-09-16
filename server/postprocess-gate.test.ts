import { describe, expect, it, vi } from "vitest";
import { PostProcessGate } from "./postprocess-gate.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A gate with the load gate effectively disabled: loadavg 0 is never "overloaded". */
const gateWithoutLoad = (options: ConstructorParameters<typeof PostProcessGate>[0] = {}) =>
  new PostProcessGate({ loadAverage: () => 0, ...options });

describe("PostProcessGate", () => {
  it("runs queued jobs strictly one at a time", async () => {
    const gate = gateWithoutLoad();
    let concurrent = 0;
    let peak = 0;
    const job = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await tick(15);
      concurrent -= 1;
      return "ok";
    };
    const results = await Promise.all([gate.run("a", job), gate.run("b", job), gate.run("c", job)]);
    expect(results).toEqual(["ok", "ok", "ok"]);
    expect(peak).toBe(1);
  });

  it("grants queued slots in FIFO order", async () => {
    const gate = gateWithoutLoad();
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
      await tick(10);
    };
    const first = gate.run("first", job("first"));
    await tick(1); // let the first slot grant settle before queueing the rest
    const rest = Promise.all([
      gate.run("second", job("second")),
      gate.run("third", job("third")),
      gate.run("fourth", job("fourth")),
    ]);
    await rest;
    await first;
    expect(order).toEqual(["first", "second", "third", "fourth"]);
  });

  it("supports a concurrency above one when explicitly configured", async () => {
    const gate = gateWithoutLoad({ concurrency: 2 });
    let concurrent = 0;
    let peak = 0;
    const job = async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await tick(15);
      concurrent -= 1;
    };
    await Promise.all([gate.run("a", job), gate.run("b", job), gate.run("c", job)]);
    expect(peak).toBe(2);
  });

  it("holds a job back while the machine is overloaded and starts it once load drops", async () => {
    let load = 10;
    const gate = new PostProcessGate({ loadAverage: () => load, cores: 1, pollMs: 5 });
    let started = false;
    const run = gate.run("remux", async () => { started = true; });
    await tick(30);
    expect(started).toBe(false);
    expect(gate.status().saturated).toBe(true);
    load = 0.5; // below resume threshold (0.8 * 1 core)
    await run;
    expect(started).toBe(true);
    expect(gate.status()).toMatchObject({ saturated: false, active: 0, queued: 0 });
  });

  it("uses hysteresis: stays paused between the pause and resume thresholds", async () => {
    let load = 2; // cores=1: pause at 1.5, resume at 0.8
    const gate = new PostProcessGate({ loadAverage: () => load, cores: 1, pollMs: 5 });
    let started = false;
    const run = gate.run("remux", async () => { started = true; });
    await tick(20);
    expect(started).toBe(false);
    load = 1.0; // below pause threshold but above resume: must stay paused (no flapping)
    await tick(20);
    expect(started).toBe(false);
    load = 0.4;
    await run;
    expect(started).toBe(true);
  });

  it("does not latch forever on a misconfigured threshold pair", async () => {
    // resume >= pause is invalid; the gate must disable the load check entirely.
    const gate = new PostProcessGate({ loadAverage: () => 50, cores: 1, pollMs: 5, loadPauseFactor: 1.5, loadResumeFactor: 2 });
    let started = false;
    await gate.run("remux", async () => { started = true; });
    expect(started).toBe(true);
    expect(gate.status().saturated).toBe(false);
  });

  it("releases the slot when a job throws, so the next job still runs", async () => {
    const gate = gateWithoutLoad();
    await expect(gate.run("bad", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(gate.run("good", async () => "fine")).resolves.toBe("fine");
    expect(gate.status().active).toBe(0);
  });

  it("never blocks when the platform reports no load average (Windows zeros)", async () => {
    const gate = new PostProcessGate({ loadAverage: () => 0, pollMs: 5 });
    const begin = Date.now();
    await gate.run("remux", async () => "done");
    expect(Date.now() - begin).toBeLessThan(1000);
  });

  it("reports queued waiters and slot usage through status()", async () => {
    const gate = gateWithoutLoad();
    const release: Array<() => void> = [];
    const run1 = gate.run("a", () => new Promise<void>((resolve) => release.push(resolve)));
    const run2 = gate.run("b", () => new Promise<void>((resolve) => release.push(resolve)));
    await tick(5);
    expect(gate.status()).toMatchObject({ active: 1, queued: 1 });
    release[0]();
    await run1;
    await tick(5); // let the granted slot hand off and job b actually start
    expect(gate.status()).toMatchObject({ active: 1, queued: 0 });
    release[1]();
    await run2;
    expect(gate.status()).toMatchObject({ active: 0, queued: 0 });
  });

  it("emits pause/resume log lines through the injected logger", async () => {
    let load = 10;
    const log = vi.fn();
    const gate = new PostProcessGate({ loadAverage: () => load, cores: 1, pollMs: 5, log });
    const run = gate.run("remux", async () => undefined);
    await tick(20);
    load = 0.2;
    await run;
    const messages = log.mock.calls.map((call) => call[1]);
    expect(messages).toContain("Post-process paused while the system is overloaded");
    expect(messages).toContain("Post-process resumed after load dropped");
  });

  it("fromEnv falls back to defaults when the variables are missing or garbage", async () => {
    const previous = { ...process.env };
    try {
      delete process.env.EASYX_POSTPROCESS_CONCURRENCY;
      delete process.env.EASYX_POSTPROCESS_LOAD_PAUSE;
      process.env.EASYX_POSTPROCESS_LOAD_RESUME = "not-a-number";
      const gate = PostProcessGate.fromEnv();
      expect(gate.status().saturated).toBe(false);
      // The gate is functional: a trivial job runs immediately at load 0.
      await expect(gate.run("check", async () => "ok")).resolves.toBe("ok");
    } finally {
      process.env = previous;
    }
  });
});
