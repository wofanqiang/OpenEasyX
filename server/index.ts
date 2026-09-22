import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import Fastify from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import fastifyStatic from "@fastify/static";
import pino from "pino";
import { z } from "zod";
import { Database, ACTIVE_ITEM_STATUSES } from "./database.js";
import type { Performer } from "./database.js";
import { PluginManager, pluginMatchesSource } from "./plugin-manager.js";
import { DownloadQueue } from "./downloader.js";
import { discoverPeople } from "./discovery.js";
import { deletePerformerFiles, performerDirectory, ensurePerformerDirectory, renamePerformerDirectory } from "./performer-files.js";
import { domainFromUrl } from "./utils.js";
import { BrowserLoginManager } from "./browser-login.js";
import { LogStore, type LogWriter } from "./log-store.js";
import { LiveCamImages } from "./live-cam-images.js";
import { LiveCamService } from "./live-cams.js";
import { HlsProxy, isLiveProxyPath } from "./hls-proxy.js";
import { SystemStatsService } from "./system-stats.js";
import { PluginRepositoryManager } from "./plugin-repositories.js";
import { LibraryDatabase } from "./library-database.js";
import { Catalog } from "./catalog.js";
import { registerLibraryRoutes, parseMediaRange } from "./library-routes.js";
import { settingsSchema } from "./output-settings.js";
import { startAutoRecorder } from "./auto-recorder.js";
import { retentionPlan } from "./retention.js";
import { spliceLiveSessions } from "./live-sessions.js";
import { startMerge } from "./media-merge.js";
import { TaskRegistry } from "./tasks.js";
import { runDiagnostics } from "./diagnostics.js";
import { isLiveCandidate } from "../packages/live-capture.js";
import { AuthService } from "./auth.js";
import type { FastifyRequest, FastifyReply } from "fastify";

const port = Number(process.env.PORT ?? 3210);
const dataDir = path.resolve(process.env.EASYX_DATA_DIR ?? "data");
const mediaDir = path.resolve(process.env.EASYX_MEDIA_DIR ?? "media");
const externalPluginsDir = path.resolve(process.env.EASYX_EXTERNAL_PLUGINS_DIR ?? "plugins-external");
const scanIntervalMinutes = Math.max(1, Number(process.env.EASYX_SCAN_INTERVAL_MINUTES ?? 10));
const appVersion = process.env.APP_VERSION?.trim() || "dev";
const logStore = new LogStore();
const appLogger = pino({ level: process.env.EASYX_LOG_LEVEL ?? "info" }, logStore.stream);
// Node ends the process on an unhandled promise rejection by default. A single stray
// rejection (a late database write, a plugin callback) would therefore kill every
// in-flight recording and download, so log it loudly and keep serving instead.
process.on("unhandledRejection", (reason) => {
  appLogger.error({ scope: "process", err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason }, "Unhandled promise rejection");
});
const writeLog: LogWriter = (level, scope, message, details) => appLogger[level]({ scope, ...(details === undefined ? {} : { details }) }, message);
const db = new Database(dataDir);
const auth = new AuthService(db, process.env.EASYX_SESSION_SECRET, (line) => appLogger.info({ scope: "auth" }, line));
await auth.bootstrap();
const libraryDb = new LibraryDatabase(dataDir);
const catalog = new Catalog(libraryDb, mediaDir, dataDir, undefined, (relativePath) => db.storedMediaMetadata(relativePath), (message) => appLogger.warn({ scope: "catalog" }, message));
const pluginRepositories = new PluginRepositoryManager(dataDir, path.resolve("plugins"), externalPluginsDir);
const plugins = new PluginManager(db, pluginRepositories.roots(), path.join(dataDir, "sessions"), writeLog);
await plugins.load();
// Streams whose playlists must be rewritten are recorded through the app's own HLS proxy, so
// ffmpeg needs an absolute origin it can reach from inside this process or container.
const selfOrigin = process.env.EASYX_SELF_ORIGIN ?? `http://127.0.0.1:${port}`;
const liveProxy = new HlsProxy(fetch);
const liveCamImages = new LiveCamImages(db, plugins, path.join(dataDir, "performer-images"));
const liveCams = new LiveCamService(db, plugins, fetch, (providerId, cam, performer) => { void liveCamImages.ensure(providerId, cam, performer); }, liveProxy);
const queue = new DownloadQueue(
  db, plugins, mediaDir, writeLog, () => catalog.scan(),
  (item) => catalog.deleteStoredMedia(item.storagePath!),
  liveProxy, selfOrigin,
  // Confirmed-offline capture failures feed the live-cam status cache so the auto-recorder
  // stops re-queueing a room whose provider page says it is offline.
  (item, message) => liveCams.reportLiveFailure(item, message),
);
// Long-running background jobs (Library merge, Recovery sweep) live in their own registry and are
// surfaced to the Activity page by /api/tasks, rather than being faked as download items.
const tasks = new TaskRegistry();
const browserLogin = new BrowserLoginManager(dataDir);
// The /browser proxy is deliberately outside the session gate (the hook above only
// guards /api/), and x11vnc runs without a password, so enabling this exposes a remote
// desktop to anyone who can reach the port. Say so loudly at boot.
if (process.env.EASYX_ENABLE_BROWSER_LOGIN === "true") {
  appLogger.warn({ scope: "browser-login" }, "Browser login is enabled: /browser (noVNC) is served without authentication and the VNC server has no password. Only enable it on a trusted network.");
}
const systemStats = new SystemStatsService({ mediaDir });
// Performers are intentionally NOT materialized from live-cam favorites at boot. A favorite is a
// pure bookmark (see LiveCamService.setFavorite and the adoptLegacyFavoriteAutoRecord note): recording
// a room still creates its performer on demand via record(), but deleting a performer must not
// resurrect it from a leftover favorite on the next restart. Keeping the two entities independent is
// what makes "delete performer" stick.
queue.start();
systemStats.start();

const app = Fastify({ loggerInstance: appLogger, bodyLimit: 8 * 1024 * 1024 });
const discoveryStatus = { running: false, completed: 0, total: 0, progress: 0, query: "", error: "" };
const performerRefreshStatus = { running: false, completed: 0, total: 0, progress: 0, error: "" };
// Auto-record is a performer setting now. Promote anything that was armed under the old
// favorite-level rule exactly once, so this upgrade cannot silently stop an existing schedule.
const adoptedAutoRecord = liveCams.adoptLegacyFavoriteAutoRecord();
if (adoptedAutoRecord.adopted) app.log.info({ scope: "auto-record", adopted: adoptedAutoRecord.adopted, performers: adoptedAutoRecord.performers }, `Adopted ${adoptedAutoRecord.adopted} performer(s) that were armed at the favorite level`);
if (adoptedAutoRecord.orphaned.length) app.log.warn({ scope: "auto-record", orphaned: adoptedAutoRecord.orphaned }, "Auto-record was armed for favorites with no performer; add them as performers to keep recording");
const raisedIntervals = enforcePollingFloors();
if (raisedIntervals) app.log.info({ scope: "sources", count: raisedIntervals }, `Raised ${raisedIntervals} source(s) to their provider's minimum polling interval`);
const autoRecorder = startAutoRecorder({ db, liveCams, mediaRoot: mediaDir, log: (message) => app.log.info({ scope: "auto-record" }, message) });

function ensureBrowserLoginEnabled() {
  if (process.env.EASYX_ENABLE_BROWSER_LOGIN !== "true") {
    throw Object.assign(new Error("Integrated browser login is disabled on this instance (set EASYX_ENABLE_BROWSER_LOGIN=true to enable it)"), { statusCode: 503 });
  }
}

