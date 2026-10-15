import { definePlugin, type PluginContext, type SourceCandidate } from "../../packages/plugin-sdk/index.js";
import { domainFromUrl } from "../../server/utils.js";
import { plainHtml } from "../browser-html-utils.js";

const BASE = "https://www.javlibrary.com";

type FlareResponse = {
  status?: string;
  message?: string;
  solution?: { status?: number; url?: string; response?: string };
};

function flareUrl(context: PluginContext): string {
  return String(context.config.flareSolverrUrl ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function protectedHtml(context: PluginContext, url: string): Promise<string> {
  const endpoint = flareUrl(context);
  if (!endpoint) throw new Error("Configure the FlareSolverr URL before using JavLibrary");
  const response = await context.fetch(`${endpoint}/v1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60_000 }),
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`FlareSolverr returned HTTP ${response.status}`);
  const payload = await response.json() as FlareResponse;
  if (payload.status !== "ok" || payload.solution?.status !== 200 || !payload.solution.response) throw new Error(payload.message || `JavLibrary returned HTTP ${payload.solution?.status ?? "unknown"}`);
  if (/cf-chl-|<title>just a moment/i.test(payload.solution.response)) throw new Error("FlareSolverr did not clear JavLibrary's Cloudflare challenge");
  return payload.solution.response;
}

export function parseStarDirectory(html: string) {
  const results: Array<{ id: string; name: string }> = [];
  for (const match of html.matchAll(/<a[^>]+href=["'](?:\.\/)?vl_star\.php\?s=([a-z0-9]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = plainHtml(match[2]);
    if (name && !results.some((item) => item.id === match[1])) results.push({ id: match[1], name });
  }
  return results;
}

function normalizedTokens(value: string): string[] {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

export default definePlugin({
  manifest: {
    id: "org.easyx.javlibrary", name: "JavLibrary", version: "1.0.0", author: "Open EasyX", homepage: BASE,
    description: "Search JavLibrary's performer directory and import star pages. Requires your own FlareSolverr because JavLibrary enforces Cloudflare challenges.",
    capabilities: ["identity-search", "source-discovery"],
    settings: [{
      key: "flareSolverrUrl", label: "FlareSolverr URL", type: "text", required: true, placeholder: "http://flaresolverr:8191",
      help: "Base URL reachable from Open EasyX, for example http://flaresolverr:8191 on the same Docker network, or http://192.168.1.10:8191 for an existing instance. Do not use localhost for a separate container. See docs/FLARESOLVERR.md.",
    }],
  },
  async testConnection(context) {
    const html = await protectedHtml(context, `${BASE}/en/star_list.php?prefix=Yua`);
    if (!/class=["']starbox["']/i.test(html)) throw new Error("JavLibrary did not return its performer directory");
    return { ok: true, message: "FlareSolverr cleared JavLibrary and the performer directory is reachable." };
  },
  async searchPeople(context, query) {
    const tokens = normalizedTokens(query);
    if (!tokens.length) return [];
    const prefixes = [...new Set([tokens[0], tokens.at(-1)!])];
    const pages = await Promise.all(prefixes.map((prefix) => protectedHtml(context, `${BASE}/en/star_list.php?prefix=${encodeURIComponent(prefix)}`)));
    const candidates = pages.flatMap(parseStarDirectory);
    return candidates
      .filter((candidate) => tokens.every((token) => normalizedTokens(candidate.name).includes(token)))
      .filter((candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index)
      .slice(0, 12)
      .map((candidate) => ({ externalId: candidate.id, name: candidate.name, profileUrls: [`${BASE}/en/vl_star.php?s=${candidate.id}`], metadata: { origin: "javlibrary", transport: "flaresolverr" } }));
  },
  async discoverSources(_context, performer): Promise<SourceCandidate[]> {
    const id = performer.externalRefs["org.easyx.javlibrary"];
    if (!id) return [];
    const profileUrl = `${BASE}/en/vl_star.php?s=${encodeURIComponent(id)}`;
    return [{ externalId: profileUrl, label: "JavLibrary star page", profileUrl, domain: domainFromUrl(profileUrl) }];
  },
});
