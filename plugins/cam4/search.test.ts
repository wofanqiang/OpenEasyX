import { describe, expect, it, vi } from "vitest";
import { cam4SearchUsernames, cam4ProfileByUsername, searchCam4People, discoverCam4Sources, resolveCam4Download } from "./index.js";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
function context(): PluginContext {
  return { config: {}, fetch: vi.fn(async () => Response.json({ username: "Alice", online: false, gender: "female" })), log: vi.fn(), runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '<script>{"username":"Alice"}</script>', stderr: "" })) };
}
describe("CAM4 performer discovery", () => {
  it.each([["@Alice", ["Alice"]], ["Jane Doe", ["JaneDoe", "Jane_Doe"]], ["https://www.cam4.com/Alice", ["Alice"]], ["a/b", []]])("accepts exact username query %s", (query, expected) => {
    expect(cam4SearchUsernames(query as string)).toEqual(expected);
  });
  it("finds a confirmed offline account", async () => {
    expect(await searchCam4People(context(), "Alice")).toMatchObject([{ externalId: "alice", metadata: { online: false } }]);
  });
  it("does not invent an account from an empty success response", async () => {
    const ctx = context(); vi.mocked(ctx.fetch).mockImplementation(async () => Response.json({}));
    vi.mocked(ctx.runCommand).mockResolvedValue({ exitCode: 0, stdout: "<html>Not found</html>", stderr: "" });
    expect(await cam4ProfileByUsername(ctx, "Ghost")).toBeUndefined();
  });
  it("uses the public page when JSON endpoints require authentication", async () => {
    const ctx = context(); vi.mocked(ctx.fetch).mockImplementation(async () => new Response("", { status: 401 }));
    expect(await cam4ProfileByUsername(ctx, "Alice")).toMatchObject({ username: "Alice" });
  });
  it("accepts legacy live links and never guesses a source from a name", async () => {
    expect(await discoverCam4Sources(context(), { id: "p", name: "Alice", aliases: [], externalRefs: {} })).toEqual([]);
    expect(await discoverCam4Sources(context(), { id: "p", name: "Alice", aliases: [], externalRefs: { "org.easyx.cam4": "live:alice" } })).toMatchObject([{ profileUrl: "https://www.cam4.com/Alice" }]);
  });
  it("passes a stream refresh endpoint to the shared recorder and selects the best variant", async () => {
    const ctx = context(); vi.mocked(ctx.fetch).mockImplementation(async (url) => {
      if (String(url).includes("streamInfo")) return Response.json({ cdnURL: "https://cdn.test/master.m3u8" });
      if (String(url).endsWith("master.m3u8")) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n");
      return new Response("#EXTM3U\n#EXTINF:2\npart.ts\n");
    });
    expect(await resolveCam4Download(ctx, { externalId: "alice", mediaType: "video", pageUrl: "https://www.cam4.com/Alice" })).toMatchObject({ requireSuccessfulExit: true, args: expect.arrayContaining(["https://cdn.test/high.m3u8", "https://www.cam4.com/rest/v1.0/profile/Alice/streamInfo", "cdnURL"]) });
  });
  it("propagates cancellation without trying the next lookup or downloader", async () => {
    const controller = new AbortController(); controller.abort(new Error("Cancelled"));
    const ctx = { ...context(), signal: controller.signal }; vi.mocked(ctx.fetch).mockRejectedValue(controller.signal.reason);
    await expect(searchCam4People(ctx, "Jane Doe")).rejects.toThrow("Cancelled");
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
    await expect(resolveCam4Download(ctx, { externalId: "alice", mediaType: "video", pageUrl: "https://www.cam4.com/Alice" })).rejects.toThrow("Cancelled");
  });
});
