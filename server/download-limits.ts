const DEFAULT_LIMIT = 8;
export function parseConcurrentDownloadsLimit(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_LIMIT;
}
export const maxConcurrentDownloadsLimit = parseConcurrentDownloadsLimit(process.env.EASYX_MAX_CONCURRENT_DOWNLOADS_LIMIT);
export function concurrentDownloads(value: unknown, limit = maxConcurrentDownloadsLimit): number {
  const parsed = Number(value ?? 2);
  return Math.min(limit, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : 2));
}