function refreshLiveCamFavorites(providerId?: string) {
  if (providerId && !plugins.get(providerId, false).listFollowedLiveCams) return;
  const sync = providerId ? liveCams.syncFavorites(providerId).then((result) => [result]) : liveCams.syncAllFavorites();
  void sync.then((results) => {
    for (const result of results) {
      if (result.authoritative) app.log.info({ scope: "live-cams", ...result }, "Provider favorites synchronized");
      else if (result.skippedReason && !result.skippedReason.startsWith("Connect a Chaturbate account")) app.log.warn({ scope: "live-cams", ...result }, "Provider favorite synchronization skipped");
    }
  }).catch((error) => app.log.warn({ scope: "live-cams", error, providerId }, "Provider favorite synchronization failed"));
}

app.setErrorHandler((error, request, reply) => {
  // A zod 4.x ZodError carries no `statusCode`, so without this branch every `.parse()`
  // failure across the API would collapse to a 500 and leak the raw issues JSON to the client.
  if (error instanceof z.ZodError) {
    app.log.warn({ issues: error.issues, method: request.method, url: request.url, scope: "http" }, "Request validation failed");
    return reply.status(400).send({ error: "Validation failed", issues: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
  }
  const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? Number((error as { statusCode: number }).statusCode) : 500;
  const message = error instanceof Error ? error.message : String(error);
  app.log[status >= 500 ? "error" : "warn"]({ err: error, method: request.method, url: request.url, scope: "http" }, "Request failed");
  reply.status(status >= 400 && status < 600 ? status : 500).send({ error: message });
});

const SESSION_COOKIE = "easyx_session";
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const raw of header.split(";")) {
    const index = raw.indexOf("=");
    if (index < 0) continue;
    const key = raw.slice(0, index).trim();
    if (key) out[key] = decodeURIComponent(raw.slice(index + 1).trim());
  }
  return out;
}
function cookieSecure(request: FastifyRequest): boolean {
  return request.headers["x-forwarded-proto"] === "https" || process.env.EASYX_COOKIE_SECURE === "true";
}
function sessionCookie(request: FastifyRequest): string | undefined {
  return parseCookies(request.headers.cookie)[SESSION_COOKIE];
}
// Global authentication gate. Added before any route registration so it wraps
// every endpoint (including those registered via plugins) and the static UI.
app.addHook("onRequest", (request, reply, done) => {
  const path = new URL(request.url, "http://localhost").pathname;
  // Endpoints that must work without a session.
  if (path === "/api/auth/login" || path === "/api/auth/me" || path === "/api/health" || path === "/api/version") return done();
  // Live streams are recorded by ffmpeg inside this process, which has no cookie, so the
  // proxy route is reached by capability URL instead of by session. See `isLiveProxyPath`.
  if (isLiveProxyPath(path)) return done();
  // Static assets and the internal browser proxy are served without authentication so the SPA shell can render.
  if (!path.startsWith("/api/")) return done();
  if (!auth.verifySession(sessionCookie(request))) return reply.status(401).send({ error: "unauthorized" });
  // CSRF protection for state-changing requests: the cookie is SameSite=Lax and a
  // custom header that browsers cannot attach on cross-site requests is required.
  if (request.method !== "GET" && request.method !== "OPTIONS" && request.headers["x-requested-with"] !== "EasyX") {
    return reply.status(403).send({ error: "csrf" });
  }
  done();
});

await app.register(fastifyHttpProxy, { upstream: "http://127.0.0.1:6080", prefix: "/browser", websocket: true });
const library = registerLibraryRoutes(app, libraryDb, catalog, db, dataDir, () => tasks.activeSourceIds());

app.get("/api/health", async () => ({ ok: true, product: "Open EasyX", version: appVersion, plugins: plugins.list().length, library: libraryDb.stats().total, scan: catalog.status }));
app.get("/api/version", async () => ({ version: appVersion }));
// Host and container resource snapshot. Sampling happens on a background timer
// inside SystemStatsService; this handler only reads the cached snapshot.
app.get("/api/system/stats", async () => systemStats.snapshotNow());
app.get("/api/system/diagnostics", async () => runDiagnostics({ db, plugins, mediaRoot: mediaDir, activePids: () => queue.activePids() }));

app.post("/api/auth/login", async (request, reply) => {
  const limit = auth.checkRateLimit(request.ip);
  if (!limit.allowed) return reply.status(429).header("retry-after", String(limit.retryAfter)).send({ error: "Too many attempts; please wait and try again" });
  const { password } = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
  if (!(await auth.verifyLogin(password))) {
    auth.recordFailure(request.ip);
    return reply.status(401).send({ error: "Invalid password" });
  }
  auth.resetFailures(request.ip);
  const maxAge = 30 * 24 * 60 * 60;
  reply.header("set-cookie", `${SESSION_COOKIE}=${auth.createSession()}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${cookieSecure(request) ? "; Secure" : ""}`);
  return { ok: true };
});
app.post("/api/auth/logout", async (request, reply) => {
  reply.header("set-cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${cookieSecure(request) ? "; Secure" : ""}`);
  return { ok: true };
});
app.post("/api/auth/change-password", async (request) => {
  const body = z.object({ current: z.string().min(1).max(200), next: z.string().min(8).max(200) }).parse(request.body);
  await auth.changePassword(body.current, body.next);
  return { ok: true };
});
app.get("/api/auth/me", async (request, reply) => {
  if (auth.verifySession(sessionCookie(request))) return { authenticated: true, user: "admin" };
  return reply.status(401).send({ error: "unauthorized" });
});
// Performer responses carry the auto-record flag (a first-class performer setting that is also
// mirrored onto matched live-cam favorites) so the Performers UI can render its toggle directly.
function publicPerformer(performer: Performer) {
  return { ...performer, autoRecord: liveCams.performerAutoRecord(performer) };
}
// Stopping a live recording by hand means "not this session": the watcher keeps the cam
// paused until the room goes offline instead of restarting the same broadcast.
function pauseAutoRecordForItem(itemId: string) {
  const item = db.getItem(itemId);
  const username = item ? /^(?:auto|manual)-live:([^:]+):/.exec(item.externalId)?.[1] : undefined;
  if (item && username) autoRecorder.suppress(item.pluginId, username);
}
app.get("/api/dashboard", async () => ({ stats: db.stats(), performers: db.listPerformers().map(publicPerformer), sources: db.listSources(), items: db.listItems(30) }));
app.get<{ Querystring: Record<string, string | undefined> }>("/api/logs", async (request) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(1_000).default(500), level: z.enum(["debug", "info", "warn", "error"]).optional(), search: z.string().trim().max(200).optional() }).parse(request.query);
  return { entries: logStore.list(query) };
});
app.get("/api/logs/stream", async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  reply.raw.write(": connected\n\n");
  const lastId = Number(request.headers["last-event-id"] ?? 0);
  const send = (entry: ReturnType<typeof logStore.add>) => {
    if (entry.id <= lastId || reply.raw.destroyed) return;
    reply.raw.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
  };
  for (const entry of logStore.list({ limit: 1_000, afterId: Number.isFinite(lastId) ? lastId : 0 })) send(entry);
  const unsubscribe = logStore.subscribe(send);
  const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n"); }, 15_000); heartbeat.unref();
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  request.raw.once("close", cleanup); reply.raw.once("close", cleanup);
});

