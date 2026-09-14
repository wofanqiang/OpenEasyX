/**
 * SuperChat VR live-cam plugin for OpenEasyX.
 *
 * vr.superchat.live is a white-label front end over Stripchat's back end, so it exposes
 * the same room catalogue and the same HLS CDN family — but through a plain REST API
 * (`/api/vr/*`) with no server-rendered state and, critically, no playback key for a
 * public room. That makes this plugin API-first: it never parses room HTML, and it needs
 * no token to play or record a free public broadcast.
 *
 * Scope is deliberately limited to rooms whose status is exactly `public`. Private,
 * group and spy shows hand out a paid `modelToken`; this plugin does not request one and
 * does not attempt to reach that content.
 *
 * An account session is only ever read for favourite synchronisation. Cataloguing,
 * playback and recording all work signed out.
 */
import { definePlugin, type LiveCam, type LiveCamFavoriteSnapshot, type LiveCamPage, type LiveCamQuery, type LiveStream, type MediaCandidate, type MediaSource, type PluginContext } from "../../packages/plugin-sdk/index.js";
import { accountSignal, cookieHeader, readAccountCookies } from "../account-cookies.js";
import { ffmpegLiveCaptureCommand } from "../../packages/live-capture.js";
import { configuredArgs, testYtDlp, ytDlpLiveStream } from "../yt-dlp-utils.js";
import {
  SUPERCHAT_API, SUPERCHAT_ORIGIN, SUPERCHAT_STREAM_HEADERS,
  applyMouflonChallenge, buildSuperchatHlsUrl, hlsHostFromPlaylist, isLivePlaylist, isMasterPlaylist,
  isMouflonObfuscated, mouflonDecryptKey, playlistUrls, selectMouflonChallenge, superchatStreamConfig,
  type SuperchatStreamConfig,
} from "./streams.js";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0 Safari/537.36";

/** `primaryTag` values the API accepts. `female`/`male` return HTTP 400 and must not be sent. */
const PRIMARY_TAG: Record<NonNullable<LiveCamQuery["gender"]>, string> = {
  female: "girls", male: "men", couple: "couples", trans: "trans",
};

// The catalogue is walked with an exclusion cursor. 60 is what the endpoint serves per
// call — asking for more does not return more, it just ends the sweep early, because the
// "short batch" below then reads as exhausted.
const BATCH_SIZE = 60;
const BATCH_LIMIT = 150;
const REQUEST_TIMEOUT_MS = 20_000;
// Cap one sweep so a slow catalogue can never block a page render behind it.
const CRAWL_BUDGET_MS = 20_000;
const CATALOGUE_TTL_MS = 180_000;
// Past its freshness window a snapshot is still served instantly for this long while a
// refresh runs in the background; past the grace period we wait instead of showing a
// catalogue that could be hours old.
const CATALOGUE_STALE_GRACE_MS = 300_000;
const CONFIG_TTL_MS = 300_000;

/** Multi-variant master playlist: source 1080p plus 720p/480p/240p. */
const RECORD_SUFFIX = "_auto";
const MAX_FAVORITES = 5_000;

const catalogueCache = new Map<string, { expiresAt: number; cams: LiveCam[] }>();
const catalogueLoads = new Map<string, Promise<LiveCam[]>>();
let streamConfigCache: { expiresAt: number; config: SuperchatStreamConfig } | undefined;

/** Drop every in-memory snapshot. Exists so tests start from a clean slate. */
export function resetSuperchatCaches(): void {
  catalogueCache.clear();
  catalogueLoads.clear();
  streamConfigCache = undefined;
}

