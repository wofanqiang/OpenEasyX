import type { LiveCam, PluginContext } from "../packages/plugin-sdk/index.js";
import { decodeHtml } from "./browser-html-utils.js";
import { chaturbateRequest } from "./chaturbate/request.js";

export function profileImageUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(decodeHtml(value), base);
    if (!["https:", "http:"].includes(url.protocol) || /(?:logo|no[-_]?image|no[-_]?photo|default[-_]?avatar|placeholder|\/assets\/)/i.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function profileImages(html: string, cam: LiveCam): string[] {
  const candidates: string[] = [];
  for (const tag of html.matchAll(/<(?:meta|img)\b[^>]*>/gi)) {
    const attributes: Record<string, string> = {};
    for (const attr of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[attr[1].toLowerCase()] = attr[2] ?? attr[3];
    const role = attributes.property ?? attributes.name ?? `${attributes.class ?? ""} ${attributes.id ?? ""}`;
    if (!/og:image$|twitter:image$|profile.?pic|profile.?image|avatar/i.test(role)) continue;
    const url = profileImageUrl(attributes.content ?? attributes["data-src"] ?? attributes.src, cam.pageUrl);
    if (!url || (cam.online === false && /\/(?:riw?|snapshot)\//.test(new URL(url).pathname))) continue;
    candidates.push(url);
  }
  return [...new Set(candidates)];
}

export async function liveProfileImages(context: PluginContext, cam: LiveCam): Promise<string[]> {
  const preferred = profileImageUrl(cam.profileImageUrl, cam.pageUrl);
  if (preferred) return [preferred];
  const init = { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" }, signal: context.signal ?? AbortSignal.timeout(15_000) };
  const response = new URL(cam.pageUrl).hostname.endsWith("chaturbate.com")
    ? await chaturbateRequest(context, cam.pageUrl, init)
    : await context.fetch(cam.pageUrl, init);
  if (!response.ok) throw new Error(`Profile image lookup returned HTTP ${response.status}`);
  return profileImages(await response.text(), cam);
}
