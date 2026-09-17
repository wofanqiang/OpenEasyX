import type { Database, DownloadItem } from "./database.js";
import type { LiveCamService } from "./live-cams.js";
import type { LiveCam } from "../packages/plugin-sdk/index.js";
import { freeBytes, recordingDiskGuard, type FreeSpaceProbe } from "./disk-space.js";
import { isOfflineConfirmedError } from "./offline-error.js";

// Download statuses that mean "a recording for this cam is still in flight".
// Mirrors the buckets used by Database.listItems(); kept local to avoid coupling.
const ACTIVE_STATUSES = new Set(["queued", "downloading", "paused", "stopping", "cancelling"]);
// After a recording ends, wait before auto-starting another one for the same cam so a
// flapping online/offline edge (or a stale cached snapshot) cannot trigger a loop.
// The base cooldown is configurable (autoRecordCooldownSeconds); a failed capture starts on a
// short abnormal cooldown and then doubles for each consecutive failure.
// The escalation has to key off a failure *count*, not a short sliding window: a room that reports
// "live" but never yields a recordable stream burns minutes per attempt (the download retries with
// exponential backoff before failing), so a 3-failures-in-5-minutes rule can never fire and the
// watcher would restart such a room forever on the flat cooldown.
const COOLDOWN_FALLBACK_MS = 120_000;
const ABNORMAL_COOLDOWN_MS = 30_000;
// A failure this long after the previous one starts a fresh streak. It has to comfortably exceed the
// cooldown cap above plus one capture attempt (minutes of download retries) so a streak is not
// wiped by its own backoff; a cam that has been quiet for hours still starts fresh.
const FAIL_STREAK_RESET_MS = 3 * 60 * 60_000;
// Ceiling for the failure backoff: a persistently broken room is retried at most hourly.
const FAIL_COOLDOWN_CAP_MS = 60 * 60_000;
// Settings bounds for the status-check interval (seconds).
const INTERVAL = { min: 30, max: 3600, fallback: 60 };
const LIVE_ITEM = /^(?:auto|manual)-live:([^:]+):/;

export type AutoRecorder = {
  stop: () => void;
  tick: () => Promise<void>;
  // A manual stop means "not this session": the cam stays paused until the room goes
  // offline, so the watcher never fights the user by restarting the same broadcast.
  suppress: (providerId: string, username: string) => void;
  clearSuppression: (providerId: string, username: string) => boolean;
};