app.get("/api/plugins", async () => plugins.list());
app.get("/api/plugin-repositories", async () => pluginRepositories.list());
app.post<{ Body: { url?: unknown; name?: unknown } }>("/api/plugin-repositories", async (request) => {
  if (typeof request.body?.url !== "string") throw Object.assign(new Error("A Git repository URL is required"), { statusCode: 400 });
  const repository = await pluginRepositories.add(request.body.url, typeof request.body.name === "string" ? request.body.name : undefined);
  plugins.setRoots(pluginRepositories.roots()); await plugins.load(); return { repository, plugins: plugins.list() };
});
app.post<{ Params: { id: string } }>("/api/plugin-repositories/:id/refresh", async (request) => {
  if (request.params.id === "official") throw Object.assign(new Error("The official store is updated with OpenEasyX"), { statusCode: 409 });
  const repository = await pluginRepositories.refresh(request.params.id); plugins.setRoots(pluginRepositories.roots()); await plugins.load(); return { repository, plugins: plugins.list() };
});
app.delete<{ Params: { id: string } }>("/api/plugin-repositories/:id", async (request) => {
  if (request.params.id === "official") throw Object.assign(new Error("The official store cannot be removed"), { statusCode: 409 });
  const result = pluginRepositories.remove(request.params.id); plugins.setRoots(pluginRepositories.roots()); await plugins.load(); return { ...result, plugins: plugins.list() };
});
app.post<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>("/api/plugins/:id/install", async (request) => {
  plugins.install(request.params.id, request.body ?? {});
  liveCams.resetProviderSession(request.params.id);
  refreshLiveCamFavorites(request.params.id);
  return plugins.list().find((plugin) => plugin.manifest.id === request.params.id);
});
app.delete<{ Params: { id: string } }>("/api/plugins/:id", async (request) => {
  plugins.uninstall(request.params.id);
  await browserLogin.removeProfile(request.params.id);
  return plugins.list().find((plugin) => plugin.manifest.id === request.params.id);
});
app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/plugins/:id/enable", async (request) => {
  // Backwards-compatible endpoint for older clients. Disabling now means
  // uninstalling; enabling performs the same validated install operation.
  if (request.body?.enabled === false) plugins.uninstall(request.params.id); else plugins.install(request.params.id);
  return plugins.list().find((plugin) => plugin.manifest.id === request.params.id);
});
app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/plugins/:id/config", async (request) => {
  plugins.configure(request.params.id, request.body ?? {});
  liveCams.resetProviderSession(request.params.id);
  refreshLiveCamFavorites(request.params.id);
  return plugins.list().find((plugin) => plugin.manifest.id === request.params.id);
});
app.post<{ Params: { id: string } }>("/api/plugins/:id/test", async (request) => {
  const plugin = plugins.get(request.params.id, false);
  if (!db.getPluginState(request.params.id).installed) throw Object.assign(new Error("Install the plugin before testing it"), { statusCode: 409 });
  plugins.ensureConfigured(request.params.id);
  if (!plugin.testConnection) return { ok: true, message: "Ready. This plugin validates each configured source URL when scraping starts." };
  return plugin.testConnection(plugins.context(request.params.id));
});
app.post<{ Params: { id: string } }>("/api/plugins/:id/browser-login/start", async (request) => {
  const plugin = plugins.get(request.params.id, false);
  return browserLogin.start(request.params.id, plugin.manifest);
});
app.get<{ Params: { id: string } }>("/api/plugins/:id/browser-login/status", async (request) => {
  plugins.get(request.params.id, false);
  return browserLogin.status(request.params.id);
});
app.post<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>("/api/plugins/:id/browser-login/capture", async (request) => {
  const plugin = plugins.get(request.params.id, false);
  const browserAuth = plugin.manifest.browserAuth;
  if (!browserAuth) throw Object.assign(new Error(`${plugin.manifest.name} does not support integrated browser login`), { statusCode: 409 });
  const session = await browserLogin.capture(request.params.id, plugin.manifest);
  const incoming = { ...(request.body ?? {}), [browserAuth.sessionSetting]: session };
  let test = { ok: true, message: "Session captured and plugin activated." };
  if (plugin.testConnection) {
    const temporaryRoot = fs.mkdtempSync(path.join(dataDir, ".browser-auth-test-"));
    try {
      const sessionField = plugin.manifest.settings?.find((field) => field.key === browserAuth.sessionSetting);
      const temporarySession = sessionField?.type === "session" ? path.join(temporaryRoot, sessionField.sessionFormat === "raw-json" ? "session.json" : "cookies.txt") : session;
      if (sessionField?.type === "session") fs.writeFileSync(temporarySession, `${session}\n`, { mode: 0o600 });
      test = await plugin.testConnection(plugins.context(request.params.id, undefined, {
        ...db.getPluginState(request.params.id).config, ...incoming, [browserAuth.sessionSetting]: temporarySession,
      }));
    } finally { fs.rmSync(temporaryRoot, { recursive: true, force: true }); }
    if (!test.ok) throw Object.assign(new Error(test.message || `${plugin.manifest.name} rejected the captured session`), { statusCode: 409 });
  }
  const installed = db.getPluginState(request.params.id).installed;
  if (installed) plugins.configure(request.params.id, incoming); else plugins.install(request.params.id, incoming);
  liveCams.resetProviderSession(request.params.id);
  await browserLogin.removeProfile(request.params.id);
  refreshLiveCamFavorites(request.params.id);
  return { plugin: plugins.list().find((entry) => entry.manifest.id === request.params.id), test };
});
app.post<{ Params: { id: string }; Body: { text?: unknown } }>("/api/plugins/:id/browser-login/paste", async (request) => {
  ensureBrowserLoginEnabled();
  plugins.get(request.params.id, false);
  const value = z.string().min(1).max(100_000).parse(request.body?.text);
  return browserLogin.paste(request.params.id, value);
});
app.delete<{ Params: { id: string } }>("/api/plugins/:id/browser-login", async (request) => {
  plugins.get(request.params.id, false);
  if (browserLogin.status(request.params.id).active) await browserLogin.stop();
  return { stopped: true };
});
app.post("/api/plugins/reload", async () => { await plugins.load(); return plugins.list(); });
app.post<{ Params: { id: string }; Body: unknown }>("/api/plugins/:id/library/deletions", async (request) => {
  const plugin = plugins.get(request.params.id);
  if (!plugin.manifest.capabilities.includes("library-hook") || !plugin.acceptLibraryDeletion) {
    throw Object.assign(new Error("This plugin does not accept library deletions"), { statusCode: 409 });
  }
  const deletion = z.object({ relativePath: z.string().trim().min(1).max(4096) }).parse(request.body);
  const accepted = await plugin.acceptLibraryDeletion(plugins.context(request.params.id), deletion);
  const item = db.markStoredItemDeleted(accepted.relativePath);
  if (!item) throw Object.assign(new Error("No completed download matches this library path"), { statusCode: 404 });
  return { deleted: true, itemId: item.id, status: item.status, relativePath: item.storagePath };
});

const liveCamQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(48).default(24),
  providerId: z.preprocess((value) => value === "" ? undefined : value, z.string().trim().min(1).optional()), search: z.string().trim().max(120).optional(),
  gender: z.preprocess((value) => value === "" ? undefined : value, z.enum(["female", "male", "couple", "trans"]).optional()),
  favoritesOnly: z.preprocess((value) => value === "1" || value === "true" || value === true, z.boolean()).default(false),
});
const liveCamBodySchema = z.object({
  providerId: z.string().trim().min(1),
  cam: z.object({
    id: z.string().trim().min(1).max(300), username: z.string().trim().min(1).max(160), title: z.string().max(300).optional(),
    pageUrl: z.string().url().max(4096), thumbnailUrl: z.string().url().max(4096).optional(), profileImageUrl: z.string().url().max(4096).optional(), viewers: z.number().int().min(0).optional(),
    age: z.number().int().min(18).max(120).optional(), gender: z.string().max(40).optional(), tags: z.array(z.string().max(80)).max(50).optional(),
  }),
});

