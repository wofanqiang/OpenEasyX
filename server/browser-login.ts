import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { PluginManifest } from "../packages/plugin-sdk/index.js";

type BrowserCookie = {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  secure?: unknown;
};
type BrowserValues = { xBc?: unknown; userAgent?: unknown; href?: unknown };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const causeText = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : undefined;
  return causeText ? `${error.message} (${causeText})` : error.message;
}

function unlinkNonDirectory(target: string) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function removeStaleBrowserArtifacts(profileDir: string, runtimeDir = "/tmp", displayNumber = 99) {
  for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) unlinkNonDirectory(path.join(profileDir, name));
  unlinkNonDirectory(path.join(runtimeDir, `.X${displayNumber}-lock`));
  unlinkNonDirectory(path.join(runtimeDir, ".X11-unix", `X${displayNumber}`));
}

/**
 * Integrated browser login runs a whole desktop (Xvfb + openbox + Chromium), which a 1 GB
 * single-core deployment cannot afford to start by accident. The feature is therefore off unless
 * EASYX_ENABLE_BROWSER_LOGIN=true. The check lives here so every entry point -- starting a
 * session, and the paste bridge that talks to it -- refuses the same way, instead of one route
 * starting the desktop while another one's viewer has nowhere to connect.
 */
export function browserLoginEnabled(): boolean {
  return process.env.EASYX_ENABLE_BROWSER_LOGIN === "true";
}

export function assertBrowserLoginEnabled() {
  if (!browserLoginEnabled()) {
    throw Object.assign(new Error("Integrated browser login is disabled on this instance (set EASYX_ENABLE_BROWSER_LOGIN=true to enable it)"), { statusCode: 503 });
  }
}

export function onlyFansSessionFromBrowser(cookies: BrowserCookie[], values: BrowserValues): string {
  const onlyFansCookies = cookies.filter((cookie) => {
    const domain = text(cookie.domain)?.replace(/^\./, "").toLowerCase();
    return domain === "onlyfans.com" || Boolean(domain?.endsWith(".onlyfans.com"));
  });
  const valueFor = (name: string) => text(onlyFansCookies.find((cookie) => cookie.name === name)?.value);
  const authId = valueFor("auth_id");
  const sess = valueFor("sess");
  const authUid = valueFor("auth_uid") ?? text(onlyFansCookies.find((cookie) => text(cookie.name)?.startsWith("auth_uid_"))?.value) ?? "";
  const xBc = text(values.xBc);
  const userAgent = text(values.userAgent);
  const missing = [["auth_id", authId], ["sess", sess], ["x-bc", xBc], ["user_agent", userAgent]].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw Object.assign(new Error(`OnlyFans login is incomplete (${missing.join(", ")}). Finish signing in, wait for the home page to load, then try again.`), { statusCode: 409 });
  return JSON.stringify({ sess, auth_id: authId, auth_uid: authUid, user_agent: userAgent, "x-bc": xBc }, null, 2);
}

function cookieDomainMatches(cookie: BrowserCookie, allowedDomain: string): boolean {
  const domain = text(cookie.domain)?.replace(/^\./, "").toLowerCase();
  const allowed = allowedDomain.replace(/^\./, "").toLowerCase();
  return Boolean(domain && (domain === allowed || domain.endsWith(`.${allowed}`)));
}

export function netscapeSessionFromBrowser(cookies: BrowserCookie[], allowedDomains: string[]): string {
  const selected = cookies.filter((cookie) => allowedDomains.some((domain) => cookieDomainMatches(cookie, domain)));
  if (!selected.length) throw Object.assign(new Error("The signed-in browser did not expose an account session yet. Finish signing in, wait for the account page to load, then try again."), { statusCode: 409 });
  const lines = selected.flatMap((cookie) => {
    const domain = text(cookie.domain); const name = text(cookie.name);
    const value = typeof cookie.value === "string" ? cookie.value : undefined;
    if (!domain || !name || value === undefined || [domain, name, value].some((part) => /[\r\n\t]/.test(part))) return [];
    const cookiePath = text(cookie.path) ?? "/";
    const expiry = Number(cookie.expires);
    return [`${domain}\t${domain.startsWith(".") ? "TRUE" : "FALSE"}\t${cookiePath}\t${cookie.secure === true ? "TRUE" : "FALSE"}\t${Number.isFinite(expiry) && expiry > 0 ? Math.trunc(expiry) : 0}\t${name}\t${value}`];
  });
  if (!lines.length) throw Object.assign(new Error("The browser session did not contain usable cookies."), { statusCode: 409 });
  return `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`;
}

