import { definePlugin } from "../../packages/plugin-sdk/index.js";
import { configuredArgs, playlistCandidates, positiveInteger, runYtDlpJson, testYtDlp, ytDlpDownload } from "../yt-dlp-utils.js";

type VideoInfo = Record<string, unknown>;

function accountUrl(value: string): URL | undefined {
  const url = new URL(value);
  if (!/(^|\.)pornhub\.com$/i.test(url.hostname) || !/^\/(model|pornstar|users|channels)\/[^/]+(?:\/|$)/i.test(url.pathname)) return;
  url.pathname = url.pathname.split("/").slice(0, 3).join("/");
  url.search = ""; url.hash = "";
  return url;
}

export function belongsToAccount(info: VideoInfo, account: URL): boolean {
  const handle = decodeURIComponent(account.pathname.split("/")[2]).toLowerCase();
  // Prefer stable IDs/links. A contradictory ID must not be rescued by a display name.
  for (const key of ["uploader_url", "channel_url"]) {
    if (typeof info[key] !== "string" || !info[key]) continue;
    try { const owner = accountUrl(info[key] as string); return !!owner && decodeURIComponent(owner.pathname.split("/")[2]).toLowerCase() === handle; }
    catch { return false; }
  }
  if (typeof info.uploader_id === "string" && info.uploader_id) return info.uploader_id.toLowerCase() === handle;
  // yt-dlp exposes only the uploader display name on some older channel pages.
  const slug = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "-");
  return typeof info.uploader === "string" && slug(info.uploader) === slug(handle);
}

async function verifiedInfo(context: import("../../packages/plugin-sdk/index.js").PluginContext, pageUrl: string, account: URL) {
  const video = new URL(pageUrl);
  if (!/(^|\.)pornhub\.com$/i.test(video.hostname) || !video.searchParams.get("viewkey")) return;
  const info = await runYtDlpJson(context, ["--no-playlist", "--skip-download", "--dump-single-json", ...configuredArgs(context.config), pageUrl], 60_000);
  return belongsToAccount(info, account) ? { ...info, webpage_url: pageUrl } : undefined;
}

export default definePlugin({
  manifest: {
    id: "org.easyx.pornhub",
    name: "Pornhub",
    version: "1.1.0",
    author: "Open EasyX",
    homepage: "https://github.com/yt-dlp/yt-dlp",
    description: "List public Pornhub profile, model, pornstar, and channel videos with yt-dlp and download the selected original stream.",
    capabilities: ["media-listing", "download-resolver"],
    sourceUrlPatterns: ["http://pornhub.com/*", "https://pornhub.com/*", "http://www.pornhub.com/*", "https://www.pornhub.com/*", "http://*.pornhub.com/*", "https://*.pornhub.com/*"],
    polling: { mode: "periodic", defaultIntervalSeconds: 21_600, minimumIntervalSeconds: 900 },
    browserAuth: { loginUrl: "https://www.pornhub.com/login", sessionSetting: "cookiesFile" },
    settings: [
      { key: "maxItems", label: "Maximum videos per scan", type: "number", default: 100 },
      { key: "cookiesFile", label: "Account session", type: "session", cookieDomains: ["pornhub.com"], help: "Optional for public pages. Paste your own browser Cookie header or import a cookies.txt export." },
    ],
  },
  async testConnection(context) { return testYtDlp(context, "Pornhub"); },
  async listMedia(context, source) {
    const maxItems = positiveInteger(context.config.maxItems, 100);
    const account = accountUrl(source.profileUrl);
    const listingUrl = account ? `${account.href}/videos${account.pathname.startsWith("/channels/") ? "" : "/upload"}` : source.profileUrl;
    const info = await runYtDlpJson(context, [
      "--flat-playlist", "--dump-single-json", "--skip-download", "--playlist-end", String(maxItems),
      ...configuredArgs(context.config), listingUrl,
    ], 180_000);
    const candidates = playlistCandidates(info, source.profileUrl, "pornhub", maxItems);
    if (!account) return candidates;
    const verified = [];
    for (let offset = 0; offset < candidates.length; offset += 3) {
      const batch = await Promise.all(candidates.slice(offset, offset + 3).map(async (item) => {
        try { return await verifiedInfo(context, item.pageUrl!, account); }
        catch (error) { context.log("warn", "Pornhub video skipped: uploader could not be verified", { pageUrl: item.pageUrl, error: String(error) }); return undefined; }
      }));
      verified.push(...batch.filter((item) => item !== undefined));
    }
    context.log("info", "Pornhub account videos verified", { accepted: verified.length, skipped: candidates.length - verified.length });
    return playlistCandidates({ entries: verified }, source.profileUrl, "pornhub", maxItems);
  },
  async resolveDownload(context, item) {
    // This also protects items queued by an older version of the plugin.
    const account = typeof item.metadata?.sourceUrl === "string" ? accountUrl(item.metadata.sourceUrl) : undefined;
    if (account && (!item.pageUrl || !await verifiedInfo(context, item.pageUrl, account))) throw new Error("This video does not have a verified uploader matching the selected Pornhub account");
    return ytDlpDownload(item, context.config, { referer: "https://www.pornhub.com/" });
  },
});