app.get<{ Querystring: Record<string, unknown> }>("/api/live-cams", async (request) => {
  const query = liveCamQuerySchema.parse(request.query);
  return liveCams.list(query);
});
app.get<{ Querystring: Record<string, unknown> }>("/api/live-cams/events", async (request, reply) => {
  const query = liveCamQuerySchema.parse(request.query);
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  reply.raw.write(": connected\n\n");
  const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n"); }, 15_000); heartbeat.unref();
  try {
    for await (const result of liveCams.stream(query, controller.signal)) {
      if (reply.raw.destroyed) break;
      reply.raw.write(`data: ${JSON.stringify(result)}\n\n`);
    }
  } finally {
    clearInterval(heartbeat);
    if (!reply.raw.destroyed) reply.raw.end();
  }
});
app.get("/api/live-cams/favorites", async () => ({ items: liveCams.listFavorites(), synchronization: liveCams.favoriteChanges() }));
app.put<{ Body: unknown }>("/api/live-cams/favorites", async (request) => {
  const body = liveCamBodySchema.extend({ favorite: z.boolean() }).parse(request.body);
  return liveCams.setFavorite(body.providerId, body.cam, body.favorite);
});
app.post<{ Params: { providerId: string } }>("/api/live-cams/favorites/sync/:providerId", async (request) => {
  const providerId = z.string().trim().min(1).max(200).parse(request.params.providerId);
  return liveCams.syncFavorites(providerId);
});
app.patch<{ Body: unknown }>("/api/live-cams/favorites/auto-record", async (request) => {
  const body = z.object({
    providerId: z.string().trim().min(1).max(200),
    username: z.string().trim().min(1).max(300),
    autoRecord: z.boolean(),
  }).parse(request.body);
  const item = liveCams.setFavoriteAutoRecord(body.providerId, body.username, body.autoRecord);
  if (!item) throw Object.assign(new Error("Favorite not found"), { statusCode: 404 });
  if (body.autoRecord) autoRecorder.clearSuppression(body.providerId, body.username);
  app.log.info({ scope: "auto-record", providerId: body.providerId, username: body.username }, body.autoRecord ? "Favorite auto-record enabled" : "Favorite auto-record disabled");
  return item;
});
app.post<{ Body: unknown }>("/api/live-cams/performer", async (request) => {
  const body = liveCamBodySchema.parse(request.body);
  const result = liveCams.createPerformer(body.providerId, body.cam);
  ensurePerformerDirectory(mediaDir, result.performer.name);
  return result;
});
app.get<{ Params: { providerId: string; camId: string } }>("/api/live-cams/:providerId/:camId", async (request) => {
  const params = z.object({
    providerId: z.string().trim().min(1).max(200),
    camId: z.string().trim().min(1).max(300),
  }).parse(request.params);
  return liveCams.get(params.providerId, params.camId);
});
app.post<{ Body: unknown }>("/api/live-cams/stream", async (request) => {
  const body = liveCamBodySchema.parse(request.body);
  return liveCams.resolve(body.providerId, body.cam);
});
app.post<{ Body: unknown }>("/api/live-cams/record", async (request) => {
  const body = liveCamBodySchema.parse(request.body);
  return liveCams.record(body.providerId, body.cam);
});
app.get<{ Params: { tokenPath: string }; Querystring: Record<string, unknown> }>("/api/live-cams/proxy/:tokenPath", async (request, reply) => {
  return liveCams.proxy(request.params.tokenPath, reply, request.query, typeof request.headers.range === "string" ? request.headers.range : undefined);
});

app.get<{ Querystring: { q?: string } }>("/api/discover", async (request) => {
  const query = z.string().trim().min(2).max(120).parse(request.query.q);
  // Two concurrent searches would share one status object: the first to finish clears
  // `running` while the other is still working, and progress figures overwrite each other.
  if (discoveryStatus.running) throw Object.assign(new Error("A discovery search is already running"), { statusCode: 409 });
  Object.assign(discoveryStatus, { running: true, completed: 0, total: 0, progress: 0, query, error: "" });
  try {
    const result = await discoverPeople(plugins, query, (progress) => Object.assign(discoveryStatus, progress));
    discoveryStatus.progress = 100;
    return result;
  } catch (error) {
    discoveryStatus.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    discoveryStatus.running = false;
  }
});
app.get("/api/discover/status", async () => discoveryStatus);

const candidateSchema = z.object({
  externalId: z.string().min(1), name: z.string().trim().min(1).max(160), aliases: z.array(z.string()).optional(),
  imageUrl: z.string().url().optional(), profileUrls: z.array(z.string().url()).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
});
const discoveryMatchSchema = z.object({ pluginId: z.string().min(1), candidate: candidateSchema });
const localPerformerImageUrl = z.string().regex(/^\/api\/media\/[a-f0-9]{24}\/thumbnail$/, "Invalid local performer image");
const storedPerformerImageUrl = z.string().regex(/^\/api\/performers\/person_[a-f0-9]{20}\/image$/, "Invalid stored performer image");
const performerEditorSchema = z.object({
  name: z.string().trim().min(1).max(160), aliases: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  imageUrl: z.union([z.string().url().max(4096), localPerformerImageUrl, storedPerformerImageUrl, z.literal(""), z.null()]).optional(),
});
const manualPluginId = "org.easyx.manual";
const performerImagesDir = path.join(dataDir, "performer-images");

function performerImageFile(performerId: string) {
  return path.join(performerImagesDir, `${performerId}.jpg`);
}

async function resolvePerformerImageUrl(performerId: string, previousName: string, nextName: string, imageUrl?: string | null) {
  const storedUrl = `/api/performers/${performerId}/image`;
  if (imageUrl === storedUrl) return storedUrl;
  const selected = /^\/api\/media\/([a-f0-9]{24})\/thumbnail$/.exec(imageUrl ?? "");
  if (selected) {
    const media = libraryDb.getMedia(selected[1]);
    const performerNames = new Set([previousName, nextName].map((value) => value.toLocaleLowerCase()));
    if (!media || media.kind !== "image" || !performerNames.has(media.performer.toLocaleLowerCase())) {
      throw Object.assign(new Error("The selected image does not belong to this performer"), { statusCode: 400 });
    }
    fs.mkdirSync(performerImagesDir, { recursive: true, mode: 0o700 });
    const target = performerImageFile(performerId); const temporary = `${target}.${process.pid}.tmp`;
    try { fs.copyFileSync(await catalog.thumbnail(media), temporary); fs.renameSync(temporary, target); }
    finally { fs.rmSync(temporary, { force: true }); }
    return storedUrl;
  }
  fs.rmSync(performerImageFile(performerId), { force: true });
  return imageUrl || null;
}

function ensureSourcePlugin(pluginId: string) {
  if (pluginId === manualPluginId) return;
  plugins.get(pluginId, false);
  if (!db.getPluginState(pluginId).installed) throw Object.assign(new Error("Install the selected plugin before associating it"), { statusCode: 409 });
}

function ensureScraperPlugin(pluginId: string, profileUrl?: string) {
  const entry = plugins.list().find((candidate) => candidate.manifest.id === pluginId);
  if (!entry?.installed || !entry.enabled) throw Object.assign(new Error("Install and enable the selected scraper plugin first"), { statusCode: 409 });
  if (!entry.manifest.capabilities.includes("media-listing")) throw Object.assign(new Error(`${entry.manifest.name} cannot scrape media URLs`), { statusCode: 409 });
  if (profileUrl && !pluginMatchesSource(entry.manifest, profileUrl)) throw Object.assign(new Error(`${entry.manifest.name} does not support this URL`), { statusCode: 409 });
  return plugins.get(pluginId);
}