export function startAutoRecorder({ db, liveCams, log, mediaRoot, freeSpace = freeBytes }: {
  db: Database;
  liveCams: LiveCamService;
  log?: (message: string) => void;
  /** Filesystem watched for free space before a recording is opened. */
  mediaRoot: string;
  /** Injectable probe so the disk guard is testable without filling a real volume. */
  freeSpace?: FreeSpaceProbe;
}): AutoRecorder {
  // providerId:usernameLower -> itemId of the recording we are tracking.
  const active = new Map<string, { itemId: string }>();
  const cooldowns = new Map<string, number>();
  // providerId:usernameLower -> cams the user stopped by hand. Cleared once the room
  // goes offline so the next session is recorded again.
  const suppressed = new Set<string>();
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  // Consecutive failed captures per cam, used to escalate the cooldown instead of restarting a
  // broken room on the flat abnormal cooldown forever.
  const failStreak = new Map<string, { count: number; at: number }>();
  // Tracks the disk guard so the log gets one line per transition, not one per tick.
  let diskPaused = false;

  const keyOf = (providerId: string, username: string) => `${providerId}:${username.trim().toLowerCase()}`;

  const intervalSeconds = (): number => {
    const raw = Number(db.getSettings().autoRecordCheckSeconds);
    if (!Number.isFinite(raw)) return INTERVAL.fallback;
    return Math.min(INTERVAL.max, Math.max(INTERVAL.min, raw));
  };

  // Configurable base cooldown between auto-recordings of the same cam. Falls back to
  // COOLDOWN_FALLBACK_MS when unset, and is clamped so a huge value cannot stall the watcher.
  const cooldownMs = (): number => {
    const raw = Number(db.getSettings().autoRecordCooldownSeconds);
    if (!Number.isFinite(raw) || raw < 0) return COOLDOWN_FALLBACK_MS;
    return Math.min(3600_000, raw * 1000);
  };

  // Reconcile the in-memory active set with the DB on every tick: recordings that were
  // in flight when the process (re)started keep blocking new auto-starts for the same cam,
  // and recordings that finished (or vanished) move their cam onto the cooldown list.
  // A live item is identified by the same metadata the downloader keys on, with the
  // external-id prefix kept as a fallback for rows written before that field existed. The room
  // key covers every entry point, so a capture a scraper queued blocks an auto-start just like
  // one the watcher itself started (it used to be invisible, which let the watcher stack a
  // second recording onto the same broadcast).
  const isLiveItem = (item: DownloadItem) =>
    (item.metadata as Record<string, unknown> | undefined)?.live === true || LIVE_ITEM.test(item.externalId);
  const liveRoomOf = (item: DownloadItem): string | undefined => {
    const meta = item.metadata as Record<string, unknown> | undefined;
    const declared = typeof meta?.liveRoom === "string" ? meta.liveRoom : undefined;
    return (declared ?? LIVE_ITEM.exec(item.externalId)?.[1])?.trim().toLowerCase();
  };

  const syncActive = () => {
    const liveKeys = new Map<string, string>();
    for (const item of db.listItems(300)) {
      if (!ACTIVE_STATUSES.has(item.status) || !isLiveItem(item)) continue;
      const room = liveRoomOf(item);
      if (room) liveKeys.set(`${item.pluginId}:${room}`, item.id);
    }
    for (const [key, itemId] of liveKeys) if (!active.has(key)) active.set(key, { itemId });
    const now = Date.now();
    for (const [key, entry] of [...active]) {
      if (liveKeys.has(key)) continue;
      active.delete(key);
      // A manually stopped recording is guarded by the suppression flag, which is cleared
      // by an offline transition. Adding a cooldown too would delay the next session.
      if (suppressed.has(key)) {
        log?.(`auto-record: recording ${entry.itemId} stopped by hand; ${key} stays paused until the room goes offline`);
        continue;
      }
      // Grade the cooldown by how the recording ended. A failed run is "abnormal": the
      // stream likely blipped, so a short cooldown lets a quick recovery retry soon without
      // hammering a cam that is genuinely offline. Each additional failure in a row doubles the
      // wait (capped), because a room that keeps reporting "live" without ever yielding a
      // recordable capture would otherwise churn the queue at the flat cooldown forever.
      const ended = db.getItem(entry.itemId);
      const failed = ended?.status === "failed";
      let until: number;
      if (failed) {
        const previous = failStreak.get(key);
        const streak = previous && now - previous.at <= FAIL_STREAK_RESET_MS ? previous.count + 1 : 1;
        failStreak.set(key, { count: streak, at: now });
        // A provider-confirmed offline (the room page itself said so) is not a stream blip:
        // starting the wait at the short abnormal cooldown would re-render the room page and
        // re-fail every 30s. Jump straight to the back-off ceiling; the status-cache override
        // (see live-cams.reportLiveFailure) keeps the poll from queueing one at all.
        if (isOfflineConfirmedError(ended?.error)) {
          until = now + FAIL_COOLDOWN_CAP_MS;
          log?.(`auto-record: ${key} failed with a confirmed-offline error; cooling down ${Math.round(FAIL_COOLDOWN_CAP_MS / 60000)}m`);
        } else if (streak === 1) {
          until = now + Math.min(cooldownMs(), ABNORMAL_COOLDOWN_MS);
          log?.(`auto-record: recording ${entry.itemId} failed; ${key} enters a short cooldown`);
        } else {
          until = now + Math.min(ABNORMAL_COOLDOWN_MS * 2 ** (streak - 1), FAIL_COOLDOWN_CAP_MS);
          log?.(`auto-record: ${key} has failed ${streak} captures in a row; backing off ${Math.round((until - now) / 1000)}s`);
        }
      } else {
        failStreak.delete(key);
        until = now + cooldownMs();
        log?.(`auto-record: recording ${entry.itemId} finished; ${key} enters cooldown`);
      }
      cooldowns.set(key, until);
    }
    for (const [key, until] of cooldowns) if (until < now) cooldowns.delete(key);
    // Drop streaks that have gone quiet so the map cannot grow unbounded across many cams, and so a
    // cam that fails only rarely always restarts from the short first-failure cooldown.
    for (const [key, entry] of failStreak) if (now - entry.at > FAIL_STREAK_RESET_MS) failStreak.delete(key);
  };

  const tick = async () => {
    if (running) return; // a previous cycle is still in flight; skip this round
    running = true;
    try {
      syncActive();

      // A full disk fails late and loudly (ffmpeg dies mid-write), so the floor is checked
      // before anything is queued. Skipping the whole poll also stops burning provider
      // requests while nothing could be recorded anyway.
      const disk = await recordingDiskGuard(db.getSettings(), mediaRoot, freeSpace);
      if (disk.paused) {
        if (!diskPaused) {
          diskPaused = true;
          log?.(`auto-record: paused; only ${(disk.freeGb ?? 0).toFixed(2)} GB free on the media disk, below the ${disk.thresholdGb} GB floor`);
        }
        return;
      }
      if (diskPaused) {
        diskPaused = false;
        log?.(`auto-record: resumed; ${(disk.freeGb ?? 0).toFixed(2)} GB free on the media disk`);
      }

      // Poll every favorite armed directly and every performer armed through its live-cam
      // identity, so a performer without a saved favorite is recorded just the same.
      const byProvider = new Map<string, Array<{ username: string; pageUrl: string }>>();
      for (const target of liveCams.autoRecordTargets()) {
        const list = byProvider.get(target.providerId) ?? [];
        list.push({ username: target.username, pageUrl: target.pageUrl });
        byProvider.set(target.providerId, list);
      }

      for (const [providerId, targets] of byProvider) {
        let items: LiveCam[];
        try {
          // Shares the per-cam status cache with the favorites path (getLiveCam TTL 60s), so the
          // watcher adds no extra provider traffic beyond refreshing stale snapshots.
          const result = await liveCams.autoRecordStatuses(providerId, targets);
          if (!result.ok) {
            log?.(`auto-record: ${providerId} status check failed: ${result.error ?? "unknown error"}`);
            continue;
          }
          items = result.cams;
        } catch (error) {
          log?.(`auto-record: ${providerId} status check threw: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        for (const cam of items) {
          const usernameKey = cam.username.trim().toLowerCase();
          if (!targets.some((target) => target.username.trim().toLowerCase() === usernameKey)) continue;
          const key = keyOf(providerId, cam.username);
          if (active.has(key)) continue;
          if (suppressed.has(key)) {
            // Only a real offline transition ends the current session; an uncertain
            // status must not silently lift the pause the user asked for.
            if (cam.online === false) {
              suppressed.delete(key);
              log?.(`auto-record: ${cam.username} went offline; auto-record resumes with the next session`);
            }
            continue;
          }
          if ((cooldowns.get(key) ?? 0) > Date.now()) continue;
          // Never auto-start from an uncertain status; missing a few minutes is better
          // than recording a room that is actually offline.
          if (cam.online === false || cam.statusUnavailable) continue;
          try {
            const { itemId } = await liveCams.record(providerId, cam, { origin: "auto" });
            active.set(key, { itemId });
            log?.(`auto-record: ${cam.username} is live; recording started (${itemId})`);
          } catch (error) {
            log?.(`auto-record: could not start recording for ${cam.username}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      // A rejected tick must not break the chain, or the watcher would silently stop
      // rescheduling itself and auto-recording would never run again.
      try {
        await tick();
      } catch (error) {
        log?.(`auto-record: polling cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!stopped) schedule();
    }, intervalSeconds() * 1000);
    timer.unref();
  };

  const suppress = (providerId: string, username: string) => {
    const key = keyOf(providerId, username);
    suppressed.add(key);
    log?.(`auto-record: manual stop for ${key}; skipped until the room goes offline`);
  };

  const clearSuppression = (providerId: string, username: string) => {
    const key = keyOf(providerId, username);
    if (!suppressed.delete(key)) return false;
    log?.(`auto-record: ${key} pause lifted; auto-record can start again`);
    return true;
  };

  schedule();
  return {
    stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = undefined; },
    tick,
    suppress,
    clearSuppression,
  };
}
