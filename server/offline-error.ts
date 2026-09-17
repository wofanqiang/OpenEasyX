// Errors whose message proves the *provider itself* reported the room as offline -- an HLS
// host or live manifest was explicitly not returned -- rather than a transient network blip.
//
// When the live-cam status API (e.g. Stripchat's `isOnline` snapshot) lags reality and reports
// a room "live" while it is actually offline, the auto-recorder queues a capture that the
// downloader then fails with one of these messages. Treating that as an ordinary transient
// failure would let it retry on a 30s cooldown forever, burning a Chromium render every time.
// Instead, both the auto-recorder (back-off capped at the 1h ceiling) and the live-cam status
// cache (told the room is offline for 10 minutes) key off these messages.
//
// Keep the patterns anchored to the exact phrases the plugins throw. See
// `plugins/stripchat/index.ts` ("The public room did not expose an HLS host" /
// "No public Stripchat HLS host returned a live manifest") and
// `plugins/superchatlive/index.ts` ("No public SuperChat HLS host returned a live manifest").
const OFFLINE_CONFIRMED_PATTERNS: RegExp[] = [
  /did not expose an hls host/i,
  /no public .*hls host returned a live manifest/i,
];

/** True when the error message confirms the room is offline (not merely unreachable). */
export function isOfflineConfirmedError(message: string | undefined | null): boolean {
  if (!message) return false;
  return OFFLINE_CONFIRMED_PATTERNS.some((pattern) => pattern.test(message));
}

/** How long a confirmed-offline verdict suppresses re-queueing before it is allowed to lapse. */
export const OFFLINE_OVERRIDE_MS = 10 * 60 * 1000;
