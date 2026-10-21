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
 * The /browser path is deliberately *not* exempt, and the rule stays even though the noVNC proxy
 * it gated has been removed: it sits outside /api/, so without this line any future path under it
 * would be treated as a public static asset and answer unauthenticated.
 */
export function isSessionExempt(path: string): boolean {
  if (PUBLIC_ENDPOINTS.has(path)) return true;
  if (isLiveProxyPath(path)) return true;
  if (path === "/browser" || path.startsWith("/browser/")) return false;
  return !path.startsWith("/api/");
}

export type SessionGateOptions = {
  verifySession: (cookie: string | undefined) => boolean;
  readSessionCookie: (request: FastifyRequest) => string | undefined;
};

/**
 * The global authentication gate. Registered before any route so it wraps every endpoint,
 * including those plugins add later, and the static UI.
 */
export function createSessionGate(options: SessionGateOptions) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (isSessionExempt(path)) return done();
    // Send and stop: the reply is already on its way, so the hook must not continue.
    if (!options.verifySession(options.readSessionCookie(request))) { void reply.status(401).send({ error: "unauthorized" }); return; }
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
