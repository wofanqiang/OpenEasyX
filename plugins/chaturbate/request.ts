import type { PluginContext } from "../../packages/plugin-sdk/index.js";

type RequestState = { tail: Promise<void>; retryAt: number };
const states = new WeakMap<typeof fetch, RequestState>();

// The room list, followed list, and exact status endpoint share an IP limit.
// Serialize them and apply one cooldown, including when another tab is open.
export async function chaturbateRequest(context: PluginContext, url: string, init: RequestInit): Promise<Response> {
  let state = states.get(context.fetch);
  if (!state) { state = { tail: Promise.resolve(), retryAt: 0 }; states.set(context.fetch, state); }
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    init.signal?.throwIfAborted();
    if (Date.now() < state.retryAt) throw new Error(`Chaturbate is temporarily limiting requests (HTTP 429 or network timeout). Automatic retry in ${Math.ceil((state.retryAt - Date.now()) / 1000)} seconds. Your favorites are saved.`);
    // A network timeout is per-request: only an explicit 429/503 response earns the shared
    // cooldown, so one slow fetch under load no longer blanks the provider for a minute.
    const response = await context.fetch(url, init);
    if (response.status === 429 || response.status === 503) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? (Date.parse(retryAfter) - Date.now()) / 1000 : 120;
      state.retryAt = Date.now() + Math.max(60, Number.isFinite(seconds) ? seconds : 120) * 1000;
    }
    if (response.status === 429 || response.status === 503) throw new Error(`Chaturbate is temporarily limiting requests (HTTP ${response.status}). Automatic retry in ${Math.ceil((state.retryAt - Date.now()) / 1000)} seconds. Your favorites are saved.`);
    return response;
  } finally { release(); }
}