// ---------------------------------------------------------------- small helpers

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function whole(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function tagList(values: Array<unknown>): string[] {
  const result: string[] = [];
  for (const value of values) {
    const item = text(value);
    if (!item) continue;
    const tag = item.toLowerCase();
    if (!result.includes(tag)) result.push(tag);
  }
  return result.slice(0, 20);
}

/** Mirrors the shared discovery helper: `tranny`→trans, `group`/`maleFemale`→couple. */
export function normalizedGender(value: unknown): LiveCamQuery["gender"] | undefined {
  const key = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (["f", "female", "females", "woman", "women", "girl", "girls"].includes(key)) return "female";
  if (["m", "male", "males", "man", "men", "boy", "boys"].includes(key)) return "male";
  if (["t", "ts", "trans", "transgender", "femaletranny", "tranny"].includes(key)) return "trans";
  if (["c", "couple", "couples", "group", "malefemale"].includes(key)) return "couple";
  return undefined;
}

export function primaryTagFor(gender: LiveCamQuery["gender"] | undefined): string {
  return PRIMARY_TAG[gender ?? "female"];
}

function dedupe(cams: LiveCam[]): LiveCam[] {
  const result = new Map<string, LiveCam>();
  for (const cam of cams) {
    if (!cam.username.trim()) continue;
    const key = cam.username.toLowerCase();
    const previous = result.get(key);
    if (!previous) result.set(key, cam);
    else result.set(key, {
      ...previous, ...cam,
      thumbnailUrl: previous.thumbnailUrl || cam.thumbnailUrl,
      viewers: Math.max(previous.viewers ?? 0, cam.viewers ?? 0),
      tags: [...new Set([...(previous.tags ?? []), ...(cam.tags ?? [])])],
    });
  }
  return [...result.values()];
}

function requestSignal(context: PluginContext): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
}

