import { describe, expect, it } from "vitest";
import {
  LIVE_CRAWL_BUDGET_FALLBACK_MS, LIVE_CRAWL_BUDGET_MAX_SECONDS, LIVE_CRAWL_BUDGET_PROVIDER_GRACE_MS,
  liveCrawlBudgetMs, liveCrawlBudgetPreset, liveCrawlBudgetPresets, liveCrawlBudgetSeconds, providerEnvelopeMs,
} from "./live-budget.js";

describe("live catalogue sweep budget", () => {
  it("defaults to the balanced preset and its 30s sweep", () => {
    expect(liveCrawlBudgetPreset({})).toBe("balanced");
    expect(liveCrawlBudgetSeconds({})).toBe(30);
    expect(liveCrawlBudgetMs({})).toBe(30_000);
    expect(LIVE_CRAWL_BUDGET_FALLBACK_MS).toBe(30_000);
  });

  it("maps each preset to its seconds", () => {
    expect(liveCrawlBudgetSeconds({ liveCrawlBudgetPreset: "conservative" })).toBe(15);
    expect(liveCrawlBudgetSeconds({ liveCrawlBudgetPreset: "balanced" })).toBe(30);
    expect(liveCrawlBudgetSeconds({ liveCrawlBudgetPreset: "max" })).toBe(40);
  });

  it("falls back to the default instead of throwing on an unknown or malformed value", () => {
    for (const value of ["", "wild", "45", 45, null, undefined, {}, []]) {
      expect(liveCrawlBudgetPreset({ liveCrawlBudgetPreset: value })).toBe("balanced");
    }
  });

  it("never publishes a preset above the hard ceiling", () => {
    for (const preset of liveCrawlBudgetPresets) expect(preset.seconds).toBeLessThanOrEqual(LIVE_CRAWL_BUDGET_MAX_SECONDS);
    expect(LIVE_CRAWL_BUDGET_MAX_SECONDS).toBe(40);
  });

  it("keeps the provider envelope above the budget and below the page's own timeouts", () => {
    for (const preset of liveCrawlBudgetPresets) {
      const settings = { liveCrawlBudgetPreset: preset.id };
      const budget = liveCrawlBudgetMs(settings);
      const envelope = providerEnvelopeMs(settings);
      expect(envelope).toBe(budget + LIVE_CRAWL_BUDGET_PROVIDER_GRACE_MS);
      expect(envelope).toBeGreaterThan(budget);
      // The page holds a 60s REST fallback and a 90s SSE guard: outrunning either turns a short
      // catalogue into an error page, which is the whole point of the ceiling.
      expect(envelope).toBeLessThan(60_000);
      expect(envelope).toBeLessThanOrEqual(45_000);
    }
  });
});
