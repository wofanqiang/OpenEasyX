import { afterEach, describe, expect, it, vi } from "vitest";
import { chaturbateRequest } from "./request.js";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
afterEach(() => vi.useRealTimers());

describe("Chaturbate shared request cooldown", () => {
  it.each(["180", "Thu, 10 Sep 2026 00:03:00 GMT"])("honors Retry-After %s across followed, public and status requests", async (retryAfter) => {
    vi.useFakeTimers({ now: Date.parse("2026-09-10T00:00:00Z") });
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": retryAfter } })).mockResolvedValue(new Response("{}"));
    const context = { fetch } as unknown as PluginContext;
    const responses = await Promise.allSettled([
      chaturbateRequest(context, "https://chaturbate.com/followed", {}),
      chaturbateRequest(context, "https://chaturbate.com/public", {}),
      chaturbateRequest(context, "https://chaturbate.com/status", {}),
    ]);
    expect(responses.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(179_000);
    await expect(chaturbateRequest(context, "https://chaturbate.com/public", {})).rejects.toThrow("Automatic retry");
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(chaturbateRequest(context, "https://chaturbate.com/public", {})).resolves.toHaveProperty("status", 200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cools down network failures and releases queued requests", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(new Response("{}"));
    const context = { fetch } as unknown as PluginContext;
    await expect(chaturbateRequest(context, "https://chaturbate.com/followed", {})).rejects.toThrow("fetch failed");
    await expect(chaturbateRequest(context, "https://chaturbate.com/public", {})).rejects.toThrow("Automatic retry");
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(chaturbateRequest(context, "https://chaturbate.com/public", {})).resolves.toHaveProperty("status", 200);
  });
});
