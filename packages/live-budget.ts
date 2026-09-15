/**
 * The one place that decides how long a plugin may spend on a live-catalogue sweep.
 *
 * A sweep is bounded in layers, and those layers must stay in this order:
 *
 *   plugin budget (this file)  <  provider envelope (budget + grace)  <  page REST fallback
 *   (60s)  <  page SSE guard (90s)
 *
 * The plugin stops at its own budget and returns whatever it already collected — a short list
 * beats an error page. The envelope only exists to catch a plugin that ignores
 * `context.budgetMs`. Letting the budget reach the envelope would turn a partial catalogue into
 * an error page, which is exactly what the ordering prevents. `LIVE_CRAWL_BUDGET_MAX_SECONDS` is
 * the hard cap that keeps the ordering true no matter what ends up in the database.
 */
export const liveCrawlBudgetPresets = [
  {
    id: "conservative",
    seconds: 15,
    label: "Conservative — 15 seconds",
    description: "Smallest sweep. Pages render fastest and provider traffic stays low; very large catalogues are cut short more often.",
  },
  {
    id: "balanced",
    seconds: 30,
    label: "Balanced — 30 seconds",
    description: "Recommended. A full Stripchat sweep of several thousand rooms finishes inside 30 seconds.",
  },
  {
    id: "max",
    seconds: 40,
    label: "Maximum — 40 seconds",
    description: "Longest sweep. Collects the most rooms and costs the most waiting time; still capped so a page render cannot stall.",
  },
] as const;

export type LiveCrawlBudgetPreset = typeof liveCrawlBudgetPresets[number]["id"];
/** Derived from the presets so the zod enum cannot drift away from the list above. */
export const liveCrawlBudgetPresetIds = liveCrawlBudgetPresets.map((preset) => preset.id) as [LiveCrawlBudgetPreset, ...LiveCrawlBudgetPreset[]];
export const liveCrawlBudgetDefaults = { liveCrawlBudgetPreset: "balanced" as LiveCrawlBudgetPreset };
/** Hard ceiling. 40s leaves the 45s provider envelope below the page's 60s REST fallback. */
export const LIVE_CRAWL_BUDGET_MAX_SECONDS = 40;
/** Margin the envelope adds on top of the budget, so a plugin can unwind its last request. */
export const LIVE_CRAWL_BUDGET_PROVIDER_GRACE_MS = 5_000;

/** The preset in force. An unknown or missing value falls back to the default rather than throwing. */
export function liveCrawlBudgetPreset(values: Record<string, unknown>): LiveCrawlBudgetPreset {
  const id = String(values?.liveCrawlBudgetPreset ?? "");
  return liveCrawlBudgetPresets.some((preset) => preset.id === id) ? id as LiveCrawlBudgetPreset : liveCrawlBudgetDefaults.liveCrawlBudgetPreset;
}

/** Seconds a plugin may spend on one catalogue sweep, clamped to the hard ceiling. */
export function liveCrawlBudgetSeconds(values: Record<string, unknown>): number {
  const preset = liveCrawlBudgetPresets.find((item) => item.id === liveCrawlBudgetPreset(values))!;
  return Math.min(preset.seconds, LIVE_CRAWL_BUDGET_MAX_SECONDS);
}

export function liveCrawlBudgetMs(values: Record<string, unknown>): number {
  return liveCrawlBudgetSeconds(values) * 1_000;
}

/** Outer envelope for one provider call: the budget plus the unwinding margin. */
export function providerEnvelopeMs(values: Record<string, unknown>): number {
  return liveCrawlBudgetMs(values) + LIVE_CRAWL_BUDGET_PROVIDER_GRACE_MS;
}

/** What a plugin uses when it is handed a context without an injected budget (bare unit tests). */
export const LIVE_CRAWL_BUDGET_FALLBACK_MS = liveCrawlBudgetMs(liveCrawlBudgetDefaults);
