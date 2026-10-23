import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintedFetch, resetTlsFingerprintForTests } from "./tls-fingerprint.js";

/**
 * A stand-in for the Python helper: same wire protocol (POST {url, headers}, mirror the upstream
 * status and a few headers, stream the body), none of curl_cffi. What is under test is the Node
 * shim: what it forwards, and how faithfully it maps the answer back onto a Response.
 */
async function fakeHelper(respond: (seen: { url: string; headers: Record<string, string> }) => { status: number; headers: Record<string, string>; body: string }) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}");
      seen.push({ url: payload.url, headers: payload.headers ?? {} });
      const answer = respond(seen[seen.length - 1]);
      response.writeHead(answer.status, { ...answer.headers, "content-length": String(Buffer.byteLength(answer.body)) });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("tls fingerprint fetch", () => {
  afterEach(() => { resetTlsFingerprintForTests(); delete process.env.EASYX_TLS_FETCH_URL; });

  it("forwards the request to the helper and mirrors the upstream answer", async () => {
    const helper = await fakeHelper(() => ({ status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" }, body: "#EXTM3U\n" }));
    process.env.EASYX_TLS_FETCH_URL = helper.url;

    const response = await fingerprintedFetch("https://cdn.test/room.m3u8", { headers: { referer: "https://www.camsoda.com/" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(await response.text()).toBe("#EXTM3U\n");
    expect(helper.seen).toEqual([{ url: "https://cdn.test/room.m3u8", headers: { referer: "https://www.camsoda.com/" } }]);
    await helper.close();
  });

  it("passes an upstream 403 through instead of hiding it as a transport error", async () => {
    // The proxy reports what the provider actually said; a 403 must stay a 403 so the capture's
    // own reconnect logic sees the real status.
    const helper = await fakeHelper(() => ({ status: 403, headers: { "content-type": "text/html" }, body: "forbidden" }));
    process.env.EASYX_TLS_FETCH_URL = helper.url;

    const response = await fingerprintedFetch("https://cdn.test/gated.m3u8");

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
    await helper.close();
  });

  it("falls back to the plain fetch when no helper can run", async () => {
    // A dev box without curl_cffi must keep working: the shim degrades to the fetch the proxy
    // would otherwise have used rather than failing every live stream.
    process.env.EASYX_PYTHON = "definitely-not-a-python-binary";
    const response = await fingerprintedFetch("data:text/plain,hello");
    expect(await response.text()).toBe("hello");
  });
});
