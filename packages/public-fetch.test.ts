import { describe, expect, it, vi } from "vitest";
import { fetchPublic, InternalAddressError, isInternalHost, PUBLIC_FETCH_REDIRECTS, publicUrl, RefusedAddressError } from "./public-fetch.js";

describe("isInternalHost", () => {
  it("rejects loopback, private ranges and cloud metadata", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "[::1]", "[fe80::1]", "[fd00::1]"]) {
      expect(isInternalHost(host), host).toBe(true);
    }
  });

  it("rejects names that only resolve inside a network", () => {
    for (const host of ["printer.local", "db.internal", "box.localdomain", "x.home.arpa"]) {
      expect(isInternalHost(host), host).toBe(true);
    }
  });

  it("allows public addresses and ordinary host names", () => {
    for (const host of ["edge-hls.doppiocdn.com", "8.8.8.8", "172.32.0.1", "169.253.1.1", "[2606:4700::1111]"]) {
      expect(isInternalHost(host), host).toBe(false);
    }
  });
});

describe("publicUrl", () => {
  it("keeps a public https address and names the provider in refusals", () => {
    expect(publicUrl("https://edge-hls.example.com/a.m3u8", "Stripchat")).toBe("https://edge-hls.example.com/a.m3u8");
    expect(() => publicUrl("http://169.254.169.254/latest", "Stripchat")).toThrow(/^Stripchat returned a stream address that points inside this host's network$/);
  });

  it("refuses a scheme the fetcher should never use", () => {
    expect(() => publicUrl("file:///etc/passwd", "SuperChat")).toThrow(RefusedAddressError);
    expect(() => publicUrl("not a url", "SuperChat")).toThrow(/is not a URL/);
  });

  it("marks an internal target as its own type so callers keep it apart from a real outage", () => {
    // server/offline-error.ts parks a room for an hour on "no manifest" messages, and a refusal
    // must never be mistaken for one of those.
    expect(() => publicUrl("http://10.0.0.1/x", "Stripchat")).toThrow(InternalAddressError);
  });
});

describe("fetchPublic", () => {
  it("follows a relative redirect and requests the resolved address", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => (
      String(input).endsWith("/a.m3u8")
        ? new Response(null, { status: 302, headers: { location: "/b.m3u8" } })
        : new Response("#EXTM3U")
    ));
    const response = await fetchPublic({ fetch }, "https://edge-hls.example.com/a.m3u8", "Stripchat");
    expect(await response.text()).toBe("#EXTM3U");
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://edge-hls.example.com/a.m3u8",
      "https://edge-hls.example.com/b.m3u8",
    ]);
  });

  it("refuses a redirect into the host network before requesting it", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    await expect(fetchPublic({ fetch }, "https://edge-hls.example.com/a.m3u8", "Stripchat")).rejects.toThrow(InternalAddressError);
    // The whole point: only the address the provider named was ever requested.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe("https://edge-hls.example.com/a.m3u8");
  });

  it("refuses a chain that never settles instead of chasing it", async () => {
    let hop = 0;
    const fetch = vi.fn(async () => {
      hop += 1;
      return new Response(null, { status: 302, headers: { location: `/hop-${hop}.m3u8` } });
    });
    await expect(fetchPublic({ fetch }, "https://edge-hls.example.com/a.m3u8", "Stripchat")).rejects.toThrow(/redirected a stream address more than/);
    expect(fetch).toHaveBeenCalledTimes(PUBLIC_FETCH_REDIRECTS + 1);
  });

  it("hands back a redirect that carries no Location so the caller decides", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302 }));
    const response = await fetchPublic({ fetch }, "https://edge-hls.example.com/a.m3u8", "Stripchat");
    expect(response.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("passes redirect:'manual' so the platform never follows a hop on its own", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("#EXTM3U"));
    await fetchPublic({ fetch }, "https://edge-hls.example.com/a.m3u8", "Stripchat");
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("stops at the first hop when the address itself is internal", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) => new Response("#EXTM3U"));
    await expect(fetchPublic({ fetch }, "http://127.0.0.1:8080/x.m3u8", "SuperChat")).rejects.toThrow(InternalAddressError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
