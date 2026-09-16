import os from "node:os";

/**
 * Serialized, load-aware gate for post-processing work (concat fold, TS remux, re-encode).
 *
 * Why it exists: every download/recording worker runs its own post-processing inline, so N
 * finishing captures can start N concurrent ffmpeg remuxes with no coordination at all. On a
 * small VPS that is fatal -- the audio re-encode plus the `+faststart` rewrite of several
 * concurrent remuxes saturate the CPU, iowait spikes, and the *live captures* (which cannot
 * afford to fall behind the HLS live edge) starve: measured on a 1-core box, capture
 * throughput collapsed from ~700 KB/s per stream to ~0 while loadavg passed 13.
 *
 * Two mechanisms, both invisible to the capture path:
 *  1. Serialization: at most `concurrency` (default 1) post-process command runs at a time,
 *     granted strictly FIFO. Post-processing is a *concluding* step -- the capture bytes are
 *     already on disk -- so waiting costs nothing except a later "finished" timestamp.
 *  2. Load gate: a job that got a slot still holds it until the 1-minute load average drops
 *     back under `cores * loadResumeFactor` after having exceeded `cores * loadPauseFactor`
 *     (hysteresis, so a machine hovering near one threshold does not flap). On platforms
 *     without a meaningful load average (Windows reports zeros) the gate is a no-op, which
 *     keeps developer machines unaffected.
 *
 * The gate never kills or interrupts anything: it only delays starts. Stop/cancel semantics
 * are untouched -- a cancelled item fails the moment its command would have run, exactly as
 * before.
 */
export interface PostProcessGateOptions {
  /** Maximum simultaneous post-process commands (default 1). */
  concurrency?: number;
  /** Pause new jobs while loadavg1 >= cores * factor (default 1.5). */
  loadPauseFactor?: number;
  /** Resume paused jobs once loadavg1 <= cores * factor (default 0.8); must be < pause. */
  loadResumeFactor?: number;
  /** Re-check interval while paused (default 5000ms). */
  pollMs?: number;
  /** Injectable CPU count for tests (default os.cpus().length, floored at 1). */
  cores?: number;
  /** Injectable load source for tests (default os.loadavg()[0]; 0 disables the gate). */
  loadAverage?: () => number;
  log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

export class PostProcessGate {
  private readonly concurrency: number;
  private readonly loadPauseFactor: number;
  private readonly loadResumeFactor: number;
  private readonly pollMs: number;
  private readonly cores: number;
  private readonly loadAverage: () => number;
  private readonly log?: PostProcessGateOptions["log"];
  /** Slots currently granted (including jobs still waiting for the load window). */
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  /** Hysteresis latch: once overloaded, stay paused until load drops below the resume line. */
  private saturated = false;

  constructor(options: PostProcessGateOptions = {}) {
    const pause = options.loadPauseFactor ?? 1.5;
    const resume = options.loadResumeFactor ?? 0.8;
    // A misconfigured pair (resume >= pause) could latch forever; disable the load gate
    // instead -- serialization alone is already the important part.
    const valid = pause > resume && pause > 0 && resume >= 0;
    this.concurrency = Math.max(1, Math.trunc(options.concurrency ?? 1));
    this.loadPauseFactor = valid ? pause : Number.POSITIVE_INFINITY;
    this.loadResumeFactor = valid ? resume : 0;
    this.pollMs = Math.max(100, options.pollMs ?? 5000);
    this.cores = options.cores ?? (os.cpus().length || 1);
    this.loadAverage = options.loadAverage ?? (() => os.loadavg()[0] ?? 0);
    this.log = options.log;
  }

  /**
   * Build a gate from environment overrides. Unparsable values fall back to the defaults
   * above, so a bad variable can only relax/tighten the limits, never break post-processing.
   */
  static fromEnv(log?: PostProcessGateOptions["log"]): PostProcessGate {
    const number = (name: string): number | undefined => {
      const raw = Number(process.env[name]);
      return Number.isFinite(raw) && raw > 0 ? raw : undefined;
    };
    return new PostProcessGate({
      concurrency: number("EASYX_POSTPROCESS_CONCURRENCY") ?? 1,
      loadPauseFactor: number("EASYX_POSTPROCESS_LOAD_PAUSE") ?? 1.5,
      loadResumeFactor: number("EASYX_POSTPROCESS_LOAD_RESUME") ?? 0.8,
      log,
    });
  }

  /** Current snapshot, for diagnostics endpoints and tests. */
  status(): { active: number; queued: number; saturated: boolean } {
    return { active: this.active, queued: this.waiters.length, saturated: this.saturated };
  }

  /** Run `job` holding exactly one post-process slot, FIFO among concurrent callers. */
  async run<T>(label: string, job: () => Promise<T>): Promise<T> {
    await this.acquireSlot(label);
    try {
      await this.waitForLoadWindow(label);
      return await job();
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * The slot is granted synchronously inside `pump()` (before the waiter's microtask even
   * runs), so between a release and the next grant no third caller can slip past the queue:
   * every acquire goes through `waiters`, giving strict FIFO without over-subscription.
   */
  private acquireSlot(label: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const begin = Date.now();
      this.waiters.push(() => {
        const waitedMs = Date.now() - begin;
        if (waitedMs > 250) this.log?.("info", "Post-process started after waiting for a slot", { label, waitedMs });
        resolve();
      });
      this.pump();
    });
  }

  private releaseSlot(): void {
    this.active -= 1;
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiters.length > 0) {
      this.active += 1;
      this.waiters.shift()!();
    }
  }

  /**
   * Hold the already-granted slot until the machine is ready to spend CPU on post-processing.
   * Holding (rather than re-queueing) is deliberate: the waiter is next in line anyway, and
   * the slot buys nothing else meanwhile.
   */
  private async waitForLoadWindow(label: string): Promise<void> {
    for (;;) {
      const load = this.loadAverage();
      if (this.saturated) {
        if (load <= this.cores * this.loadResumeFactor) {
          this.saturated = false;
          this.log?.("info", "Post-process resumed after load dropped", { label, load, cores: this.cores });
          return;
        }
      } else if (load >= this.cores * this.loadPauseFactor) {
        this.saturated = true;
        this.log?.("warn", "Post-process paused while the system is overloaded", { label, load, cores: this.cores });
      } else {
        return;
      }
      await delay(this.pollMs);
    }
  }
}
