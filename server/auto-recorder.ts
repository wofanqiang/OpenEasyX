import type { Database, DownloadItem } from "./database.js";
import type { LiveCamService } from "./live-cams.js";
import type { LiveCam } from "../packages/plugin-sdk/index.js";
import { freeBytes, recordingDiskGuard, type FreeSpaceProbe } from "./disk-space.js";

// Download statuses that mean "a recording for this cam is still in flight".
// Mirrors the buckets used by Database.listItems(); kept local to avoid coupling.
const ACTIVE_STATUSES = new Set(["queued", "downloading", "paused", "stopping", "cancelling"]);
const LIVE_ITEM = /^(?:auto|manual)-live:([^:]+):/;
// Settings bounds for the status-check interval (seconds).
const INTERVAL = { min: 30, max: 3600, fallback: 60 };

export type AutoRecorder = {
  stop: () => void;
  tick: () => Promise<void>;
};

/**
 * The auto-record watcher.
 *
 * One rule, asked once per interval: is this room in a public show? If it is, record it; if it is
 * not, do nothing. There is no retry ladder and no cooldown between attempts, because the answer
 * to "should this be recording" is the room's own status rather than a timer -- a room that
 * finishes a session and is still public is recorded again on the next pass, and one that has
 * gone private is simply skipped.
 *
 * The switch is the performer's auto-record flag: arming is the only thing that puts a room into
 * this loop, and disarming is the only thing that takes it out. Stopping a recording by hand
 * therefore disarms the performer (see `disarmAutoRecordForItem` in index.ts) instead of leaving
 * behind a pause the user cannot see.
 *
 * Two guards remain, and neither of them delays a genuinely public room:
 *  - a room already being captured is filtered out before the status call, so no provider request
 *    is spent on a question whose answer cannot change anything;
 *  - a room whose capture just failed with the provider's own "not live" verdict is reported
 *    offline for ten minutes by the status cache (see `reportLiveFailure` in live-cams.ts), so a
 *    status API that lags reality cannot make the watcher re-queue it every single minute.
 */
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
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  // Tracks the disk guard so the log gets one line per transition, not one per tick.
  let diskPaused = false;

  const keyOf = (providerId: string, username: string) => `${providerId}:${username.trim().toLowerCase()}`;

  const intervalSeconds = (): number => {
    const raw = Number(db.getSettings().autoRecordCheckSeconds);
    if (!Number.isFinite(raw)) return INTERVAL.fallback;
    return Math.min(INTERVAL.max, Math.max(INTERVAL.min, raw));
  };

  const isLiveItem = (item: DownloadItem) =>
    (item.metadata as Record<string, unknown> | undefined)?.live === true || LIVE_ITEM.test(item.externalId);
  const liveRoomOf = (item: DownloadItem): string | undefined => {
    const meta = item.metadata as Record<string, unknown> | undefined;
    const declared = typeof meta?.liveRoom === "string" ? meta.liveRoom : undefined;
    return (declared ?? LIVE_ITEM.exec(item.externalId)?.[1])?.trim().toLowerCase();
  };

  // Reconcile the in-memory active set with the DB on every tick: recordings that are genuinely
  // capturing, and nothing else. A capture whose ffmpeg has already exited is over as far as the
  // room is concerned -- the item stays `downloading` while it is packaged, but that work no
  // longer occupies the broadcast, so the room is free to be recorded again from that moment.
  const syncActive = () => {
    const liveKeys = new Map<string, string>();
    for (const item of db.listItems(300)) {
      if (!ACTIVE_STATUSES.has(item.status) || !isLiveItem(item)) continue;
      if (item.captureEndedAt) continue;
      const room = liveRoomOf(item);
      if (room) liveKeys.set(`${item.pluginId}:${room}`, item.id);
    }
    for (const [key, itemId] of liveKeys) if (!active.has(key)) active.set(key, { itemId });
    for (const key of [...active.keys()]) if (!liveKeys.has(key)) active.delete(key);
  };

  /**
   * Whether this room is in a public show right now.
   *
   * A provider that publishes a room status is trusted over its `online` flag: Stripchat answers
   * `isOnline`/`isLive` for private and group-show rooms alike (measured: 60 of 60 rooms online,
   * four of them `groupShow`), so the flag alone queues captures that can only fail. Where a
   * provider has no status vocabulary, `online` stays the only signal -- and an uncertain status
   * is still never good enough to start from.
   */
  const isPublicRoom = (cam: LiveCam): boolean => {
    if (cam.statusUnavailable) return false;
    if (cam.online === false) return false;
    return cam.status === undefined || cam.status === "public";
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

      // Poll every armed performer, resolved through its live-cam identities. A room already
      // being captured is filtered out here rather than after the status call: it cannot be
      // started twice, so asking the provider about it is pure traffic. syncActive has just
      // refreshed `active`, and it only holds genuinely capturing rooms, so nothing live can be
      // hidden by this filter.
      const byProvider = new Map<string, Array<{ username: string; pageUrl: string }>>();
      for (const target of liveCams.autoRecordTargets()) {
        if (active.has(keyOf(target.providerId, target.username))) continue;
        const list = byProvider.get(target.providerId) ?? [];
        list.push({ username: target.username, pageUrl: target.pageUrl });
        byProvider.set(target.providerId, list);
      }

      for (const [providerId, targets] of byProvider) {
        let items: LiveCam[];
        try {
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
          if (!isPublicRoom(cam)) continue;
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

  schedule();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = undefined; }, tick };
}
