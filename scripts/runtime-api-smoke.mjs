// HTTP smoke for a running container: sign in, prove the authenticated endpoints answer (the
// official plugin repository must be listed and non-removable), then exercise the integrated
// browser login end to end -- start the session, prove the /browser viewer answers behind the
// session gate, drive the paste bridge over CDP, and stop.
//
// It needs the two variables the browser feature needs: EASYX_ENABLE_BROWSER_LOGIN=true (otherwise
// start refuses with 503) and a known admin password (EASYX_ADMIN_PASSWORD) to mint the session
// cookie the gate asks for.
//
//   EASYX_BASE_URL=http://127.0.0.1:3210 \
//   EASYX_ADMIN_PASSWORD=smoke-password \
//   node scripts/runtime-api-smoke.mjs
//
// The plugin under test is org.easyx.manyvids unless EASYX_SMOKE_PLUGIN says otherwise.

const base = process.env.EASYX_BASE_URL ?? "http://127.0.0.1:3210";
const password = process.env.EASYX_ADMIN_PASSWORD ?? "smoke-password";
const pluginId = process.env.EASYX_SMOKE_PLUGIN ?? "org.easyx.manyvids";
// Host the plugin under test is expected to open; only asserted for the default plugin.
const loginHost = process.env.EASYX_SMOKE_LOGIN_HOST ?? (/^org\.easyx\.manyvids$/.test(pluginId) ? "manyvids.com" : "");
const pastedText = "easyx-mac-clipboard";

function fail(message) { throw new Error(message); }

async function api(path, { method = "GET", body, cookie, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  // The session gate requires a custom header on every state-changing /api/ request (CSRF), and
  // the viewer is a same-origin iframe, so the cookie rides along exactly as the UI sends it.
  if (method !== "GET") headers["x-requested-with"] = "EasyX";
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return response;
  const payload = await response.json().catch(() => undefined);
  return { response, payload };
}

function sessionFrom(response) {
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")];
  const session = (cookies ?? []).map((header) => String(header).split(";")[0].trim()).find((pair) => pair.startsWith("easyx_session="));
  if (!session) fail("Login did not return a session cookie");
  return session;
}

const login = await api("/api/auth/login", { method: "POST", body: { password } });
if (!login.response.ok) fail(`Login failed with HTTP ${login.response.status}: ${JSON.stringify(login.payload)}`);
const cookie = sessionFrom(login.response);

// The official repository ships with the image and must never be removable; user-added ones are.
const repositories = await api("/api/plugin-repositories", { cookie });
if (!Array.isArray(repositories.payload) || !repositories.payload.find((entry) => entry.id === "official" && !entry.removable)) {
  fail(`plugin-repositories did not list a non-removable official entry: ${JSON.stringify(repositories.payload)}`);
}

let started = false;
try {
  const start = await api(`/api/plugins/${pluginId}/browser-login/start`, { method: "POST", cookie });
  if (!start.response.ok || !start.payload?.active || !start.payload?.viewerPath) {
    fail(`Browser login did not start (HTTP ${start.response.status}): ${JSON.stringify(start.payload)}`);
  }
  started = true;

  const viewer = await api(start.payload.viewerPath, { cookie, raw: true });
  if (!viewer.ok) fail(`noVNC viewer answered HTTP ${viewer.status} (expected 200 behind the session gate)`);
  if (!String(viewer.headers.get("content-type") ?? "").includes("html")) fail(`noVNC viewer is not HTML: ${viewer.headers.get("content-type")}`);
  await viewer.body?.cancel().catch(() => {});

  const targets = await fetch("http://127.0.0.1:9222/json").then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  if (!target) fail("Chromium page target is missing");
  if (loginHost && !new RegExp(loginHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(target.url ?? "")) {
    fail(`${loginHost} did not open in Chromium: ${target.url}`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connection failed")); }, { once: true });
  });
  let nextId = 0;
  function call(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5_000);
      const listener = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        clearTimeout(timer); socket.removeEventListener("message", listener);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      };
      socket.addEventListener("message", listener);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  await call("Runtime.evaluate", {
    expression: `(() => { const input = document.createElement("input"); input.id = "easyx-paste-smoke"; document.documentElement.appendChild(input); input.focus(); return document.activeElement === input; })()`,
    returnByValue: true,
  });
  const pasted = await api(`/api/plugins/${pluginId}/browser-login/paste`, { method: "POST", body: { text: pastedText }, cookie });
  if (!pasted.response.ok || pasted.payload?.characters !== [...pastedText].length) {
    fail(`Paste bridge failed: HTTP ${pasted.response.status} ${JSON.stringify(pasted.payload)}`);
  }
  const value = await call("Runtime.evaluate", { expression: "document.querySelector('#easyx-paste-smoke')?.value", returnByValue: true });
  if (value.result?.value !== pastedText) fail(`Unexpected pasted value: ${JSON.stringify(value.result)}`);
  socket.close();
} finally {
  if (started) {
    // A failure to stop must not replace the error that brought us here; the container is torn
    // down right after this smoke anyway, and the zombie check that follows is the real guard.
    const stop = await api(`/api/plugins/${pluginId}/browser-login`, { method: "DELETE", cookie });
    if (!stop.response.ok) console.error(`warning: stopping the browser session failed: HTTP ${stop.response.status}`);
  }
}

console.log("runtime api smoke: authenticated endpoints, viewer, paste bridge -- all ok");
