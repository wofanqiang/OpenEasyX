export type DownloadTiming = {
  status: string;
  downloadStartedAt?: string;
  downloadFinishedAt?: string;
};

export const COMPLETED_DELETE_CONFIRMATION = "Permanently delete this completed recording and its media file?";

export function confirmItemDeletion(status: string, confirm: (message: string) => boolean): boolean {
  return status !== "completed" || confirm(COMPLETED_DELETE_CONFIRMATION);
}

/**
 * The reason a capture was filed while its content fell short of the session, if the recorder wrote
 * one. Kept here rather than inline in the row so the "no metadata / not flagged / flag without a
 * reason" cases can be tested without rendering the page.
 */
export function incompleteOf(item: { metadata?: Record<string, unknown> }): string | undefined {
  const metadata = item.metadata;
  if (!metadata || metadata.incomplete !== true) return undefined;
  const reason = metadata.incompleteReason;
  return typeof reason === "string" && reason.trim() ? reason : "it ended before the session did";
}

export function activitySourceDomains(sources: Array<{ domain: string }>): string[] {
  return [...new Set(sources.map((source) => source.domain.trim().toLowerCase()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function downloadTime(item: DownloadTiming, currentTime = Date.now()): string {
  if (!item.downloadStartedAt) return "—";
  const started = new Date(item.downloadStartedAt).getTime();
  const finished = item.downloadFinishedAt ? new Date(item.downloadFinishedAt).getTime() : undefined;
  const end = finished ?? (["downloading", "paused", "stopping", "cancelling"].includes(item.status) ? currentTime : undefined);
  if (!Number.isFinite(started) || end === undefined || !Number.isFinite(end)) return "—";
  return formatElapsed(end - started);
}
