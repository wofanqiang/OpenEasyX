import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { manyVidsSessionFromBrowser, netscapeSessionFromBrowser, onlyFansSessionFromBrowser, removeStaleBrowserArtifacts, browserLoginEnabled } from "./browser-login.js";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe("integrated browser runtime cleanup", () => {
  it("removes stale Chromium and X11 locks without deleting profile data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-browser-locks-")); temporaryDirectories.push(root);
    const profile = path.join(root, "profile"); const x11 = path.join(root, ".X11-unix");
    fs.mkdirSync(profile); fs.mkdirSync(x11);
    fs.writeFileSync(path.join(profile, "Preferences"), "keep");
    fs.writeFileSync(path.join(profile, "SingletonCookie"), "stale");
    fs.symlinkSync("old-container-123", path.join(profile, "SingletonLock"));
    fs.writeFileSync(path.join(root, ".X99-lock"), "123"); fs.writeFileSync(path.join(x11, "X99"), "stale");

    removeStaleBrowserArtifacts(profile, root);

    expect(fs.existsSync(path.join(profile, "Preferences"))).toBe(true);
    expect(["SingletonCookie", "SingletonLock", "SingletonSocket"].some((name) => fs.existsSync(path.join(profile, name)))).toBe(false);
    expect(fs.existsSync(path.join(root, ".X99-lock"))).toBe(false);
    expect(fs.existsSync(path.join(x11, "X99"))).toBe(false);
  });
});

describe("integrated OnlyFans browser session capture", () => {
  it("builds the OF-Scraper session from OnlyFans cookies and browser values", () => {
    const session = JSON.parse(onlyFansSessionFromBrowser([
      { name: "auth_id", value: "123", domain: ".onlyfans.com" },
      { name: "sess", value: "session-value", domain: "onlyfans.com" },
      { name: "auth_uid_123", value: "456", domain: "api.onlyfans.com" },
      { name: "auth_id", value: "attacker", domain: "evilonlyfans.com" },
    ], { xBc: "browser-token", userAgent: "EasyX test browser" }));
    expect(session).toEqual({
      sess: "session-value", auth_id: "123", auth_uid: "456", user_agent: "EasyX test browser", "x-bc": "browser-token",
    });
  });

  it("rejects incomplete or lookalike-domain sessions", () => {
    expect(() => onlyFansSessionFromBrowser([
      { name: "auth_id", value: "123", domain: "evilonlyfans.com" },
      { name: "sess", value: "session", domain: "evilonlyfans.com" },
    ], { xBc: "token", userAgent: "Browser" })).toThrow("auth_id, sess");
    expect(() => onlyFansSessionFromBrowser([
      { name: "auth_id", value: "123", domain: "onlyfans.com" },
      { name: "sess", value: "session", domain: "onlyfans.com" },
    ], { userAgent: "Browser" })).toThrow("x-bc");
  });
});

describe("integrated browser login feature gate", () => {
  const previous = process.env.EASYX_ENABLE_BROWSER_LOGIN;
  afterEach(() => {
    if (previous === undefined) delete process.env.EASYX_ENABLE_BROWSER_LOGIN;
    else process.env.EASYX_ENABLE_BROWSER_LOGIN = previous;
  });

  it("stays off unless the environment asks for it by name", () => {
    delete process.env.EASYX_ENABLE_BROWSER_LOGIN;
    expect(browserLoginEnabled()).toBe(false);
    process.env.EASYX_ENABLE_BROWSER_LOGIN = "false";
    expect(browserLoginEnabled()).toBe(false);
    process.env.EASYX_ENABLE_BROWSER_LOGIN = "1";
    expect(browserLoginEnabled()).toBe(false);
    process.env.EASYX_ENABLE_BROWSER_LOGIN = "true";
    expect(browserLoginEnabled()).toBe(true);
  });
});

describe("integrated ManyVids browser session capture", () => {
  it("exports only official ManyVids cookies in Netscape format", () => {
    const session = manyVidsSessionFromBrowser([
      { name: "mv_session", value: "account-session", domain: ".manyvids.com", path: "/", secure: true, expires: 2_000_000_000 },
      { name: "api_session", value: "api-session", domain: "api.manyvids.com", path: "/bff", secure: true },
      { name: "attacker", value: "ignored", domain: "manyvids.com.evil.test", path: "/" },
    ], { href: "https://www.manyvids.com/" });
    expect(session).toContain(".manyvids.com\tTRUE\t/\tTRUE\t2000000000\tmv_session\taccount-session");
    expect(session).toContain("api.manyvids.com\tFALSE\t/bff\tTRUE\t0\tapi_session\tapi-session");
    expect(session).not.toContain("attacker");
  });

  it("requires the completed ManyVids sign-in page and usable cookies", () => {
    expect(() => manyVidsSessionFromBrowser([
      { name: "mv_session", value: "account-session", domain: ".manyvids.com" },
    ], { href: "https://www.manyvids.com/Login" })).toThrow("Finish signing in");
    expect(() => netscapeSessionFromBrowser([
      { name: "session", value: "lookalike", domain: "evilmanyvids.com" },
    ], ["manyvids.com"])).toThrow("did not expose an account session");
  });
});
