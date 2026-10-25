import os from "node:os";

/**
 * Load gate for *starting* live captures -- the counterpart to PostProcessGate, with the opposite
 * trade-off.
 *
 * Post-processing holds its slot and waits for a quiet machine, because the bytes are already on
 * disk: waiting only delays a "finished" timestamp. Starting a capture is different. A capture
 * started on an already overloaded box makes the overload worse -- every capture then falls behind
 * the live edge, which is what turns a busy minute into a failed recording -- while the broadcast is
 * still there a minute later. So the right answer is to decline this attempt and ask again on the
 * next tick, which the queue delivers one second later.
 *
 * Three consequences of that difference, all deliberate:
 *  - it never blocks: `allowsStart()` returns a verdict, and a declined tick simply starts nothing;
 *  - it never queues a waiter, so nothing can pile up behind it;
 *  - it never touches a capture that is already running: stopping one throws away content that
 *    cannot be fetched again. Only the concurrency ceiling can shrink a running pool.
 *
 * Thresholds sit *above* the post-processing ones, so the priority ladder is explicit: captures
 * resume first (1.8), post-processing comes back last (0.8).
 *
 * On Windows `os.loadavg()` reports zeros, which makes the gate a no-op there -- developer machines
 * are unaffected, exactly as with the post-processing gate.
 */
export interface CaptureStartGateOptions {
  /** Decline starts while loadavg1 >= cores * factor (default 2.5). */
  loadPauseFactor?: number;
  /** Resume once loadavg1 <= cores * factor (default 1.8); must be below the pause factor. */
  loadResumeFactor?: number;
  /**
   * Longest the gate may keep declining before one capture is let through (default 600s).
   *
   * Without the escape hatch, a high load from something other than captures -- a runaway process,
   * a disk rebuild -- would hold every new recording out for as long as it lasted. `0` disables it.
   */
  starveSeconds?: number;
  /** Injectable CPU count for tests (default os.cpus().length, floored at 1). */
  cores?: number;
  /** Injectable load source for tests (default os.loadavg()[0]). */
  loadAverage?: () => number;
  log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
}

export class CaptureStartGate {
  private readonly pauseFactor: number;
  private readonly resumeFactor: number;
  private readonly starveSeconds: number;
  private readonly cores: number;
  private readonly loadAverage: () => number;
  private readonly log?: CaptureStartGateOptions["log"];
  /** Hysteresis latch: once paused, stay paused until the load drops below the resume line. */
  private paused = false;
  private pausedSince = 0;

  constructor(options: CaptureStartGateOptions = {}) {
    const pause = options.loadPauseFactor ?? 2.5;
    const resume = options.loadResumeFactor ?? 1.8;
    // A misconfigured pair (resume >= pause) would latch forever, so the gate switches itself off
    // instead of holding every capture out.
    const valid = pause > resume && pause > 0 && resume >= 0;
    this.pauseFactor = valid ? pause : Number.POSITIVE_INFINITY;
    this.resumeFactor = valid ? resume : 0;
    this.starveSeconds = Math.max(0, options.starveSeconds ?? 600);
    this.cores = options.cores ?? (os.cpus().length || 1);
    this.loadAverage = options.loadAverage ?? (() => os.loadavg()[0] ?? 0);
    this.log = options.log;
  }

  static fromEnv(log?: CaptureStartGateOptions["log"]): CaptureStartGate {
    const number = (name: string): number | undefined => {
      const raw = Number(process.env[name]);
      return process.env[name] !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
    };
    return new CaptureStartGate({
      loadPauseFactor: number("EASYX_CAPTURE_LOAD_PAUSE") ?? 2.5,
      loadResumeFactor: number("EASYX_CAPTURE_LOAD_RESUME") ?? 1.8,
      starveSeconds: number("EASYX_CAPTURE_LOAD_MAX_WAIT_SECONDS") ?? 600,
      log,
    });
  }

  /** Called once per queue tick; the answer applies to every capture that tick would have started. */
  allowsStart(): boolean {
    const load = this.loadAverage();
    const pauseAt = this.cores * this.pauseFactor;
    const resumeAt = this.cores * this.resumeFactor;
    if (this.paused && load <= resumeAt) {
      this.paused = false;
      this.log?.("info", "Capture starts resumed after the load dropped", { load, resumeAt, cores: this.cores });
    } else if (!this.paused && load >= pauseAt) {
      this.paused = true;
      this.pausedSince = Date.now();
      this.log?.("warn", "Capture start paused while the system is overloaded", { load, pauseAt, cores: this.cores });
    }
    if (!this.paused) return true;
    const waitedSeconds = (Date.now() - this.pausedSince) / 1000;
    if (this.starveSeconds > 0 && waitedSeconds >= this.starveSeconds) {
      // Having decided to work under load, do not re-decide for the next capture: a box that stays
      // busy for another reason would otherwise hold every room out indefinitely.
      this.paused = false;
      this.log?.("warn", "Capture started without a quiet load window", { load, waitedSeconds, cores: this.cores });
      return true;
    }
    return false;
  }

  /** Snapshot for diagnostics and tests. */
  status(): { paused: boolean; load: number; pauseAt: number } {
    return { paused: this.paused, load: this.loadAverage(), pauseAt: this.cores * this.pauseFactor };
  }
}
