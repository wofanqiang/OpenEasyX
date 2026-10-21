import type { LiveStream, PluginContext } from "../packages/plugin-sdk/index.js";

export function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

export function plainHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function absoluteUrl(value: string, base: string): string {
  return new URL(decodeHtml(value.trim()), base).toString();
}

/**
 * How long one fetch may take, in milliseconds.
 *
 * Exposed so a caller that retries can divide a single budget across its attempts instead of
 * multiplying the default ceiling by the number of tries.
 */
export type BrowserHtmlOptions = { timeoutMs?: number };

export async function browserHtml(context: PluginContext, url: string, options: BrowserHtmlOptions = {}): Promise<string> {
  return compatibleHtml(context, url, false, options.timeoutMs);
}

export async function renderedBrowserHtml(context: PluginContext, url: string): Promise<string> {
  return compatibleHtml(context, url, true);
}

export async function browserCapturedLiveStream(context: PluginContext, url: string): Promise<LiveStream> {
  let result;
  try {
    const cookiesFile = typeof context.config.cookiesFile === "string" && context.config.cookiesFile.trim() ? context.config.cookiesFile.trim() : undefined;
    result = await context.runCommand("easyx-browser-fetch", ["--capture-media", url, ...(cookiesFile ? [cookiesFile] : [])], { timeoutMs: 45_000, maxOutputBytes: 2 * 1024 * 1024 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("This provider requires the EasyX Docker image (browser media capture helper not found)");
    throw error;
  }
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Browser media capture failed with exit code ${result.exitCode}`);
  const payload = JSON.parse(result.stdout) as { url?: unknown; pageUrl?: unknown; cookie?: unknown };
  const streamUrl = typeof payload.url === "string" && payload.url.trim() ? payload.url.trim() : undefined;
  if (!streamUrl) throw new Error("Browser media capture returned no public stream");
  const pageUrl = typeof payload.pageUrl === "string" && payload.pageUrl.trim() ? payload.pageUrl.trim() : url;
  const headers: Record<string, string> = { Referer: pageUrl, "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36" };
  try { headers.Origin = new URL(pageUrl).origin; } catch { /* keep only the referer */ }
  if (typeof payload.cookie === "string" && payload.cookie.trim()) headers.Cookie = payload.cookie.trim();
  return { url: streamUrl, headers, contentType: streamUrl.includes(".mpd") ? "application/dash+xml" : "application/vnd.apple.mpegurl" };
}

async function compatibleHtml(context: PluginContext, url: string, render: boolean, timeoutMs?: number): Promise<string> {
  let result;
  try {
    result = await context.runCommand("easyx-browser-fetch", render ? ["--render", url] : [url], { timeoutMs: timeoutMs ?? (render ? 90_000 : 60_000), maxOutputBytes: 32 * 1024 * 1024 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("This provider requires the EasyX Docker image (browser-compatible fetch helper not found)");
    throw error;
  }
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Browser-compatible request failed with exit code ${result.exitCode}`);
  return result.stdout;
}
