import type { FastifyReply, FastifyRequest } from "fastify";
import { isLiveProxyPath } from "./hls-proxy.js";

/** Endpoints that carry no data and must answer before a session exists. */
const PUBLIC_ENDPOINTS = new Set(["/api/auth/login", "/api/auth/me", "/api/health", "/api/version"]);

/**
 * Paths that answer without a session.
 *
 * Two exemptions exist for reasons, and everything else has to authenticate:
 *
 *  * The live-stream proxy is fetched by ffmpeg inside this process, which has no cookie. It is
 *    addressed by a 192-bit capability token instead (see `HlsProxy`), so the token is the
 *    credential.
 *  * Static assets are what renders the login screen in the first place.
 *
 * The /browser path is deliberately *not* exempt. The noVNC proxy behind it is only registered
 * when browser login is enabled (see server/index.ts), but the rule holds regardless: /browser
 * sits outside /api/, so without this line a future path under it would be treated as a public
 * static asset and answer unauthenticated.
 *
 * One request-shaped exemption lives in the hook rather than here, because it needs the query
 * string: a stream URL carrying a valid media-link token (see media-links.ts) is its own
 * credential, scoped to that single media id.
 */
/**
 * The path the router will actually match.
 *
 * The gate and the router have to agree on what a request is asking for, or a request reaches a
 * handler the gate never judged: the router decodes percent-encoding, while `URL.pathname` does
 * not. Judging the raw pathname let an encoded first segment slip past the exemption and the
 * session check alike -- `/%61pi/settings` is `/api/settings` to the router, and it answered the
 * real settings API, reads and writes, to anyone. Decoding here closes that class of bypass; the
 * `.`/`..` resolution the URL parser does on top keeps a path from hiding behind them.
 */
export function routedPath(path: string): string {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* malformed encoding stays encoded, which only asks for a session */ }
  try { return new URL(decoded, "http://localhost").pathname; } catch { return decoded; }
}

export function isSessionExempt(path: string): boolean {
  const routed = routedPath(path);
  if (PUBLIC_ENDPOINTS.has(routed)) return true;
  if (isLiveProxyPath(routed)) return true;
  if (routed === "/browser" || routed.startsWith("/browser/")) return false;
  return !routed.startsWith("/api/");
}

export type SessionGateOptions = {
  verifySession: (cookie: string | undefined) => boolean;
  readSessionCookie: (request: FastifyRequest) => string | undefined;
  /**
   * A stream URL carrying a valid media-link token answers without a session: the token is the
   * credential, scoped to that one media id (see media-links.ts). Everything else authenticates.
   */
  verifyMediaLink?: (request: FastifyRequest) => boolean;
};

/**
 * The global authentication gate. Registered before any route so it wraps every endpoint,
 * including those plugins add later, and the static UI.
 */
export function createSessionGate(options: SessionGateOptions) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    const path = routedPath(new URL(request.url, "http://localhost").pathname);
    if (isSessionExempt(path)) return done();
    // Send and stop: the reply is already on its way, so the hook must not continue.
    if (!options.verifySession(options.readSessionCookie(request))) {
      // A token-bearing stream URL is its own credential, so it answers without a session.
      if (options.verifyMediaLink?.(request)) return done();
      void reply.status(401).send({ error: "unauthorized" }); return;
    }
    // CSRF protection for state-changing requests: the cookie is SameSite=Lax and a custom header
    // that browsers cannot attach on cross-site requests is required. Only the API mutates state;
    // the browser proxy is a GET + websocket viewer.
    if (path.startsWith("/api/") && request.method !== "GET" && request.method !== "OPTIONS" && request.headers["x-requested-with"] !== "EasyX") {
      void reply.status(403).send({ error: "csrf" });
      return;
    }
    done();
  };
}
