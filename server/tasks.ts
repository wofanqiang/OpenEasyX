/**
 * In-process registry of long-running background jobs (Library merge, Recovery remux).
 *
 * Why not an `items` row: the Activity page already lists the download pipeline, and these jobs
 * are not downloads -- they have no plugin, no source, and no retry semantics. Giving them a fake
 * item would leak into `statusCounts`, `retryFailedItems` and every "active downloads" figure.
 * Instead they live in their own map and are aggregated into the Activity view by `/api/tasks`,
 * where the UI renders them as their own row kind beside the recordings.
 *
 * Lifetime is deliberately bounded: a job is registered when it starts and drops out of `list()`
 * a short grace period after it reaches a terminal state, so the Activity page sees the "done"
 * moment without the list growing forever. Everything is in memory -- a restart loses the record,
 * which for a self-hosted single-user app only means the operator can start the job again.
 *
 * The registry never owns the work: a job's executor registers a `cancel` hook, and the executor
 * is the one that cleans up (killing ffmpeg, removing a partial file). Cancelling here only flips
 * the status the UI reads and fires that hook.
 */

export type TaskKind = "merge" | "recover";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type TaskPhase = "waiting" | "probing" | "merging" | "indexing" | "removing" | "finished";

/** What the API returns. `progress` is a 0..1 fraction, or null when the step has no measurable end. */
export type TaskSnapshot = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  phase: TaskPhase;
  /** Headline, e.g. "Merging 3 videos". */
  label: string;
  /** Current step, target file, or current item. */
  detail: string;
  progress: number | null;
  done: number;
  total: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** Scalar summary of the finished job; array-valued fields are dropped before serialization. */
  result?: Record<string, unknown>;
};

type TaskRecord = TaskSnapshot & {
  cancel?: () => void;
  /** Internal ids this job reads, so a merge can protect its sources while it runs. Never serialized. */
  sourceIds?: string[];
  /** Whether the job ever reported a measurable percentage. */
  measured?: boolean;
};

export type TaskUpdate = Partial<Pick<TaskSnapshot, "phase" | "label" | "detail" | "progress" | "done" | "total">>;

/** A handle the executor drives. Every method is safe to call after the job has settled. */
export type TaskHandle = {
  readonly id: string;
  /** Applies a patch and promotes `queued` to `running` on the first call. */
  update(patch: TaskUpdate): void;
  finish(result?: Record<string, unknown>): void;
  fail(error: string): void;
  isCancelled(): boolean;
  /** Registered by the executor so `cancel()` can actually stop the work. */
  setCancel(cancel: () => void): void;
};

/** How long a finished job stays in the Activity list so its "done" moment is visible. */
export const TASK_TTL_MS = 30_000;

const isTerminal = (status: TaskStatus): boolean => status === "done" || status === "failed" || status === "cancelled";

/**
 * Reports carry a long per-item list (`items`) that the UI never reads -- it refreshes the real
 * lists from their own endpoints. Keeping only scalars stops `/api/tasks` from growing with the
 * size of the sweep it describes.
 */
function summarize(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    const type = typeof value;
    if (value === null || type === "string" || type === "number" || type === "boolean") out[key] = value;
  }
  return out;
}

export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private sequence = 0;

  constructor(private readonly now: () => number = () => Date.now(), private readonly ttlMs: number = TASK_TTL_MS) {}

  create(input: { kind: TaskKind; label: string; detail?: string; total?: number; sourceIds?: string[] }): TaskHandle {
    const id = `task-${this.now().toString(36)}-${(++this.sequence).toString(36)}`;
    this.records.set(id, {
      id, kind: input.kind, status: "queued", phase: "waiting",
      label: input.label, detail: input.detail ?? "", progress: null,
      done: 0, total: Math.max(0, Math.trunc(input.total ?? 0)), createdAt: this.now(),
      sourceIds: input.sourceIds,
    });
    this.sweep();
    return {
      id,
      update: (patch) => this.applyUpdate(id, patch),
      finish: (result) => this.settle(id, "done", undefined, result),
      fail: (error) => this.settle(id, "failed", error),
      isCancelled: () => this.records.get(id)?.status === "cancelled",
      setCancel: (cancel) => { const record = this.records.get(id); if (record && !isTerminal(record.status)) record.cancel = cancel; },
    };
  }

  get(id: string): TaskSnapshot | undefined {
    this.sweep();
    const record = this.records.get(id);
    return record ? this.serialize(record) : undefined;
  }

  /** Active jobs plus the recently-finished ones, oldest first so rows do not reorder as they expire. */
  list(): TaskSnapshot[] {
    this.sweep();
    return [...this.records.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => this.serialize(record));
  }

  /** Ids referenced by running merge jobs, so callers can protect their sources from deletion. */
  activeSourceIds(): string[] {
    const ids = new Set<string>();
    for (const record of this.records.values()) {
      if (isTerminal(record.status)) continue;
      for (const id of record.sourceIds ?? []) ids.add(id);
    }
    return [...ids];
  }

  cancel(id: string): TaskSnapshot | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (!isTerminal(record.status)) {
      // Flip the status the UI reads first, then let the executor tear its own work down. Its own
      // `finish`/`fail` calls become no-ops once the record is terminal.
      this.settle(id, "cancelled");
      try { record.cancel?.(); }
      catch { /* The executor owns its cleanup; a throwing hook must not break the request. */ }
    }
    return this.serialize(record);
  }

  private applyUpdate(id: string, patch: TaskUpdate): void {
    const record = this.records.get(id);
    if (!record || isTerminal(record.status)) return;
    if (record.status === "queued") { record.status = "running"; record.startedAt = this.now(); }
    if (patch.progress !== undefined && patch.progress !== null) record.measured = true;
    Object.assign(record, patch);
  }

  private settle(id: string, status: TaskStatus, error?: string, result?: Record<string, unknown>): void {
    const record = this.records.get(id);
    if (!record || isTerminal(record.status)) return;
    record.status = status;
    record.phase = "finished";
    record.finishedAt = this.now();
    if (error) record.error = error;
    if (result) record.result = result;
    // A job that never reported a percentage (a pure scan-and-delete sweep, or one stopped before
    // it measured anything) stays indeterminate instead of claiming 100%; one that did, finishes
    // on exactly 1 even though its last phase (indexing) reported no percentage of its own.
    record.progress = status === "done" && record.measured ? 1 : null;
  }

  /** Lazy expiry -- no timer to leak, and a job that is never listed again is simply dropped. */
  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, record] of this.records) {
      if (isTerminal(record.status) && (record.finishedAt ?? record.createdAt) <= cutoff) this.records.delete(id);
    }
  }

  private serialize(record: TaskRecord): TaskSnapshot {
    const { cancel: _cancel, sourceIds: _sourceIds, measured: _measured, result, ...rest } = record;
    return result ? { ...rest, result: summarize(result) } : { ...rest };
  }
}
