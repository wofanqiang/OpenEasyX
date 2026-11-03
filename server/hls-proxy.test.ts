import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ENTRY_TTL_MS, HlsProxy, isLiveProxyPath, LIVE_PROXY_PREFIX, PRUNE_EVERY_MS } from "./hls-proxy.js";

/**
 * The one invariant a unit test can pin down here: whatever URL the proxy hands out, the router
 * must recognise it as reachable without a session.
 *
 * This broke once. Recordings are made by ffmpeg running inside the server process, which has
 * no cookie, so while the proxy route sat behind the session gate every proxied recording failed
 * with a 401 and was retried until it was cancelled. The failure is invisible from the UI — the
 * item just sits in the queue — so the link between "URL the proxy mints" and "path the gate
 * lets through" is asserted directly rather than left to the e2e test, which runs its own
 * Fastify app with no auth hook in front of it.
 */

function fakeReply(): { reply: FastifyReply; body: () => string } {
  let sent = "";
  const reply = {
    status: () => reply,
    type: () => reply,
    header: () => reply,
    send: (value: unknown) => { sent = String(value); return reply; },
  };
  return { reply: reply as unknown as FastifyReply, body: () => sent };
}

describe("hls proxy routing", () => {
  const proxy = new HlsProxy();

  const plainPlaylist = () => new Response("#EXTM3U\n#EXTINF:2,\nhttps://cdn.test/media.ts\n", {
    status: 200,
    headers: { "content-type": "application/vnd.apple.mpegurl" },
  });

  it("mints URLs on the route the session gate exempts", () => {
    expect(isLiveProxyPath(proxy.register({ url: "https://cdn.test/a.m3u8" }))).toBe(true);
    expect(isLiveProxyPath(proxy.register({ url: "https://cdn.test/a.m3u8", audioUrl: "https://cdn.test/audio.m3u8" }))).toBe(true);
  });

  it("keeps the exemption narrow", () => {
    expect(isLiveProxyPath(LIVE_PROXY_PREFIX + "anything.m3u8")).toBe(true);
    expect(isLiveProxyPath("/api/live-cams")).toBe(false);
    expect(isLiveProxyPath("/api/items")).toBe(false);
    expect(isLiveProxyPath("/")).toBe(false);
  });

  it("rewrites a proxied playlist onto the same exempt route", async () => {
    const media = [
      "#EXTM3U",
      "#EXT-X-MEDIA-SEQUENCE:1",
      "#EXTINF:2.000",
      "#EXT-X-MOUFLON:URI:https://cdn.test/a/seg1.mp4",
      "https://cdn.test/a/media.mp4",
      "",
    ].join("\n");
    const stub = new HlsProxy(async () => new Response(media, {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" },
    }));

    const entry = stub.register({ url: "https://cdn.test/a.m3u8" });
    const { reply, body } = fakeReply();
    await stub.serve(entry.replace(LIVE_PROXY_PREFIX, ""), reply, {});

    const sent = body();
    const addresses = sent.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
    expect(addresses.length).toBeGreaterThan(0);
    // Every address ffmpeg is told to fetch must be one it can fetch without a session.
    for (const address of addresses) expect(isLiveProxyPath(address)).toBe(true);
    expect(sent).not.toContain("media.mp4");
  });

  // CamSoda's edge answers 403 to a plain fetch and 200 to a Chrome TLS fingerprint for the very
  // same URL, and its plugin stamps `requiresTlsFingerprint` to say so. The fingerprint client
  // costs several times what a plain fetch costs, so it is spent per stream: a provider that never
  // asked for it records through the plain client even when both are wired in.
  it("spends the fingerprint client only on streams that asked for it", async () => {
    const playlist = () => new Response("#EXTM3U\n#EXTINF:2,\nhttps://cdn.test/media.ts\n", { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
    const calls: string[] = [];
    const plain = async () => { calls.push("plain"); return playlist(); };
    const fingerprinted = async () => { calls.push("fingerprinted"); return playlist(); };
    const proxy = new HlsProxy(plain, fingerprinted);

    const { reply, body } = fakeReply();
    const gated = proxy.register({ url: "https://cdn.test/gated.m3u8", requiresTlsFingerprint: true });
    await proxy.serve(gated.replace(LIVE_PROXY_PREFIX, ""), reply, {});
    expect(body()).toContain("#EXTM3U");
    // A rewritten playlist hands out child entries that inherit the stream's client choice, so the
    // next hop keeps using the client that can actually reach the provider.
    const nested = body().split("\n").find((line) => line.trim() && !line.startsWith("#"));
    await proxy.serve(nested!.replace(LIVE_PROXY_PREFIX, ""), reply, {});
    expect(body()).toContain("#EXTM3U");

    await proxy.serve(proxy.register({ url: "https://cdn.test/open.m3u8" }).replace(LIVE_PROXY_PREFIX, ""), reply, {});
    expect(body()).toContain("#EXTM3U");

    expect(calls).toEqual(["fingerprinted", "fingerprinted", "plain"]);
  });

  it("answers 403 with what the provider said when the client cannot reach it", async () => {
    const plain = new HlsProxy(async () => new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } }));
    const state: { status?: number } = {};
    const statusReply = {
      status: (code: number) => { state.status = code; return statusReply; },
      type: () => statusReply, header: () => statusReply, send: () => statusReply,
    };
    await plain.serve(plain.register({ url: "https://cdn.test/gated.m3u8" }).replace(LIVE_PROXY_PREFIX, ""), statusReply as unknown as FastifyReply, {});
    expect(state.status).toBe(403);
  });

  it("sweeps at most once per interval, and enforces expiry whether or not a sweep ran", async () => {
    // The sweep is throttled because url() runs on every line of every rewritten playlist; the
    // thing that must not be throttled is the TTL itself. A lazy sweep only delays reclaiming the
    // map slot -- the token stops answering the moment it expires, swept or not.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const proxy = new HlsProxy(async () => plainPlaylist());
      const internal = proxy as unknown as { lastPrune: number };
      const sent: unknown[] = [];
      const reply = {
        status: () => reply, type: () => reply, header: () => reply,
        send: (value: unknown) => { sent.push(value); return reply; },
      } as unknown as FastifyReply;
      const entry = proxy.register({ url: "https://cdn.test/a.m3u8" }).replace(LIVE_PROXY_PREFIX, "");

      proxy.url("https://cdn.test/warm.m3u8", {});
      const afterFirst = internal.lastPrune;
      for (let index = 0; index < 50; index++) proxy.url("https://cdn.test/chatter.m3u8?" + index, {});
      expect(internal.lastPrune).toBe(afterFirst);

      vi.setSystemTime(ENTRY_TTL_MS + PRUNE_EVERY_MS + 1000);
      proxy.url("https://cdn.test/late.m3u8", {});
      expect(internal.lastPrune).toBe(ENTRY_TTL_MS + PRUNE_EVERY_MS + 1000);

      await proxy.serve(entry, reply, {});
      expect(JSON.stringify(sent[sent.length - 1])).toContain("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports failures to the caller even with route logging silenced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const proxy = new HlsProxy(async () => plainPlaylist());
      const messages: string[] = [];
      const { reply } = fakeReply();
      const entry = proxy.register({ url: "https://cdn.test/a.m3u8" }).replace(LIVE_PROXY_PREFIX, "");
      vi.setSystemTime(ENTRY_TTL_MS + 60_000);
      await proxy.serve(entry, reply, {}, undefined, (message) => messages.push(message));
      expect(messages).toEqual([expect.stringContaining("expired")]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A refusal from the provider is a verdict, not a hiccup, and the recorder retries far faster than
 * a CDN changes its mind: a broadcast that ended produced 22 upstream requests in 2.4 seconds on a
 * live box. These pin down that the refusal is remembered per URL, so those retries are answered
 * locally -- and that nothing transient is remembered, so a real recovery is not delayed.
 */
describe("remembering a refusal", () => {
  function statusReply(): { reply: FastifyReply; status: () => number | undefined; body: () => string } {
    let code: number | undefined;
    let sent = "";
    const reply = {
      status: (value: number) => { code = value; return reply; },
      type: () => reply,
      header: () => reply,
      send: (value: unknown) => { sent = typeof value === "string" ? value : JSON.stringify(value); return reply; },
    };
    return { reply: reply as unknown as FastifyReply, status: () => code, body: () => sent };
  }

  it("answers a repeated 403 from memory instead of asking again", async () => {
    let calls = 0;
    const proxy = new HlsProxy(async () => { calls += 1; return new Response("forbidden", { status: 403 }); });
    const path = proxy.register({ url: "https://cdn.test/gated.m3u8" }).replace(LIVE_PROXY_PREFIX, "");

    const first = statusReply();
    await proxy.serve(path, first.reply, {});
    expect(first.status()).toBe(403);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = statusReply();
      await proxy.serve(path, again.reply, {});
      expect(again.status()).toBe(403);
      expect(again.body()).toContain("403");
    }
    expect(calls).toBe(1);
  });

  it("asks again once the memory has expired", async () => {
    let calls = 0;
    const proxy = new HlsProxy(async () => { calls += 1; return new Response("forbidden", { status: 410 }); }, undefined, 30);
    const path = proxy.register({ url: "https://cdn.test/gone.m3u8" }).replace(LIVE_PROXY_PREFIX, "");

    await proxy.serve(path, statusReply().reply, {});
    expect(calls).toBe(1);
    await proxy.serve(path, statusReply().reply, {});
    expect(calls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 45));
    await proxy.serve(path, statusReply().reply, {});
    expect(calls).toBe(2);
  });

  it("does not remember a transient failure, so a recovery is not delayed", async () => {
    let calls = 0;
    const proxy = new HlsProxy(async () => {
      calls += 1;
      return calls === 1 ? new Response("boom", { status: 503 }) : new Response("#EXTM3U\n", { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
    });
    const path = proxy.register({ url: "https://cdn.test/flaky.m3u8" }).replace(LIVE_PROXY_PREFIX, "");

    await proxy.serve(path, statusReply().reply, {});
    const recovered = statusReply();
    await proxy.serve(path, recovered.reply, {});
    expect(recovered.body()).toContain("#EXTM3U");
    expect(calls).toBe(2);
  });

  it("clears the memory once a request succeeds, so a later refusal is a fresh decision", async () => {
    const plan = [403, 200, 403];
    let index = 0;
    const proxy = new HlsProxy(async () => {
      const status = plan[Math.min(index++, plan.length - 1)];
      return new Response(status === 200 ? "#EXTM3U\n" : "no", { status, headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }, undefined, 30);
    const path = proxy.register({ url: "https://cdn.test/flap.m3u8" }).replace(LIVE_PROXY_PREFIX, "");

    const first = statusReply();
    await proxy.serve(path, first.reply, {});
    expect(first.status()).toBe(403);
    expect(index).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 45));
    const second = statusReply();
    await proxy.serve(path, second.reply, {});
    expect(second.body()).toContain("#EXTM3U");
    expect(index).toBe(2);

    // The success above cleared the memory; the next refusal must be asked for again rather than
    // answered from a verdict that no longer applies.
    const third = statusReply();
    await proxy.serve(path, third.reply, {});
    expect(third.status()).toBe(403);
    expect(index).toBe(3);
  });

  it("can be switched off, which restores one upstream request per attempt", async () => {
    let calls = 0;
    const proxy = new HlsProxy(async () => { calls += 1; return new Response("forbidden", { status: 403 }); }, undefined, 0);
    const path = proxy.register({ url: "https://cdn.test/gated.m3u8" }).replace(LIVE_PROXY_PREFIX, "");

    for (let attempt = 0; attempt < 3; attempt += 1) await proxy.serve(path, statusReply().reply, {});
    expect(calls).toBe(3);
  });
});

/**
 * A live stream is reached by an address that carries the provider's session, and that session
 * expires while the broadcast is still running. The CDN then answers 403 and the capture dies on a
 * stream that never stopped -- measured over forty hours: every room took fifty to seventy
 * refusals, and the recordings that survived were the ones whose address was replaced in time.
 *
 * So the proxy asks for the room again when the provider refuses, and the recorder keeps polling
 * the same URL: only the address behind it changes.
 */
/** The proxy answers with a status and a body; this keeps both. */
function stubReply() {
  let sent = ""; let code = 0;
  const stub = {
    status: (value: number) => { code = value; return stub; },
    type: () => stub,
    header: () => stub,
    send: (value: unknown) => { sent = typeof value === "string" ? value : JSON.stringify(value); return stub; },
  };
  return { reply: stub as unknown as FastifyReply, status: () => code, body: () => sent };
}

describe("hls proxy re-resolves a refused stream", () => {
  const playlist = () => new Response("#EXTM3U\n#EXTINF:2,\nhttps://cdn.test/media.ts\n", {
    status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" },
  });

  it("replaces the refused address with a fresh one", async () => {
    const seen: string[] = [];
    const request = vi.fn(async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("old")) return new Response("no", { status: 403 });
      return playlist();
    }) as unknown as typeof fetch;
    const proxy = new HlsProxy(request, undefined, 0);
    let refreshed = false;
    const refresh = vi.fn(async () => { refreshed = true; return { url: "https://cdn.test/new.m3u8", headers: { "referer": "https://chaturbate.com/" } }; });
    const token = proxy.register({ url: "https://cdn.test/old.m3u8" }, refresh).slice(LIVE_PROXY_PREFIX.length);

    const first = stubReply();
    await proxy.serve(token, first.reply);
    expect(first.status()).toBe(403);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The refresh lands on the entry, so the next request follows the new address.
    await vi.waitFor(() => expect(refreshed).toBe(true));
    const second = stubReply();
    await proxy.serve(token, second.reply);
    expect(second.status()).toBe(200);
    expect(second.body()).toContain("#EXTM3U");
    expect(seen).toContain("https://cdn.test/new.m3u8");
  });

  it("does not ask the provider again while the re-resolve is running", async () => {
    let upstreamCalls = 0;
    const request = vi.fn(async () => { upstreamCalls += 1; return new Response("no", { status: 403 }); }) as unknown as typeof fetch;
    const proxy = new HlsProxy(request, undefined, 0);
    let release: (value: { url: string } | undefined) => void = () => {};
    const pending = new Promise<{ url: string } | undefined>((resolve) => { release = resolve; });
    const refresh = vi.fn(async () => pending);
    const token = proxy.register({ url: "https://cdn.test/old.m3u8" }, refresh).slice(LIVE_PROXY_PREFIX.length);

    const first = stubReply();
    await proxy.serve(token, first.reply);
    expect(upstreamCalls).toBe(1);
    // The address is known to be refused and a new one is on its way: ask from memory instead.
    const second = stubReply();
    await proxy.serve(token, second.reply);
    expect(upstreamCalls).toBe(1);
    expect(second.status()).toBe(403);
    release(undefined);
    await pending;
  });

  it("refuses to fetch an address inside the machine's own network", async () => {
    // A playlist decides where the server fetches next: every segment address in it becomes a
    // request the server makes. Pointing the proxy at the cloud metadata address (or the loopback)
    // would turn it into a reader for the machine's own network.
    const request = vi.fn(async () => playlist()) as unknown as typeof fetch;
    const proxy = new HlsProxy(request);
    for (const target of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:3210/api/settings", "http://[::1]:3210/"]) {
      const token = proxy.register({ url: target }).slice(LIVE_PROXY_PREFIX.length);
      const reply = stubReply();
      await proxy.serve(token, reply.reply);
      expect(reply.status(), target).toBe(502);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("replaces both renditions of a stream in one re-resolve", async () => {
    const seen: string[] = [];
    const request = vi.fn(async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("old")) return new Response("no", { status: 403 });
      return playlist();
    }) as unknown as typeof fetch;
    const proxy = new HlsProxy(request, undefined, 0);
    let refreshed = false;
    const refresh = vi.fn(async () => { refreshed = true; return { url: "https://cdn.test/new-video.m3u8", audioUrl: "https://cdn.test/new-audio.m3u8" }; });
    const master = proxy.register({ url: "https://cdn.test/old-video.m3u8", audioUrl: "https://cdn.test/old-audio.m3u8" }, refresh);
    const masterReply = stubReply();
    await proxy.serve(master.slice(LIVE_PROXY_PREFIX.length), masterReply.reply);
    const urls = [...masterReply.body().matchAll(new RegExp(LIVE_PROXY_PREFIX.replace(/[/.]/g, (character) => "\\" + character) + "[A-Za-z0-9_-]+\\.m3u8", "g"))].map((match) => match[0]);
    expect(urls.length).toBe(2);

    for (const url of urls) {
      const entry = stubReply();
      await proxy.serve(url.slice(LIVE_PROXY_PREFIX.length), entry.reply);
    }
    await vi.waitFor(() => expect(refreshed).toBe(true));
    // Both renditions now point at the fresh addresses.
    for (const url of urls) {
      const entry = stubReply();
      await proxy.serve(url.slice(LIVE_PROXY_PREFIX.length), entry.reply);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toContain("https://cdn.test/new-video.m3u8");
    expect(seen).toContain("https://cdn.test/new-audio.m3u8");
  });
});