function scraperInterval(pluginId: string): number {
  const manifest = plugins.list().find((candidate) => candidate.manifest.id === pluginId)?.manifest;
  if (manifest?.polling?.mode === "live") return Math.max(manifest.polling.minimumIntervalSeconds, Number(db.getSettings().defaultLiveIntervalSeconds ?? manifest.polling.defaultIntervalSeconds));
  if (manifest?.polling) return manifest.polling.defaultIntervalSeconds;
  return Math.max(300, Number(db.getSettings().defaultScrapeIntervalMinutes ?? 360) * 60);
}

function validateScraperInterval(pluginId: string, intervalSeconds: number): number {
  const manifest = plugins.list().find((candidate) => candidate.manifest.id === pluginId)?.manifest;
  const minimum = manifest?.polling?.minimumIntervalSeconds ?? 300;
  if (intervalSeconds < minimum) throw Object.assign(new Error(`${manifest?.name ?? pluginId} requires an interval of at least ${minimum} seconds`), { statusCode: 409 });
  return intervalSeconds;
}

// Raising a plugin's declared minimum only affects sources created afterwards: an existing source
// keeps whatever cadence it was saved with, so sources created under the old 10s Chaturbate
// schedule would keep spending that provider's shared per-IP budget forever. Clamp once at boot so
// every live provider's floor is honoured by the sources already in the database too.
function enforcePollingFloors(): number {
  const floors = new Map<string, number>();
  for (const entry of plugins.list()) {
    const polling = entry.manifest.polling;
    if (polling?.mode !== "live") continue;
    floors.set(entry.manifest.id, polling.minimumIntervalSeconds);
  }
  if (!floors.size) return 0;
  let raised = 0;
  for (const source of db.listSources()) {
    if (!source.scraperPluginId || !source.scrapeEnabled) continue;
    const floor = floors.get(source.scraperPluginId);
    if (floor === undefined || source.syncIntervalSeconds >= floor) continue;
    db.updateSource(source.id, { syncIntervalSeconds: floor });
    raised += 1;
  }
  return raised;
}