/** Every request carries the front end's 5-character `uniq` cache-buster. */
function apiUrl(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(`${SUPERCHAT_API}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("uniq", (Math.random() + 1).toString(36).substring(2, 7));
  return url;
}

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: "application/json", "accept-language": "en-US,en;q=0.8",
    origin: SUPERCHAT_ORIGIN, referer: `${SUPERCHAT_ORIGIN}/`, "user-agent": USER_AGENT,
    ...extra,
  };
}

async function apiJson(context: PluginContext, url: URL, init: RequestInit = {}): Promise<unknown> {
  const response = await context.fetch(url, { ...init, signal: init.signal ?? requestSignal(context) });
  if (!response.ok) throw new Error(`SuperChat API returned HTTP ${response.status}`);
  const body = await response.text();
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { throw new Error("SuperChat returned an invalid API response"); }
}

// ---------------------------------------------------------------- room mapping

export function roomUrl(username: string): string {
  return `${SUPERCHAT_ORIGIN}/cam/${encodeURIComponent(username)}`;
}

export function usernameFromRoomUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const marker = parts.indexOf("cam");
    const candidate = marker >= 0 ? parts[marker + 1] : parts.at(-1);
    return candidate ? decodeURIComponent(candidate) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map one API room record onto a LiveCam. Returns undefined unless the room is live and
 * public — a private or group show is out of scope rather than merely offline.
 */
export function superchatLiveCam(room: unknown): LiveCam | undefined {
  const value = record(room);
  if (!value) return undefined;
  const username = text(value.username);
  if (!username || !/^[a-z0-9_.-]{1,64}$/i.test(username)) return undefined;
  if ((text(value.status) ?? "public").toLowerCase() !== "public") return undefined;
  const age = whole(value.age);
  return {
    id: username.toLowerCase(),
    username,
    title: text(value.groupShowTopic) ?? text(value.name) ?? username,
    pageUrl: roomUrl(username),
    thumbnailUrl: text(value.previewUrlThumbSmall) ?? text(value.previewUrl) ?? text(value.avatarUrl),
    viewers: whole(value.viewersCount) ?? 0,
    age: age !== undefined && age >= 18 && age <= 80 ? age : undefined,
    gender: normalizedGender(value.broadcastGender ?? value.genderGroup ?? value.gender),
    tags: tagList([
      value.broadcastGender ?? value.gender,
      text(value.country)?.toUpperCase(),
      value.isHd === true ? "hd" : undefined,
      value.isVr === true ? "vr" : undefined,
    ]),
  };
}

/** Same mapping, but keeps offline rooms so a favourites list can show them greyed out. */
export function superchatFavoriteCam(room: unknown): (LiveCam & { online: boolean }) | undefined {
  const value = record(room);
  if (!value) return undefined;
  const username = text(value.username);
  if (!username || !/^[a-z0-9_.-]{1,64}$/i.test(username)) return undefined;
  const online = (text(value.status) ?? "").toLowerCase() === "public" && value.isLive !== false;
  const age = whole(value.age);
  return {
    id: username.toLowerCase(),
    username,
    title: text(value.groupShowTopic) ?? text(value.name) ?? username,
    pageUrl: roomUrl(username),
    thumbnailUrl: text(value.previewUrlThumbSmall) ?? text(value.previewUrl) ?? text(value.avatarUrl),
    viewers: online ? whole(value.viewersCount) ?? 0 : 0,
    age: age !== undefined && age >= 18 && age <= 80 ? age : undefined,
    gender: normalizedGender(value.broadcastGender ?? value.genderGroup ?? value.gender),
    tags: tagList([
      value.broadcastGender ?? value.gender,
      text(value.country)?.toUpperCase(),
      value.isHd === true ? "hd" : undefined,
      value.isVr === true ? "vr" : undefined,
    ]),
    online,
  };
}

/** Rank a snapshot, filter it, then slice one page out of it locally. */
export function superchatPage(cams: LiveCam[], query: LiveCamQuery): LiveCamPage {
  const needle = query.search?.trim().toLowerCase();
  const matching = dedupe(cams)
    .filter((cam) => {
      if (query.gender && normalizedGender(cam.gender) !== query.gender) return false;
      return !needle || `${cam.username} ${cam.title ?? ""} ${(cam.tags ?? []).join(" ")}`.toLowerCase().includes(needle);
    })
    .sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0));
  const start = (query.page - 1) * query.pageSize;
  const total = matching.length;
  return {
    cams: matching.slice(start, start + query.pageSize), total,
    page: query.page, pageSize: query.pageSize, pages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

// ---------------------------------------------------------------- catalogue

/**
 * Walk the whole catalogue for one tag with an exclusion cursor.
 *
 * The cursor must carry the numeric ids seen so far; a short batch, a batch that adds
 * nothing new, or the budget running out all end the sweep. A failure after at least one
 * batch is kept as a partial catalogue — a short list beats an error page.
 */
async function loadCatalogue(context: PluginContext, primaryTag: string): Promise<LiveCam[]> {
  const seen = new Map<number, Record<string, unknown>>();
  const deadline = Date.now() + CRAWL_BUDGET_MS;
  for (let batch = 0; batch < BATCH_LIMIT; batch += 1) {
    const remaining = deadline - Date.now();
    if (batch > 0 && remaining <= 0) {
      context.log("warn", `SuperChat live catalogue stopped at its ${CRAWL_BUDGET_MS}ms budget with ${seen.size} rooms loaded`);
      break;
    }
    let pageRooms: Record<string, unknown>[];
    try {
      const response = await context.fetch(apiUrl("/models/get-list"), {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          primaryTag, limit: BATCH_SIZE, topLimit: BATCH_SIZE,
          blockId: "topStreamsModels", blockUrl: "", excludeModelIds: [...seen.keys()],
        }),
        // Never wait past the end of the budget, so the sweep cannot overrun it.
        signal: context.signal ?? AbortSignal.timeout(Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, remaining > 0 ? remaining : REQUEST_TIMEOUT_MS))),
      });
      if (!response.ok) throw new Error(`SuperChat live rooms returned HTTP ${response.status}`);
      const payload = record(await response.json());
      pageRooms = Array.isArray(payload?.models)
        ? payload.models.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
        : [];
    } catch (error) {
      if (!seen.size) throw error;
      context.log("warn", `SuperChat live catalogue request failed after ${seen.size} rooms; serving a partial snapshot`, error instanceof Error ? error.message : String(error));
      break;
    }
    let added = 0;
    for (const room of pageRooms) {
      const id = whole(room.id);
      if (id === undefined || seen.has(id)) continue;
      seen.set(id, room);
      added += 1;
    }
    if (!added || pageRooms.length < BATCH_SIZE) break;
  }
  return dedupe([...seen.values()].map((room) => superchatLiveCam(room)).filter((cam): cam is LiveCam => Boolean(cam)));
}

async function searchCatalogue(context: PluginContext, primaryTag: string, term: string): Promise<LiveCam[]> {
  const payload = record(await apiJson(context, apiUrl("/v4/models/search/group/username", { primaryTag, query: term })));
  const rooms = Array.isArray(payload?.models) ? payload.models : [];
  return rooms.map(superchatLiveCam).filter((cam): cam is LiveCam => Boolean(cam));
}

async function catalogue(context: PluginContext, primaryTag: string): Promise<LiveCam[]> {
  const cacheKey = `superchat:${primaryTag}`;
  const cached = catalogueCache.get(cacheKey);
  const refresh = () => {
    // Collapse concurrent sweeps for the same tag so several open tabs cannot stampede upstream.
    const operation = catalogueLoads.get(cacheKey) ?? loadCatalogue(context, primaryTag).finally(() => catalogueLoads.delete(cacheKey));
    catalogueLoads.set(cacheKey, operation);
    return operation.then((cams) => {
      catalogueCache.set(cacheKey, { cams, expiresAt: Date.now() + CATALOGUE_TTL_MS });
      return cams;
    });
  };
  if (cached && cached.expiresAt > Date.now()) return cached.cams;
  // A full sweep is far slower than the page's own refresh interval, so serve the previous
  // snapshot immediately and refresh behind the render instead of stalling on it.
  if (cached?.cams.length && Date.now() < cached.expiresAt + CATALOGUE_STALE_GRACE_MS) {
    void refresh().catch((error) => context.log("warn", "SuperChat live catalogue background refresh failed", error instanceof Error ? error.message : String(error)));
    return cached.cams;
  }
  try {
    return await refresh();
  } catch (error) {
    if (cached?.cams.length) {
      context.log("warn", "SuperChat live catalogue refresh failed; serving the last successful snapshot", error instanceof Error ? error.message : String(error));
      return cached.cams;
    }
    throw error;
  }
}

// ---------------------------------------------------------------- stream resolution

async function loadStreamConfig(context: PluginContext): Promise<SuperchatStreamConfig> {
  if (streamConfigCache && streamConfigCache.expiresAt > Date.now()) return streamConfigCache.config;
  const config = superchatStreamConfig(await apiJson(context, apiUrl("/v3/config/initial")));
  streamConfigCache = { expiresAt: Date.now() + CONFIG_TTL_MS, config };
  return config;
}

export type SuperchatRoomState = {
  modelId: number;
  streamName: string;
  modelToken: string;
  online: boolean;
  status: string;
  title?: string;
  viewers?: number;
  gender?: string;
  thumbnailUrl?: string;
  isVr?: boolean;
  isHd?: boolean;
  playlistHint?: string;
};

/** Resolve a username to its numeric room id. */
export async function superchatModelId(context: PluginContext, username: string): Promise<number> {
  const payload = record(await apiJson(context, apiUrl(`/users/user-ids/${encodeURIComponent(username)}`)));
  const id = whole(payload?.id);
  if (id === undefined || id <= 0) throw new Error(`SuperChat could not identify ${username}`);
  return id;
}

/**
 * One exact room, with the fields a stream needs. The detail endpoint returns the model,
 * its public `cam` token and the stream name in a single response.
 */
export async function superchatRoomState(context: PluginContext, username: string): Promise<SuperchatRoomState> {
  const modelId = await superchatModelId(context, username);
  const payload = record(await apiJson(context, apiUrl(`/v2/models/${modelId}`)));
  if (!payload) throw new Error("SuperChat returned an invalid room response");
  const model = record(payload.model) ?? {};
  const cam = record(payload.cam) ?? {};
  const status = (text(model.status) ?? "").toLowerCase();
  const age = whole(model.age);
  return {
    modelId,
    streamName: text(payload.streamName) ?? text(cam.streamName) ?? String(modelId),
    modelToken: text(cam.modelToken) ?? "",
    online: status === "public" && model.isLive !== false,
    status,
    title: text(model.name) ?? text(cam.topic),
    viewers: whole(model.viewersCount) ?? whole(cam.viewersCount),
    gender: text(model.broadcastGender) ?? text(model.gender),
    thumbnailUrl: text(model.previewUrlThumbSmall) ?? text(model.previewUrlThumb),
    isVr: model.isVr === true,
    isHd: model.isHd === true,
    playlistHint: text(model.hlsPlaylist),
  };
}

/**
 * Resolve a playable media playlist.
 *
 * Two things have to be right before the CDN will serve the live window, both established by
 * watching the real player: the request must echo the master's `PSCH` challenge back as
 * `?psch=&pkey=`, and this VR front end publishes the immersive camera under a `<id>_vr`
 * stream name (a merely 2D room answers to its bare id, so that is the fallback).
 *
 * The address handed back is the challenged *variant* playlist rather than the master,
 * because the master only lists variants and carries no segments.
 *
 * That playlist still writes decoy segment addresses and encrypts the real ones, so the returned
 * `LiveStream` carries the decryption key and the server's live proxy decrypts as it rewrites
 * (see `playlistDecodeKey` on `LiveStream` and `packages/hls-mouflon.ts`). Without that key a
 * recorder would fetch the decoy and get a 404 body.
 */
export async function resolveSuperchatStream(context: PluginContext, cam: LiveCam): Promise<LiveStream> {
  const username = text(cam.username) ?? usernameFromRoomUrl(cam.pageUrl);
  if (!username || !/^[a-z0-9_.-]{1,64}$/i.test(username)) throw new Error("SuperChat received an invalid room name");
  const state = await superchatRoomState(context, username);
  if (!state.online) throw new Error(`${username} is not broadcasting a public show`);

  const config = await loadStreamConfig(context);
  const hosts: string[] = [];
  const hint = hlsHostFromPlaylist(state.playlistHint);
  if (hint) hosts.push(hint);
  for (const host of config.hosts) if (!hosts.includes(host)) hosts.push(host);

  const streamNames = state.isVr === true ? [`${state.streamName}_vr`, state.streamName] : [state.streamName];

  for (const streamName of streamNames) {
    for (const host of hosts) {
      const master = new URL(buildSuperchatHlsUrl(config.template, host, streamName, RECORD_SUFFIX));
      // The VR feed is only published as a low-latency playlist.
      master.searchParams.set("playlistType", "lowLatency");
      // A public room leaves this empty; a private show would not, and would then need the
      // paid token we deliberately never fetch.
      if (state.modelToken) master.searchParams.set("aclAuth", state.modelToken);
      try {
        const response = await context.fetch(master, { headers: SUPERCHAT_STREAM_HEADERS, signal: requestSignal(context) });
        if (!response.ok) continue;
        const manifest = await response.text();
        if (!manifest.trimStart().startsWith("#EXTM3U") || manifest.includes("#EXT-X-MOUFLON-ADVERT")) continue;
        // Any advertised token satisfies the challenge, but only a key one decrypts the segment
        // addresses, so pick the pair the player itself would settle on.
        const challenge = selectMouflonChallenge(manifest);
        const decodeKey = challenge ? mouflonDecryptKey(challenge) : undefined;
        for (const candidate of playlistUrls(manifest, master.toString())) {
          const variant = new URL(challenge ? applyMouflonChallenge(candidate, challenge) : candidate);
          if (state.modelToken && !variant.searchParams.has("aclAuth")) variant.searchParams.set("aclAuth", state.modelToken);
          const variantResponse = await context.fetch(variant, { headers: SUPERCHAT_STREAM_HEADERS, signal: requestSignal(context) });
          if (!variantResponse.ok) continue;
          const media = await variantResponse.text();
          if (!isLivePlaylist(media) || isMasterPlaylist(media)) continue;
          if (isMouflonObfuscated(media) && !decodeKey) {
            context.log("warn", `SuperChat playlist for ${username} obfuscates its segment addresses but advertises no key we know; the CDN may have rotated its keymap`);
          }
          return {
            url: variant.toString(), headers: SUPERCHAT_STREAM_HEADERS,
            contentType: "application/vnd.apple.mpegurl", playlistDecodeKey: decodeKey,
          };
        }
      } catch { /* Try the next CDN host. */ }
    }
  }
  throw new Error("No public SuperChat HLS host returned a live manifest");
}

/**
 * This CDN obfuscates its segment addresses (MOUFLON), so a recorder must have every playlist
 * coerced and decrypted before ffmpeg parses it. `resolveSuperchatStream` reports the key on the
 * returned `LiveStream`, and the server's live proxy applies `coerceMouflonPlaylist` with it, so
 * both the in-app player and the recorder read real addresses. Flagged here because a plugin
 * author must know this platform cannot be handed straight to ffmpeg.
 */
export const SUPERCHAT_REQUIRES_PLAYLIST_REWRITE = true;

// ---------------------------------------------------------------- media / recording

export async function listSuperchatMedia(context: PluginContext, source: MediaSource): Promise<MediaCandidate[]> {
  const username = usernameFromRoomUrl(source.profileUrl);
  if (!username) return [];
  let state: SuperchatRoomState;
  try { state = await superchatRoomState(context, username); }
  catch (error) {
    context.log("debug", "SuperChat live status lookup failed", error instanceof Error ? error.message : String(error));
    return [];
  }
  if (!state.online) return [];
  const safeName = username.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "live";
  return [{
    externalId: `superchat:${username.toLowerCase()}:live`,
    // The recorder rebuilds a LiveCam from this candidate and uses identityKey as the
    // username, so it has to carry the room name rather than the title.
    identityKey: username,
    title: state.title ?? `${username} live`,
    pageUrl: roomUrl(username),
    mediaType: "video",
    filename: `${safeName}-live.mp4`,
    metadata: {
      extractorUrl: roomUrl(username), live: true,
      viewers: state.viewers, gender: state.gender, vr: state.isVr === true, hd: state.isHd === true,
    },
  }];
}

export async function resolveSuperchatDownload(context: PluginContext, item: MediaCandidate): Promise<import("../../packages/plugin-sdk/index.js").CommandDownloadRequest> {
  const meta = item.metadata as Record<string, unknown> | undefined;
  const pageUrl = item.pageUrl ?? (typeof meta?.extractorUrl === "string" ? meta.extractorUrl : undefined);
  const username = usernameFromRoomUrl(pageUrl) ?? item.identityKey;
  if (!username || !pageUrl) throw new Error("SuperChat recording is missing its public room URL");
  const stream = await resolveSuperchatStream(context, { id: item.externalId, username, title: item.title, pageUrl });
  return ffmpegLiveCaptureCommand(stream, {
    referer: `${SUPERCHAT_ORIGIN}/`, output: "{outputDir}/capture.ts",
    filename: item.filename ?? `${item.externalId}.mp4`,
  });
}

// ---------------------------------------------------------------- account + favourites

type SuperchatAccount = { cookies: Map<string, string>; userId: number; csrf: { csrfToken: string; csrfTimestamp: string; csrfNotifyTimestamp: string } };

function accountHeaders(account: SuperchatAccount, hasBody = false): Record<string, string> {
  return apiHeaders({
    cookie: cookieHeader(account.cookies),
    ...(hasBody ? { "content-type": "application/json" } : {}),
  });
}

/**
 * Read the signed-in account out of the operator's own session.
 *
 * The front end takes the user id and the CSRF triple from `config/initial`; both are only
 * populated for a signed-in session, so a guest response means the stored session is not
 * usable and the caller degrades instead of guessing.
 */
async function superchatAccount(context: PluginContext): Promise<SuperchatAccount | undefined> {
  const cookies = readAccountCookies(context, "superchat.live", "SuperChat");
  if (!cookies) return undefined;
  const response = await context.fetch(apiUrl("/v3/config/initial"), { headers: { ...apiHeaders(), cookie: cookieHeader(cookies) }, signal: accountSignal(context) });
  if (response.status === 401 || response.status === 403) throw new Error("The SuperChat session is expired. Reconnect the account.");
  if (!response.ok) throw new Error(`SuperChat could not verify the connected account (HTTP ${response.status})`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("SuperChat returned an invalid account response"); }
  const client = record(record(record(payload)?.initial)?.client);
  const user = record(client?.user);
  const userId = whole(user?.id) ?? whole(user?.userId);
  if (userId === undefined || userId <= 0) throw new Error("The SuperChat session is not signed in. Sign in, then capture the session again.");
  const csrfToken = text(client?.csrfToken);
  const csrfTimestamp = text(client?.csrfTimestamp);
  const csrfNotifyTimestamp = text(client?.csrfNotifyTimestamp);
  if (!csrfToken || !csrfTimestamp || !csrfNotifyTimestamp) throw new Error("SuperChat did not issue a CSRF token for this session");
  return { cookies, userId, csrf: { csrfToken, csrfTimestamp, csrfNotifyTimestamp } };
}

/** The front end merges its CSRF triple into the JSON body rather than into a header. */
function csrfEnvelope(account: SuperchatAccount, payload: Record<string, unknown>): Record<string, unknown> {
  return { ...account.csrf, uniq: Date.now(), ...payload };
}

async function superchatApi(context: PluginContext, account: SuperchatAccount, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const response = await context.fetch(apiUrl(path), {
    method, headers: accountHeaders(account, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(csrfEnvelope(account, body)) } : {}),
    signal: accountSignal(context),
  });
  if (response.status === 401 || response.status === 403) throw new Error("The SuperChat session is expired or was refused. Reconnect the account.");
  if (!response.ok) throw new Error(`SuperChat API returned HTTP ${response.status}`);
  const textBody = await response.text();
  if (!textBody.trim()) return {};
  try { return JSON.parse(textBody); } catch { throw new Error("SuperChat returned an invalid favourites response"); }
}

export async function superchatFollowedSnapshot(context: PluginContext): Promise<LiveCamFavoriteSnapshot> {
  let account: SuperchatAccount | undefined;
  try { account = await superchatAccount(context); }
  catch (error) { return { cams: [], authoritative: false, skippedReason: error instanceof Error ? error.message : String(error) }; }
  if (!account) return { cams: [], authoritative: false, skippedReason: "Connect a SuperChat account to synchronize followed creators." };
  try {
    const payload = record(await superchatApi(context, account, "GET", `/v2/users/${account.userId}/favorites`));
    // The endpoint answers with room objects directly; accept a bare id list too, in case
    // the white-label back end switches to Stripchat's shape.
    const rooms = Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload) ? payload : [];
    const cams = rooms.map(superchatFavoriteCam).filter((cam): cam is LiveCam & { online: boolean } => Boolean(cam));
    if (cams.length > MAX_FAVORITES) throw new Error("The SuperChat followed list exceeded its safety limit");
    return { cams: dedupe(cams) as Array<LiveCam & { online: boolean }>, authoritative: true };
  } catch (error) {
    const skippedReason = error instanceof Error ? error.message : String(error);
    context.log("warn", "SuperChat favourite synchronization skipped", { reason: skippedReason });
    return { cams: [], authoritative: false, skippedReason };
  }
}

export async function setSuperchatFavorite(context: PluginContext, cam: LiveCam, favorite: boolean): Promise<{ synchronized: boolean }> {
  const account = await superchatAccount(context);
  if (!account) return { synchronized: false };
  const username = text(cam.username) ?? usernameFromRoomUrl(cam.pageUrl);
  if (!username || !/^[a-z0-9_.-]{1,64}$/i.test(username)) throw new Error("SuperChat received an invalid room name");
  const modelId = await superchatModelId(context, username);
  await superchatApi(context, account, favorite ? "PUT" : "DELETE", `/v2/users/${account.userId}/favorites/${modelId}`);
  // Read back rather than trusting the write: the API is undocumented and a silent no-op
  // would otherwise look like success.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = record(await superchatApi(context, account, "GET", `/v2/users/${account.userId}/favorites`));
    const rooms = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const listed = rooms.some((room) => whole(record(room)?.id) === modelId);
    if (listed === favorite) return { synchronized: true };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`SuperChat did not confirm that ${username} was ${favorite ? "followed" : "unfollowed"}`);
}

// ---------------------------------------------------------------- plugin

export default definePlugin({
  manifest: {
    id: "org.easyx.superchatlive",
    name: "SuperChat VR Live",
    version: "1.0.0",
    author: "Open EasyX",
    homepage: SUPERCHAT_ORIGIN,
    description: "Browse, play and record public SuperChat VR rooms. Public rooms need no account; a session is only read for favourite synchronisation.",
    capabilities: ["media-listing", "download-resolver", "live-cam"],
    sourceUrlPatterns: [
      "http://vr.superchat.live/*", "https://vr.superchat.live/*",
      "http://superchat.live/*", "https://superchat.live/*",
    ],
    polling: { mode: "live", defaultIntervalSeconds: 15, minimumIntervalSeconds: 10 },
    browserAuth: { loginUrl: `${SUPERCHAT_ORIGIN}/`, sessionSetting: "cookiesFile" },
    settings: [{
      key: "cookiesFile", label: "Account session", type: "session", cookieDomains: ["superchat.live"],
      help: "Optional. Public rooms can be browsed and recorded without an account; a session is only used to synchronize favourites.",
    }],
  },
  async testConnection(context) {
    try {
      const config = await loadStreamConfig(context);
      if (!text(context.config.cookiesFile)) return { ok: true, message: `SuperChat API reachable; ${config.hosts.length} HLS hosts available.` };
      const account = await superchatAccount(context);
      if (!account) return { ok: false, message: "Connect a SuperChat account in the integrated browser." };
      return { ok: true, message: "SuperChat API reachable and the account session is signed in." };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
  async listLiveCams(context, query) {
    const primaryTag = primaryTagFor(query.gender);
    if (query.search?.trim()) {
      try {
        const found = await searchCatalogue(context, primaryTag, query.search.trim());
        if (found.length) return superchatPage(found, query);
      } catch (error) {
        context.log("debug", "SuperChat search endpoint failed; falling back to the cached catalogue", error instanceof Error ? error.message : String(error));
      }
    }
    return superchatPage(await catalogue(context, primaryTag), query);
  },
  async getLiveCam(context, cam) {
    const username = text(cam.username) ?? usernameFromRoomUrl(cam.pageUrl);
    if (!username) throw new Error("SuperChat received an invalid room name");
    const state = await superchatRoomState(context, username);
    return {
      ...cam, online: state.online, statusUnavailable: false,
      title: state.title ?? cam.title,
      viewers: state.online ? state.viewers ?? 0 : 0,
      gender: normalizedGender(state.gender) ?? cam.gender,
      thumbnailUrl: cam.thumbnailUrl ?? state.thumbnailUrl,
    };
  },
  async listMedia(context, source) { return listSuperchatMedia(context, source); },
  async resolveLiveStream(context, cam) { return resolveSuperchatStream(context, cam); },
  async resolveDownload(context, item) { return resolveSuperchatDownload(context, item); },
  async listFollowedLiveCams(context) { return superchatFollowedSnapshot(context); },
  async setLiveCamFavorite(context, cam, favorite) { return setSuperchatFavorite(context, cam, favorite); },
  async afterDownload() { /* Records land in the library unchanged. */ },
  async acceptLibraryDeletion(_context, deletion) { return deletion; },
  async searchPeople() { return []; },
  async discoverSources() { return []; },
});

/** Referenced so the optional yt-dlp fallback stays discoverable from this plugin. */
export const superchatYtDlpFallback = { testYtDlp, ytDlpLiveStream, configuredArgs };
