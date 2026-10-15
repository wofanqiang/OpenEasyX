export function apiHeaders(options?: RequestInit): Headers {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && options.body !== null && !headers.has("content-type")) headers.set("content-type", "application/json");
  // CSRF defense: every state-changing request carries a header that browsers
  // cannot add on cross-site requests. The backend rejects non-GET requests lacking it.
  if (options?.method && options.method !== "GET" && options.method !== "HEAD") headers.set("x-requested-with", "EasyX");
  return headers;
}

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, credentials: "include", headers: apiHeaders(options) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("easyx:unauthorized"));
    throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status, payload.code, payload.conflict);
  }
  return payload as T;
}
import type { PerformerConflict } from "../packages/profile-identity.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly conflict?: PerformerConflict) { super(message); }
}
