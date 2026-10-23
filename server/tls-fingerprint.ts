import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A `fetch` that presents a real Chrome TLS fingerprint.
 *
 * Some live CDNs gate on the client's TLS fingerprint instead of headers or cookies: CamSoda's
 * edge answers 403 to ffmpeg's OpenSSL stack for the very URL that answers 200 through
 * curl_cffi's Chrome impersonation -- measured, playlist and segments alike, headers identical.
 * ffmpeg cannot impersonate, so the HLS proxy forwards those fetches to a small persistent
 * Python helper (server/tls_fetch.py) that can. One process serves everything: spawning Python
 * per segment would cost more than the segment on a single-core host.
 *
 * When the helper cannot run at all -- no Python, no curl_cffi, a dev box -- every call falls
 * back to the plain global fetch, so nothing that works today stops working; the fingerprint is
 * a strict upgrade where it exists.
 *
 * `EASYX_TLS_FETCH_URL` points the shim at an already-running helper. It exists for tests; a
 * deployment never sets it.
 */
const HELPER_URL_ENV = "EASYX_TLS_FETCH_URL";
const STARTUP_TIMEOUT_MS = 10_000;

/** Only what the shim needs of the helper: something to recognise it by and to stop it with. */
type Daemon = { process: { kill(): boolean }; port: number };

let daemon: Daemon | undefined;
let starting: Promise<Daemon | undefined> | undefined;
let unavailable = false;

function helperScript(): string {
  return fileURLToPath(new URL("./tls_fetch.py", import.meta.url));
}

function pythonCommand(): string {
  return process.env.EASYX_PYTHON ?? (existsSync("/opt/easyx/bin/python") ? "/opt/easyx/bin/python" : "python3");
}

/** The helper's base URL: the test override, a running daemon, or nothing (fall back to plain). */
async function helperBase(): Promise<string | undefined> {
  const override = process.env[HELPER_URL_ENV];
  if (override) return override;
  if (daemon) return `http://127.0.0.1:${daemon.port}/`;
  if (unavailable) return undefined;
  if (!existsSync(helperScript())) { unavailable = true; return undefined; }
  // A missing curl_cffi is permanent, so it is probed once instead of per request.
  const probe = spawnSync(pythonCommand(), ["-c", "import curl_cffi"], { timeout: 15_000 });
  if (probe.error || probe.status !== 0) { unavailable = true; return undefined; }
  return startDaemon().then((started) => (started ? `http://127.0.0.1:${started.port}/` : undefined));
}

function startDaemon(): Promise<Daemon | undefined> {
  if (!starting) {
    starting = new Promise<Daemon | undefined>((resolve) => {
      const child = spawn(pythonCommand(), [helperScript()], { stdio: ["ignore", "pipe", "inherit"] });
      const timer = setTimeout(() => { child.kill(); resolve(undefined); }, STARTUP_TIMEOUT_MS);
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const port = /^PORT (\d+)$/m.exec(buffer)?.[1];
        if (!port) return;
        clearTimeout(timer);
        daemon = { process: child, port: Number(port) };
        resolve(daemon);
      });
      // A helper that dies before announcing its port (import error) leaves the promise to the
      // timeout, so the caller falls back to the plain fetch exactly once.
      child.on("exit", () => { if (daemon?.process === child) daemon = undefined; resolve(daemon); });
    }).finally(() => { starting = undefined; });
  }
  return starting;
}

function headerRecord(source: HeadersInit | undefined): Record<string, string> {
  if (!source) return {};
  const entries = source instanceof Headers ? [...source] : Array.isArray(source) ? source : Object.entries(source as Record<string, string>);
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

const MIRRORED_HEADERS = ["content-type", "content-range", "accept-ranges", "content-length"];

export const fingerprintedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers = headerRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const base = await helperBase();
  // No helper anywhere: behave like the plain fetch the proxy would otherwise have used.
  if (!base) return globalThis.fetch(input, init);
  try {
    const response = await globalThis.fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, headers }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    const mirrored = new Headers();
    for (const name of MIRRORED_HEADERS) {
      const value = response.headers.get(name);
      if (value) mirrored.set(name, value);
    }
    // The helper mirrors the upstream status, so a 403 stays a 403: the proxy reports what the
    // provider actually said instead of hiding it behind a transport error.
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: mirrored });
  } catch (error) {
    // The helper died under us; forget it so the next call starts a fresh one. This request
    // still fails -- the proxy retries three times, and a later attempt gets the new helper.
    if (!process.env[HELPER_URL_ENV]) daemon = undefined;
    throw error;
  }
};

/** Forget every cached decision about the helper. Tests use it to reset between cases. */
export function resetTlsFingerprintForTests(): void {
  daemon = undefined;
  starting = undefined;
  unavailable = false;
}
