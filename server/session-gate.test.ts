import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionGate, isSessionExempt } from "./session-gate.js";

/** A bare app with the real gate in front of a few stand-in routes. */
async function appWithGate() {
  const app = Fastify();
  app.addHook("onRequest", createSessionGate({
    verifySession: (cookie) => cookie === "valid",
    readSessionCookie: (request) => (request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("oe="))?.slice(3),
  }));
  for (const route of ["/", "/browser/vnc.html", "/api/items", "/api/health", "/api/live-cams/proxy/abc.ts"]) {
    app.get(route, async () => ({ ok: true }));
  }
  app.post("/api/items", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("session gate over real requests", () => {
  it("refuses the browser proxy without a session and serves it with one", async () => {
    const app = await appWithGate();
    const anonymous = await app.inject({ method: "GET", url: "/browser/vnc.html" });
    expect(anonymous.statusCode).toBe(401);
    const session = await app.inject({ method: "GET", url: "/browser/vnc.html", headers: { cookie: "oe=valid" } });
    expect(session.statusCode).toBe(200);
    await app.close();
  });

  it("still serves the shell and the health probe anonymously", async () => {
    const app = await appWithGate();
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/live-cams/proxy/abc.ts" })).statusCode).toBe(200);
    await app.close();
  });

  it("refuses the API without a session", async () => {
    const app = await appWithGate();
    expect((await app.inject({ method: "GET", url: "/api/items" })).statusCode).toBe(401);
    await app.close();
  });

  it("requires the csrf header only for writes under the API", async () => {
    const app = await appWithGate();
    const withoutHeader = await app.inject({ method: "POST", url: "/api/items", headers: { cookie: "oe=valid" } });
    expect(withoutHeader.statusCode).toBe(403);
    const withHeader = await app.inject({ method: "POST", url: "/api/items", headers: { cookie: "oe=valid", "x-requested-with": "EasyX" } });
    expect(withHeader.statusCode).toBe(200);
    await app.close();
  });
});

describe("session gate", () => {
  it("lets the login screen and its own session check through", () => {
    for (const path of ["/api/auth/login", "/api/auth/me", "/api/health", "/api/version"]) {
      expect(isSessionExempt(path), path).toBe(true);
    }
  });

  it("keeps the live proxy on its capability token, because ffmpeg has no cookie", () => {
    expect(isSessionExempt("/api/live-cams/proxy/abcdef.1.ts")).toBe(true);
    // The prefix itself is not a route; only a tokenised URL under it is exempt.
    expect(isSessionExempt("/api/live-cams/proxy")).toBe(false);
  });

  it("serves static assets so the shell can render the login form", () => {
    for (const path of ["/", "/assets/index-abc.js", "/favicon.ico"]) {
      expect(isSessionExempt(path), path).toBe(true);
    }
  });

  it("requires a session for the browser proxy", () => {
    // It sits outside /api/, which used to be enough to skip authentication entirely while a VNC
    // session was running. It is a same-origin iframe, so the cookie is available.
    for (const path of ["/browser", "/browser/", "/browser/vnc.html"]) {
      expect(isSessionExempt(path), path).toBe(false);
    }
  });

  it("requires a session for everything else under the API", () => {
    for (const path of ["/api/items", "/api/media/x", "/api/settings", "/api/plugins/stripchat/browser-login/start"]) {
      expect(isSessionExempt(path), path).toBe(false);
    }
  });
});