app.post<{ Body: unknown }>("/api/performers/import", async (request) => {
  const body = z.union([
    z.object({ matches: z.array(discoveryMatchSchema).min(1).max(12) }),
    discoveryMatchSchema.transform((match) => ({ matches: [match] })),
  ]).parse(request.body);
  let performer: ReturnType<typeof db.upsertPerformer> | undefined;
  const sources = [];
  const providers: Array<{ pluginId: string; ok: boolean; error?: string }> = [];
  for (const match of body.matches) {
    const plugin = plugins.get(match.pluginId);
    performer = db.upsertPerformer(match.candidate, match.pluginId, performer?.id);
    try {
      const discovered = plugin.discoverSources ? await plugin.discoverSources(plugins.context(match.pluginId), performer) : [];
      for (const source of discovered) sources.push(db.addSource(performer.id, match.pluginId, source));
      providers.push({ pluginId: match.pluginId, ok: true });
    } catch (error) {
      providers.push({ pluginId: match.pluginId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (performer) ensurePerformerDirectory(mediaDir, performer.name);
  return { performer, sources, providers };
});
app.get("/api/performers", async () => db.listPerformers().map(publicPerformer));
app.post<{ Body: unknown }>("/api/performers", async (request) => {
  const body = performerEditorSchema.parse(request.body);
  if (typeof body.imageUrl === "string" && body.imageUrl.startsWith("/api/")) throw Object.assign(new Error("Choose a local image after creating the performer"), { statusCode: 400 });
  if (db.getPerformerByName(body.name)) throw Object.assign(new Error("A performer with this name already exists"), { statusCode: 409 });
  const performer = db.createPerformer({ ...body, imageUrl: body.imageUrl || null });
  ensurePerformerDirectory(mediaDir, performer.name);
  return performer;
});
app.get<{ Params: { id: string } }>("/api/performers/:id/image", async (request, reply) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const file = performerImageFile(performer.id);
  if (!fs.existsSync(file)) return reply.status(404).send({ error: "Performer image not found" });
  return reply.type("image/jpeg").header("cache-control", "private, no-cache").send(fs.createReadStream(file));
});
app.get<{ Params: { id: string } }>("/api/performers/:id", async (request) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  return { performer: publicPerformer(performer), sources: db.listSources(performer.id), items: db.listItemsByPerformer(performer.id) };
});
app.patch<{ Params: { id: string }; Body: unknown }>("/api/performers/:id/auto-record", async (request) => {
  const body = z.object({ autoRecord: z.boolean() }).parse(request.body);
  const result = liveCams.setPerformerAutoRecord(request.params.id, body.autoRecord);
  // Re-enabling the switch is an explicit request to record again, so lift any pause
  // left behind by a manual stop.
  if (body.autoRecord) for (const favorite of result.favorites) autoRecorder.clearSuppression(favorite.providerId, favorite.username);
  app.log.info({ scope: "auto-record", performerId: request.params.id, matched: result.matched }, body.autoRecord ? `Performer auto-record enabled (${result.matched} favorite${result.matched === 1 ? "" : "s"})` : "Performer auto-record disabled");
  return { performer: publicPerformer(result.performer), matched: result.matched };
});
app.patch<{ Params: { id: string }; Body: unknown }>("/api/performers/:id", async (request) => {
  const current = db.getPerformer(request.params.id);
  if (!current) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const body = performerEditorSchema.parse(request.body);
  const sameName = db.getPerformerByName(body.name);
  if (sameName && sameName.id !== current.id) throw Object.assign(new Error("A performer with this name already exists"), { statusCode: 409 });
  const imageUrl = await resolvePerformerImageUrl(current.id, current.name, body.name, body.imageUrl);
  const performer = db.updatePerformer(current.id, { ...body, imageUrl })!;
  renamePerformerDirectory(mediaDir, current.name, performer.name);
  return performer;
});
async function refreshPerformer(performerId: string) {
  let performer = db.getPerformer(performerId);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const providers: Array<{ pluginId: string; ok: boolean; error?: string }> = [];
  const sources = [];
  for (const [pluginId, externalId] of Object.entries(performer.externalRefs)) {
    const entry = plugins.list().find((candidate) => candidate.manifest.id === pluginId);
    if (!entry?.installed || !entry.enabled) continue;
    try {
      const plugin = plugins.get(pluginId);
      if (plugin.searchPeople) {
        const candidates = await plugin.searchPeople(plugins.context(pluginId), externalId);
        const candidate = candidates.find((item) => item.externalId === externalId) ?? candidates[0];
        if (candidate) {
          const previousName = performer.name;
          performer = db.updatePerformer(performer.id, {
            name: candidate.name,
            aliases: [...new Set([...performer.aliases, ...(candidate.aliases ?? [])])],
            imageUrl: candidate.imageUrl ?? performer.imageUrl ?? null,
          })!;
          renamePerformerDirectory(mediaDir, previousName, performer.name);
        }
      }
      if (plugin.discoverSources) {
        for (const source of await plugin.discoverSources(plugins.context(pluginId), performer)) sources.push(db.addSource(performer.id, pluginId, source));
      }
      providers.push({ pluginId, ok: true });
    } catch (error) {
      providers.push({ pluginId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  ensurePerformerDirectory(mediaDir, performer.name);
  return { performer, sources, providers };
}

app.get("/api/performers/refresh/status", async () => performerRefreshStatus);
app.post("/api/performers/refresh", async () => {
  if (performerRefreshStatus.running) throw Object.assign(new Error("Performer refresh is already running"), { statusCode: 409 });
  const performers = db.listPerformers();
  Object.assign(performerRefreshStatus, { running: true, completed: 0, total: performers.length, progress: 0, error: "" });
  const results = [];
  try {
    for (const performer of performers) {
      results.push(await refreshPerformer(performer.id));
      performerRefreshStatus.completed += 1;
      performerRefreshStatus.progress = performers.length ? Math.round(performerRefreshStatus.completed / performers.length * 100) : 100;
    }
    performerRefreshStatus.progress = 100;
    return { refreshed: results.length, results };
  } catch (error) {
    performerRefreshStatus.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    performerRefreshStatus.running = false;
  }
});
app.post<{ Params: { id: string } }>("/api/performers/:id/refresh", async (request) => {
  return refreshPerformer(request.params.id);
});
app.post<{ Params: { id: string } }>("/api/performers/:id/discover-sources", async (request) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const added = [];
  for (const entry of plugins.list().filter((item) => item.installed && item.enabled && item.manifest.capabilities.includes("source-discovery"))) {
    const plugin = plugins.get(entry.manifest.id);
    if (!plugin.discoverSources) continue;
    for (const source of await plugin.discoverSources(plugins.context(entry.manifest.id), performer)) added.push(db.addSource(performer.id, entry.manifest.id, source));
  }
  return { sources: added };
});
app.post<{ Params: { id: string }; Body: unknown }>("/api/performers/:id/sources", async (request) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const body = z.object({
    profileUrl: z.string().url(), pluginId: z.string().min(1).default(manualPluginId), label: z.string().trim().max(160).optional(),
    scraperPluginId: z.string().min(1).optional(), scrapeEnabled: z.boolean().optional(), enabled: z.boolean().optional(), autoDownload: z.boolean().optional(),
  }).parse(request.body);
  ensureSourcePlugin(body.pluginId);
  if (body.scraperPluginId) ensureScraperPlugin(body.scraperPluginId, body.profileUrl);
  if (body.scrapeEnabled && !body.scraperPluginId) throw Object.assign(new Error("Select a scraper plugin before enabling scraping"), { statusCode: 409 });
  const domain = domainFromUrl(body.profileUrl);
  const source = db.addSource(performer.id, body.pluginId, { externalId: body.profileUrl, profileUrl: body.profileUrl, domain, label: body.label || domain });
  return db.updateSource(source.id, { scraperPluginId: body.scraperPluginId, scrapeEnabled: body.scrapeEnabled, enabled: body.enabled, autoDownload: body.autoDownload, ...(body.scraperPluginId ? { syncIntervalSeconds: scraperInterval(body.scraperPluginId) } : {}) });
});
app.delete<{ Params: { id: string }; Body: unknown }>("/api/performers/:id", async (request) => {
  const performer = db.getPerformer(request.params.id);
  if (!performer) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
  const body = z.object({ deleteFiles: z.boolean().default(true) }).parse(request.body ?? {});
  const items = db.listItemsByPerformer(performer.id);
  if (items.some((item) => ACTIVE_ITEM_STATUSES.includes(item.status))) {
    throw Object.assign(new Error("Wait for active downloads to finish before deleting this performer"), { statusCode: 409 });
  }
  const otherPerformerDirs = db.listPerformers().filter((p) => p.id !== performer.id).map((p) => performerDirectory(mediaDir, p.name));
  const deletedFiles = body.deleteFiles ? deletePerformerFiles(mediaDir, performer, items, otherPerformerDirs) : 0;
  const deleted = db.deletePerformer(performer.id);
  fs.rmSync(performerImageFile(performer.id), { force: true });
  return { deleted, deletedFiles, filesKept: !body.deleteFiles };
});

app.patch<{ Params: { id: string }; Body: unknown }>("/api/sources/:id", async (request) => {
  const body = z.object({
    scraperPluginId: z.union([z.string().min(1), z.null()]).optional(), scrapeEnabled: z.boolean().optional(),
    pluginId: z.string().min(1).optional(), label: z.string().trim().min(1).max(160).optional(), profileUrl: z.string().url().optional(), enabled: z.boolean().optional(),
    autoDownload: z.boolean().optional(), syncIntervalSeconds: z.number().int().min(5).max(31_536_000).optional(), syncIntervalMinutes: z.number().int().min(1).max(525600).optional(),
  }).parse(request.body);
  const current = db.getSource(request.params.id);
  if (!current) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
  if (body.pluginId) ensureSourcePlugin(body.pluginId);
  const scraperPluginId = body.scraperPluginId === undefined ? current.scraperPluginId : body.scraperPluginId ?? undefined;
  const profileUrl = body.profileUrl ?? current.profileUrl;
  if (scraperPluginId) ensureScraperPlugin(scraperPluginId, profileUrl);
  if (body.scrapeEnabled && !scraperPluginId) throw Object.assign(new Error("Select a scraper plugin before enabling scraping"), { statusCode: 409 });
  const requestedInterval = body.syncIntervalSeconds ?? (body.syncIntervalMinutes === undefined ? undefined : body.syncIntervalMinutes * 60);
  const syncIntervalSeconds = scraperPluginId
    ? validateScraperInterval(scraperPluginId, requestedInterval ?? (body.scraperPluginId && body.scraperPluginId !== current.scraperPluginId ? scraperInterval(scraperPluginId) : current.syncIntervalSeconds))
    : current.syncIntervalSeconds;
  const { syncIntervalMinutes: _legacyInterval, ...patch } = body;
  const values = { ...patch, syncIntervalSeconds, ...(body.scraperPluginId === null ? { scraperPluginId: null, scrapeEnabled: false } : {}), ...(body.profileUrl ? { domain: domainFromUrl(body.profileUrl) } : {}) };
  const source = db.updateSource(request.params.id, values);
  const shouldRunSoon = body.scraperPluginId !== undefined && body.scraperPluginId !== current.scraperPluginId
    || body.scrapeEnabled === true && !current.scrapeEnabled
    || requestedInterval !== undefined && requestedInterval !== current.syncIntervalSeconds;
  return shouldRunSoon ? db.resetSourceSchedule(request.params.id) : source;
});
app.delete<{ Params: { id: string } }>("/api/sources/:id", async (request) => {
  const source = db.getSource(request.params.id);
  if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
  const active = db.listItemsBySource(source.id).some((item) => ACTIVE_ITEM_STATUSES.includes(item.status));
  if (active) throw Object.assign(new Error("Wait for active downloads to finish before deleting this URL"), { statusCode: 409 });
  const deleted = db.deleteSource(source.id);
  return { deleted };
});

async function syncSource(sourceId: string) {
  const source = db.getSource(sourceId);
  if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
  if (!source.scraperPluginId) throw Object.assign(new Error("Select a scraper plugin for this URL first"), { statusCode: 409 });
  const plugin = ensureScraperPlugin(source.scraperPluginId, source.profileUrl);
  if (!plugin.listMedia) throw Object.assign(new Error("This source is informational; its plugin does not list media"), { statusCode: 409 });
  try {
    const found = await plugin.listMedia(plugins.context(source.scraperPluginId), source);
    // A live stream is not a stored file, and queueing it would open a capture of a room that
    // may already be recording. Live capture belongs to the recorder, so it is reported, not
    // ingested.
    const candidates = found.filter((candidate) => !isLiveCandidate(candidate));
    const liveSkipped = found.length - candidates.length;
    const storedDateChanges: string[] = [];
    const result = db.ingestItems(source, candidates, (itemId) => storedDateChanges.push(itemId));
    await queue.applyStoredMediaDates(storedDateChanges);
    db.markSourceSynced(source.id, source.syncIntervalSeconds);
    if (liveSkipped) app.log.info({ scope: "scrape", sourceId: source.id, domain: source.domain, liveSkipped }, "Room is live; the broadcast is left to the live-cam recorder");
    return { ...result, total: candidates.length, liveSkipped };
  } catch (error) {
    db.markSourceSynced(source.id, source.syncIntervalSeconds, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

app.post<{ Params: { id: string } }>("/api/sources/:id/sync", async (request) => syncSource(request.params.id));
app.get<{ Querystring: Record<string, string | undefined> }>("/api/items", async (request) => {
  const query = z.object({
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
    category: z.enum(["active", "ready", "downloaded", "errors", "other"]).optional(),
    status: z.string().trim().min(1).optional(), mediaType: z.string().trim().min(1).optional(),
    sourceId: z.string().trim().min(1).optional(), sourceDomain: z.string().trim().min(1).optional(), performerId: z.string().trim().min(1).optional(),
    search: z.string().trim().max(200).optional(),
  }).parse(request.query);
  const result = db.listItemsPage(query);
  return { ...result, items: result.items.map((item) => ({ ...item, outputPath: queue.outputPath(item.id) })) };
});
app.post("/api/items/retry-failed", async () => ({ queued: db.retryFailedItems() }));
// Background jobs (Library merge, Recovery sweep). The Activity page polls these beside the
// download rows, so long work never has to be held open inside a request.
app.get("/api/tasks", async () => ({ tasks: tasks.list() }));
app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request) => {
  const task = tasks.get(request.params.id);
  if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
  return { task };
});
app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request) => {
  const task = tasks.cancel(request.params.id);
  if (!task) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
  return { task };
});
app.post<{ Params: { id: string } }>("/api/items/:id/queue", async (request) => {
  const item = db.getItem(request.params.id);
  if (!item) throw Object.assign(new Error("Item not found"), { statusCode: 404 });
  if (!["available", "failed"].includes(item.status)) throw Object.assign(new Error(`Cannot queue an item with status '${item.status}'`), { statusCode: 409 });
  return db.setItemStatus(item.id, "queued", { progress: 0 });
});
app.post<{ Params: { id: string } }>("/api/items/:id/pause", async (request) => queue.pause(request.params.id));
app.post<{ Params: { id: string } }>("/api/items/:id/resume", async (request) => queue.resume(request.params.id));
app.post<{ Params: { id: string } }>("/api/items/:id/stop", async (request) => {
  pauseAutoRecordForItem(request.params.id);
  return queue.stopRecording(request.params.id);
});
app.post<{ Params: { id: string } }>("/api/items/:id/cancel", async (request) => {
  pauseAutoRecordForItem(request.params.id);
  return queue.cancel(request.params.id);
});
app.delete<{ Params: { id: string } }>("/api/items/:id", async (request) => queue.delete(request.params.id));

// Merge several library videos into one file. The work runs as a background job (see
// server/media-merge.ts) so the request returns immediately; progress shows up on the Activity page
// beside the recordings. Everything that can be checked without ffprobe still answers as a 400 here.
app.post<{ Body: { ids?: unknown; removeSources?: unknown } }>("/api/media/merge", async (request) => {
  const body = z.object({
    ids: z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(2).max(100),
    removeSources: z.boolean().optional(),
  }).parse(request.body);
  return startMerge({
    mediaRoot: mediaDir,
    library: libraryDb,
    scan: () => catalog.scan(),
    tasks,
    concat: (listPath, output, totalSeconds, totalBytes, onProgress, signal) =>
      queue.mergeMediaFiles(listPath, output, totalSeconds, totalBytes, onProgress, signal),
    removeSource: (media) => { const result = catalog.deleteMedia(media); db.markStoredItemDeleted(media.relativePath); return result; },
    minFreeDiskGb: Number(db.getSettings().minFreeDiskGb),
    log: (message, fields) => app.log.info({ scope: "media-merge", ...fields }, message),
  }, { ids: body.ids, removeSources: body.removeSources });
});

// Residual TS recovery (Recovery page under COLLECT). A dry run still answers synchronously because
// it writes nothing; the real sweep runs as a background job whose progress the Activity page
// renders, so the request no longer stays open for minutes on a 1-core box.
app.post("/api/maintenance/cleanup-residual-ts", async (request) => {
  const body = (request.body ?? {}) as { dryRun?: boolean; execute?: boolean };
  if (body.execute !== true) return queue.recoverResidualTs({ dryRun: body.dryRun });
  return queue.startRecovery(tasks, { execute: true });
});
app.get("/api/recovery", async () => queue.listRecovered());
app.post<{ Params: { id: string } }>("/api/recovery/:id/catalog", async (request) => queue.catalogRecovered(request.params.id));
app.delete<{ Body: { itemIds?: unknown } }>("/api/recovery", async (request) => {
  const ids = (request.body ?? {}).itemIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== "string")) {
    throw Object.assign(new Error("itemIds must contain between 1 and 100 media IDs"), { statusCode: 400 });
  }
  return queue.deleteRecovered(ids as string[]);
});
app.get<{ Params: { id: string } }>("/api/recovery/:id/stream", async (request, reply) => {
  const file = queue.recoveredStreamPath(request.params.id);
  if (!file) return reply.status(404).send({ error: "Recovered file not found" });
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return reply.status(404).send({ error: "Recovered file not found" }); }
  const range = request.headers.range;
  reply.header("accept-ranges", "bytes").header("content-type", "video/mp4").header("cache-control", "private, max-age=3600");
  if (!range) return reply.header("content-length", stat.size).send(fs.createReadStream(file));
  const parsed = parseMediaRange(range, stat.size);
  if (!parsed) return reply.status(416).header("content-range", `bytes */${stat.size}`).send();
  const { start, end } = parsed;
  return reply.status(206).header("content-range", `bytes ${start}-${end}/${stat.size}`).header("content-length", end - start + 1).send(fs.createReadStream(file, { start, end }));
});
app.get<{ Params: { id: string } }>("/api/recovery/:id/thumbnail", async (request, reply) => {
  const poster = queue.recoveredPosterPath(request.params.id) ?? (await queue.ensureRecoveredPoster(request.params.id));
  if (poster && fs.existsSync(poster)) return reply.type("image/jpeg").header("cache-control", "public, max-age=31536000, immutable").send(fs.createReadStream(poster));
  const placeholder = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
  return reply.type("image/png").header("cache-control", "no-store").send(placeholder);
});

