import { describe, expect, it, vi } from "vitest";
import plugin, { belongsToAccount } from "./index.js";
import type { PluginContext } from "../../packages/plugin-sdk/index.js";
const page = (id: string) => `https://www.pornhub.com/view_video.php?viewkey=${id}`;
const source = { id: "s", externalId: "s", performerId: "p", profileUrl: "https://www.pornhub.com/pornstar/example", domain: "pornhub.com" };
function context(entries: Record<string, unknown>[], details: Record<string, Record<string, unknown>>) {
  const runCommand = vi.fn(async (_command: string, args: string[]) => {
    const info = args.includes("--flat-playlist") ? { entries } : details[new URL(args.at(-1)!).searchParams.get("viewkey")!];
    return { exitCode: info ? 0 : 1, stdout: JSON.stringify(info ?? {}), stderr: info ? "" : "Unavailable video" };
  });
  const ctx: PluginContext = { config: {}, fetch, runCommand, log: vi.fn() };
  return { ctx, runCommand };
}
describe("Pornhub account scoping", () => {
  it("uses the uploads tab, verifies each uploader, and retains original publication dates", async () => {
    const { ctx, runCommand } = context([{ id: "ph123", url: page("ph123") }], { ph123: { id: "ph123", title: "Public clip", uploader_id: "example", upload_date: "20240102" } });
    const items = await plugin.listMedia!(ctx, { ...source, profileUrl: `${source.profileUrl}/videos/favorites?page=4` });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ externalId: "pornhub:ph123", publishedAt: "2024-01-02T00:00:00.000Z", filename: "ph123.mp4" });
    expect(runCommand.mock.calls[0][1].at(-1)).toBe(`${source.profileUrl}/videos/upload`);
    expect(await plugin.resolveDownload!(ctx, items[0])).toMatchObject({ kind: "command", command: "yt-dlp", filename: "ph123.mp4" });
  });
  it("excludes recommendations, unverified uploaders, deleted videos and cast-only matches", async () => {
    const ids = ["own", "other", "unknown", "removed", "cast"];
    const { ctx } = context(ids.map((id) => ({ url: page(id) })), {
      own: { id: "own", uploader_id: "example" },
      other: { id: "other", uploader_id: "stranger", uploader: "example" },
      unknown: { id: "unknown" },
      cast: { id: "cast", uploader_id: "studio", cast: ["example"] },
    });
    expect((await plugin.listMedia!(ctx, source)).map((item) => item.externalId)).toEqual(["pornhub:own"]);
  });
  it("supports channel uploader names and refuses to resolve an unrelated legacy queued item", async () => {
    const { ctx, runCommand } = context([{ url: page("one") }], { one: { id: "one", uploader: "Example Channel" }, wrong: { id: "wrong", uploader_id: "someone-else" } });
    const channel = { ...source, profileUrl: "https://www.pornhub.com/channels/example-channel?o=vi&page=2" };
    expect(await plugin.listMedia!(ctx, channel)).toHaveLength(1);
    expect(runCommand.mock.calls[0][1].at(-1)).toBe("https://www.pornhub.com/channels/example-channel/videos");
    await expect(plugin.resolveDownload!(ctx, { externalId: "wrong", mediaType: "video", pageUrl: page("wrong"), metadata: { sourceUrl: channel.profileUrl } })).rejects.toThrow("verified uploader");
  });
  it("does not accept a contradictory stable ID or an uploader link on another host", () => {
    const account = new URL(source.profileUrl);
    expect(belongsToAccount({ uploader_id: "different", uploader: "example" }, account)).toBe(false);
    expect(belongsToAccount({ uploader_url: "https://fake.test/model/example", uploader: "example" }, account)).toBe(false);
    expect(belongsToAccount({ uploader_url: "https://fr.pornhub.com/model/Example" }, account)).toBe(true);
  });
  it("still supports explicitly selected individual videos", async () => {
    const { ctx } = context([{ url: page("one") }], {});
    expect(await plugin.listMedia!(ctx, { ...source, profileUrl: page("one") })).toHaveLength(1);
  });
});
