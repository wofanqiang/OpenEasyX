/** Normalize source dates; zero/epoch timestamps mean missing metadata, not publication. */
export function validMediaDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  let date: Date;
  if (compact) date = new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00Z`);
  else if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const stamp = Number(raw);
    date = new Date(stamp > 10_000_000_000 ? stamp : stamp * 1000);
  } else {
    // Extractors also return UTC datetimes without an explicit zone.
    const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw);
    date = new Date(naive ? `${raw.replace(" ", "T")}Z` : raw);
  }
  const stamp = date.valueOf();
  if (!Number.isFinite(stamp) || stamp <= 0 || stamp > Date.now() + 86_400_000) return undefined;
  return date.toISOString();
}

export function oldestMediaDate(...values: unknown[]): string | undefined {
  return values.map(validMediaDate).filter((value): value is string => !!value).sort()[0];
}

export function firstMediaDate(...values: unknown[]): string | undefined {
  for (const value of values) {
    const date = validMediaDate(value);
    if (date) return date;
  }
  return undefined;
}
