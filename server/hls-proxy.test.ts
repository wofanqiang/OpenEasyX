import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";
import { HlsProxy, isLiveProxyPath, LIVE_PROXY_PREFIX } from "./hls-proxy.js";

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
});