app.get("/api/settings", async () => {
  // Never expose the admin password hash to the client.
  const { admin_password_hash: _omitted, ...settings } = db.getSettings();
  return { ...settings, mediaRoot: mediaDir, ...library.settings() };
});
app.put<{ Body: Record<string, unknown> }>("/api/settings", async (request) => {
  const parsed = settingsSchema.safeParse(request.body);
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues.map((issue) => issue.message).join(" ")), { statusCode: 400 });
  const settings = parsed.data;
  // Never echo the admin password hash back to the client.
  const { admin_password_hash: _omitted, ...result } = db.updateSettings(settings);
  return result;
});

const scheduledInFlight = new Set<string>();
setInterval(() => {
  for (const source of db.dueSources()) {
    if (scheduledInFlight.size >= 4) break;
    if (scheduledInFlight.has(source.id)) continue;
    const owner = plugins.list().find((entry) => entry.manifest.id === source.scraperPluginId);
    if (!owner?.installed || !owner.enabled || !owner.manifest.capabilities.includes("media-listing")) continue;
    scheduledInFlight.add(source.id);
    void syncSource(source.id).catch((error) => app.log.warn({ error, sourceId: source.id }, "Scheduled source sync failed")).finally(() => scheduledInFlight.delete(source.id));
  }
}, 1000).unref();