export function manyVidsSessionFromBrowser(cookies: BrowserCookie[], values: BrowserValues): string {
  const href = text(values.href);
  if (href) {
    try {
      const url = new URL(href);
      if (!/(^|\.)manyvids\.com$/i.test(url.hostname) || /^\/login\/?$/i.test(url.pathname)) {
        throw Object.assign(new Error("Finish signing in to ManyVids and wait for the account page to load before capturing the session."), { statusCode: 409 });
      }
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      throw Object.assign(new Error("Open ManyVids in the integrated browser before capturing the session."), { statusCode: 409 });
    }
  }
  return netscapeSessionFromBrowser(cookies, ["manyvids.com"]);
}

class CdpConnection {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        return;
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Chromium automation failed")); else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => this.rejectAll(new Error("The integrated browser closed unexpectedly")));
    socket.addEventListener("error", () => this.rejectAll(new Error("Could not communicate with the integrated browser")));
  }

  static open(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); reject(new Error("Timed out while connecting to the integrated browser")); }, 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(new CdpConnection(socket)); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to the integrated browser")); }, { once: true });
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chromium command '${method}' timed out`)); }, 15_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor<T>(method: string, predicate: (params: T) => boolean, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const listeners = this.listeners.get(method) ?? new Set<(params: unknown) => void>();
      const listener = (params: unknown) => {
        if (!predicate(params as T)) return;
        clearTimeout(timer); listeners.delete(listener); resolve(params as T);
      };
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error("No authenticated request was detected. Finish signing in and try again.")); }, timeoutMs);
      listeners.add(listener); this.listeners.set(method, listeners);
    });
  }

  close() { this.socket.close(); }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
  }
}

type CdpTarget = { type?: string; url?: string; webSocketDebuggerUrl?: string };

export class BrowserLoginManager {
  private processes: ChildProcess[] = [];
  private processOutput = new Map<string, string>();
  private processFailures = new Map<string, string>();
  private active?: { pluginId: string; startedAt: string; expiresAt: string };
  private activeProfileDir?: string;
  private expiry?: NodeJS.Timeout;
  private readonly display = ":99";
  private readonly cdpUrl = "http://127.0.0.1:9222";

  constructor(private dataDir: string) {}

  async start(pluginId: string, manifest: PluginManifest) {
    // Gate the whole feature, not just the viewer: without this a session could start (spawning
    // the desktop) while the /browser proxy stayed unregistered, leaving the user staring at a
    // 404 where the viewer should be.
    assertBrowserLoginEnabled();
    if (!manifest.browserAuth) throw Object.assign(new Error(`${manifest.name} does not support integrated browser login`), { statusCode: 409 });
    await this.stop();
    const browserRoot = path.join(this.dataDir, "browser");
    const profileDir = path.join(browserRoot, "profiles", pluginId.replace(/[^a-z0-9.-]/gi, "_"));
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(browserRoot, 0o700); fs.chmodSync(profileDir, 0o700);
    removeStaleBrowserArtifacts(profileDir);
    this.activeProfileDir = profileDir;
    this.processOutput.clear(); this.processFailures.clear();
    const environment = { ...process.env, DISPLAY: this.display, HOME: browserRoot, XDG_CONFIG_HOME: path.join(browserRoot, "config"), XDG_CACHE_HOME: path.join(browserRoot, "cache") };

    try {
      this.launch("Xvfb", "Xvfb", [this.display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], environment);
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.launch("Openbox", "openbox", [], environment);
      this.launch("x11vnc", "x11vnc", ["-display", this.display, "-rfbport", "5900", "-localhost", "-forever", "-shared", "-nopw", "-quiet"], environment);
      this.launch("noVNC", "websockify", ["--web=/usr/share/novnc", "--heartbeat=30", "127.0.0.1:6080", "127.0.0.1:5900"], environment);
      this.launch("Chromium", "chromium", [
        "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--disable-breakpad", "--disable-crash-reporter", "--disable-features=TranslateUI,PasswordManagerOnboarding,PasswordGeneration", "--disable-save-password-bubble", "--password-store=basic", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222", "--remote-allow-origins=*",
        `--user-data-dir=${profileDir}`, "--window-position=0,0", "--window-size=1280,800", "--new-window", manifest.browserAuth.loginUrl,
      ], environment);
      await this.waitUntilReady();
      const now = Date.now();
      this.active = { pluginId, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString() };
      this.expiry = setTimeout(() => { void this.stop(); }, 15 * 60_000);
      this.expiry.unref();
      return this.status(pluginId);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  status(pluginId: string) {
    return {
      active: this.active?.pluginId === pluginId,
      startedAt: this.active?.pluginId === pluginId ? this.active.startedAt : undefined,
      expiresAt: this.active?.pluginId === pluginId ? this.active.expiresAt : undefined,
      viewerPath: this.active?.pluginId === pluginId ? "/browser/vnc.html?autoconnect=1&resize=scale&path=browser/websockify" : undefined,
    };
  }

  async capture(pluginId: string, manifest: PluginManifest): Promise<string> {
    if (!manifest.browserAuth || this.active?.pluginId !== pluginId) throw Object.assign(new Error("Start the integrated browser login first"), { statusCode: 409 });
    const sessionField = manifest.settings?.find((field) => field.key === manifest.browserAuth?.sessionSetting);
    if (!sessionField) throw new Error("The browser session setting is missing from the plugin manifest");
    const capture = manifest.browserAuth.capture ?? "cookies";
    const cookieDomains = sessionField.cookieDomains ?? [];
    const loginDomain = new URL(manifest.browserAuth.loginUrl).hostname.replace(/^www\./, "");
    const pageDomains = [...new Set([loginDomain, ...cookieDomains, ...(manifest.browserAuth.requestDomains ?? [])])];
    const targets = await this.cdp<CdpTarget[]>("/json");
    const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl && (() => {
      try {
        const hostname = new URL(candidate.url || "").hostname.replace(/^www\./, "");
        return pageDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
      } catch { return false; }
    })());
    if (!target?.webSocketDebuggerUrl) throw Object.assign(new Error(`Open ${manifest.name} in the integrated browser and finish signing in before capturing the session.`), { statusCode: 409 });
    const cdp = await CdpConnection.open(target.webSocketDebuggerUrl);
    try {
      await cdp.call("Network.enable");
      if (capture === "authorization-header") {
        const requestDomains = manifest.browserAuth.requestDomains ?? [];
        const authenticatedRequest = cdp.waitFor<{ request?: { url?: string; headers?: Record<string, unknown> } }>("Network.requestWillBeSent", (event) => {
          const request = event.request; if (!request?.url || !request.headers) return false;
          let hostname: string; try { hostname = new URL(request.url).hostname; } catch { return false; }
          const domainAllowed = requestDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
          const authorization = Object.entries(request.headers).find(([name, value]) => name.toLowerCase() === "authorization" && typeof value === "string" && value.trim());
          return domainAllowed && Boolean(authorization);
        });
        await cdp.call("Page.reload", { ignoreCache: false });
        const event = await authenticatedRequest;
        const authorization = Object.entries(event.request?.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
        if (typeof authorization !== "string" || !authorization.trim()) throw Object.assign(new Error("The signed-in browser did not expose an authorization session."), { statusCode: 409 });
        return authorization.trim();
      }
      const cookieResult = await cdp.call<{ cookies?: BrowserCookie[] }>("Network.getAllCookies");
      const evaluation = await cdp.call<{ result?: { value?: BrowserValues } }>("Runtime.evaluate", {
        expression: "({xBc: window.localStorage.getItem('bcTokenSha'), userAgent: navigator.userAgent, href: location.href})",
        returnByValue: true,
      });
      const values = evaluation.result?.value ?? {};
      if (capture === "onlyfans") return onlyFansSessionFromBrowser(cookieResult.cookies ?? [], values);
      if (capture === "manyvids") return manyVidsSessionFromBrowser(cookieResult.cookies ?? [], values);
      return netscapeSessionFromBrowser(cookieResult.cookies ?? [], cookieDomains);
    } finally {
      cdp.close();
    }
  }

  async paste(pluginId: string, value: string) {
    if (this.active?.pluginId !== pluginId) throw Object.assign(new Error("Start the integrated browser login first"), { statusCode: 409 });
    const targets = await this.cdp<CdpTarget[]>("/json");
    const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl && /^https?:/i.test(candidate.url ?? ""));
    if (!target?.webSocketDebuggerUrl) throw Object.assign(new Error("The integrated browser page is not ready"), { statusCode: 409 });
    const cdp = await CdpConnection.open(target.webSocketDebuggerUrl);
    try {
      const evaluation = await cdp.call<{ result?: { value?: boolean } }>("Runtime.evaluate", {
        expression: `(() => { const element = document.activeElement; if (!element) return false; if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly; if (element instanceof HTMLInputElement) return !element.disabled && !element.readOnly && !["button","checkbox","color","file","hidden","image","radio","range","reset","submit"].includes(element.type); return element instanceof HTMLElement && element.isContentEditable; })()`,
        returnByValue: true,
      });
      if (evaluation.result?.value !== true) throw Object.assign(new Error("Click the destination field in the integrated browser, then paste again."), { statusCode: 409 });
      await cdp.call("Input.insertText", { text: value });
      return { pasted: true, characters: [...value].length };
    } finally { cdp.close(); }
  }

  async stop() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.active = undefined;
    const running = this.processes.reverse().filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of running) child.kill("SIGTERM");
    await Promise.all(running.map((child) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); resolve(); }, 750);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    })));
    this.processes = [];
    removeStaleBrowserArtifacts(this.activeProfileDir ?? path.join(this.dataDir, "browser", "profiles", ".none"));
    this.activeProfileDir = undefined;
  }

  async removeProfile(pluginId: string) {
    if (this.active?.pluginId === pluginId) await this.stop();
    fs.rmSync(path.join(this.dataDir, "browser", "profiles", pluginId.replace(/[^a-z0-9.-]/gi, "_")), { recursive: true, force: true });
  }

  private launch(label: string, command: string, args: string[], environment: NodeJS.ProcessEnv) {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk) => {
      const previous = this.processOutput.get(label) ?? "";
      this.processOutput.set(label, `${previous}${String(chunk)}`.slice(-2_000));
    });
    child.on("error", (error) => this.processFailures.set(label, error.message));
    child.on("exit", (code, signal) => {
      if (code === 0 || (code === null && signal === "SIGTERM")) return;
      const output = (this.processOutput.get(label) ?? "").replace(/\s+/g, " ").trim();
      this.processFailures.set(label, output || `exited with ${code === null ? signal : `code ${code}`}`);
    });
    this.processes.push(child);
  }

  private async waitUntilReady() {
    let cdpError: unknown; let viewerError: unknown;
    for (let attempt = 0; attempt < 80; attempt++) {
      let cdpReady = false; let viewerReady = false;
      try {
        await this.cdp<{ webSocketDebuggerUrl?: string }>("/json/version");
        cdpReady = true;
      } catch (error) { cdpError = error; }
      try {
        const viewer = await fetch("http://127.0.0.1:6080/vnc.html", { signal: AbortSignal.timeout(2_000) });
        if (!viewer.ok) throw new Error(`noVNC returned HTTP ${viewer.status}`);
        viewerReady = true;
      } catch (error) { viewerError = error; }
      if (cdpReady && viewerReady) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const unavailable = [cdpError ? `Chromium endpoint: ${errorMessage(cdpError)}` : "", viewerError ? `noVNC endpoint: ${errorMessage(viewerError)}` : ""].filter(Boolean);
    const failures = [...this.processFailures].map(([label, message]) => `${label}: ${message}`);
    throw new Error(`Integrated browser did not start. ${[...unavailable, ...failures].join("; ")}`);
  }

  private async cdp<T>(pathname: string): Promise<T> {
    const response = await fetch(`${this.cdpUrl}${pathname}`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`Chromium returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }
}