// C1 retention pass, hourly. With the default dry-run it only logs what has outlived the
// configured retention window; EASYX_RETENTION_DRY_RUN=false turns it into real deletions.
const retentionDryRun = process.env.EASYX_RETENTION_DRY_RUN !== "false";
const runRetention = () => {
  try {
    const report = retentionPlan({ db, mediaRoot: mediaDir, dryRun: retentionDryRun });
    if (report.retentionDays < 1) return;
    for (const candidate of report.candidates) {
      app.log.info({ itemId: candidate.itemId, path: candidate.relativePath, ageDays: candidate.ageDays, bytes: candidate.bytes },
        `retention ${report.dryRun ? "dry-run would delete" : "deleting"} ${candidate.relativePath} (${report.retentionDays}d limit)`);
    }
    for (const entry of report.skipped) app.log.warn({ itemId: entry.itemId, path: entry.relativePath, reason: entry.reason }, "retention skipped an entry");
    for (const entry of report.failed) app.log.error({ path: entry.candidate.relativePath, error: entry.error }, "retention failed to delete a file");
    if (report.deleted.length) void catalog.scan().catch((error) => app.log.error(error, "Library scan after retention cleanup failed"));
  } catch (error) {
    app.log.error(error, "Retention pass failed");
  }
};
const retentionTimer = setInterval(runRetention, 60 * 60_000); retentionTimer.unref();
setTimeout(runRetention, 60_000).unref();

// A broadcast that flaps -- the upstream playlist disappears for a minute, ffmpeg exits, the
// watcher opens a fresh capture once its cooldown lapses -- arrives as one library entry per
// capture, so a single five-hour show reads as eight separate short recordings. Once a room has
// gone quiet long enough that the show is over, its finished captures are spliced back into one
// file (see live-sessions.ts). EASYX_LIVE_SESSION_SPLICE=false turns the pass off.
const liveSessionSpliceEnabled = process.env.EASYX_LIVE_SESSION_SPLICE !== "false";
// A group can stay unfolded for many passes (not enough free space, a capture that cannot be
// measured), so the reason is logged when it changes instead of on every pass.
const sessionSkipReasons = new Map<string, string>();
const runLiveSessionSplice = async () => {
  if (!liveSessionSpliceEnabled) return;
  try {
    const report = await spliceLiveSessions({
      db, mediaRoot: mediaDir,
      concat: (listPath, output) => queue.concatFinishedFiles(listPath, output),
      log: (message, fields) => app.log.info({ scope: "live-session", ...(fields ?? {}) }, message),
    });
    for (const entry of report.skipped) {
      if (sessionSkipReasons.get(entry.roomKey) === entry.reason) continue;
      sessionSkipReasons.set(entry.roomKey, entry.reason);
      app.log.info({ scope: "live-session", ...entry }, "Live session left unfolded");
    }
    for (const entry of report.failed) app.log.warn({ scope: "live-session", ...entry }, "Live session splice failed");
    // The splice replaced one path and removed the rest, so the library has to re-measure the
    // survivor and drop the rows whose files are gone.
    if (report.spliced) await catalog.scan();
  } catch (error) {
    app.log.error(error, "Live session splice pass failed");
  }
};
const liveSessionTimer = setInterval(() => void runLiveSessionSplice(), 10 * 60_000); liveSessionTimer.unref();
setTimeout(() => void runLiveSessionSplice(), 2 * 60_000).unref();

// P2: both SQLite files run in WAL mode, and a long-lived reader (an open SSE stream or a library
// scan) stops SQLite from checkpointing on its own - which is why a 139KB database sat next to a
// 4MB -wal sidecar. Truncate hourly so the sidecars stay bounded.
const runCheckpoint = () => {
  const results = [["easyx.sqlite", db.checkpoint()], ["open-easyx-library.sqlite", libraryDb.checkpoint()]] as const;
  for (const [name, result] of results) if (result?.busy) app.log.info({ database: name, ...result }, "SQLite WAL checkpoint deferred; the database stayed busy");
};
const checkpointTimer = setInterval(runCheckpoint, 60 * 60_000); checkpointTimer.unref();
// Also run shortly after boot: a container that is redeployed more often than hourly would
// otherwise never checkpoint, which is how a 139KB database kept a 4MB -wal sidecar around.
setTimeout(runCheckpoint, 5 * 60_000).unref();

const webRoot = path.resolve("dist/web");
if (fs.existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.status(404).send({ error: "Not found" }) : reply.sendFile("index.html"));
}

let subtitleWorker: ChildProcess | undefined;
let subtitleWorkerRestart: NodeJS.Timeout | undefined;
let subtitleWorkerFailures = 0;
// A crash loop (e.g. torch import failing under a tight cgroup) must not spin forever:
// back off 5s -> 10s -> 20s -> ... -> 60s, then give up after a bounded number of tries.
const SUBTITLE_WORKER_MAX_BACKOFF = 60_000;
const SUBTITLE_WORKER_MAX_FAILURES = 8;
const SUBTITLE_WORKER_STABLE_MS = 60_000;
let shuttingDown = false;
function scheduleSubtitleWorkerRestart(code: number | null, signal: NodeJS.Signals | null) {
  if (shuttingDown) return;
  subtitleWorkerFailures++;
  if (subtitleWorkerFailures >= SUBTITLE_WORKER_MAX_FAILURES) {
    app.log.error({ code, signal, failures: subtitleWorkerFailures }, "Embedded subtitle worker gave up after repeated failures; not restarting");
    return;
  }
  const backoff = Math.min(SUBTITLE_WORKER_MAX_BACKOFF, 5_000 * 2 ** (subtitleWorkerFailures - 1));
  app.log.warn({ code, signal, failures: subtitleWorkerFailures, backoffMs: backoff }, "Embedded subtitle worker stopped; restarting with backoff");
  subtitleWorkerRestart = setTimeout(startEmbeddedSubtitleWorker, backoff);
}
function startEmbeddedSubtitleWorker() {
  if (process.env.EASYX_EMBEDDED_SUBTITLE_WORKER !== "true" || shuttingDown) return;
  const startedAt = Date.now();
  subtitleWorker = spawn(process.env.EASYX_SUBTITLE_PYTHON || "/opt/subtitles/bin/python", ["-m", "worker.subtitles"], { cwd: path.resolve("."), env: process.env, stdio: ["ignore", "inherit", "inherit"] });
  subtitleWorker.on("error", (error) => app.log.error(error, "Embedded subtitle worker could not start"));
  subtitleWorker.on("close", (code, signal) => {
    subtitleWorker = undefined;
    if (shuttingDown) return;
    // A worker that ran for a while before exiting is not a crash loop; reset the counter.
    if (Date.now() - startedAt > SUBTITLE_WORKER_STABLE_MS) subtitleWorkerFailures = 0;
    scheduleSubtitleWorkerRestart(code, signal);
  });
}

const shutdown = async () => {
  shuttingDown = true; await queue.stop(); systemStats.stop(); autoRecorder.stop(); clearInterval(retentionTimer); clearInterval(checkpointTimer); clearInterval(liveSessionTimer); if (subtitleWorkerRestart) clearTimeout(subtitleWorkerRestart); subtitleWorker?.kill("SIGTERM");
  await browserLogin.stop(); await app.close(); libraryDb.close(); db.close(); process.exit(0);
};
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
await app.listen({ port, host: "0.0.0.0" });
startEmbeddedSubtitleWorker();
setTimeout(() => refreshLiveCamFavorites(), 500).unref();
setInterval(() => refreshLiveCamFavorites(), 5 * 60_000).unref();
setTimeout(() => void catalog.scan().catch((error) => app.log.error(error, "Initial library scan failed")), 250).unref();
setInterval(() => void catalog.scan().catch((error) => app.log.error(error, "Scheduled library scan failed")), scanIntervalMinutes * 60_000).unref();
