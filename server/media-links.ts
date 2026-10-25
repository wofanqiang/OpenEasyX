import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

/**
 * A stream URL is a capability: it carries a token scoped to one media id, so an exported link
 * keeps working without a session -- in a download manager, on another machine -- while every
 * other endpoint stays behind the session gate. Nothing is stored server-side: the token is an
 * HMAC over the id and the expiry, keyed by the session secret, so a leaked link goes stale on
 * its own instead of living forever.
 */
// 30 days, the session lifetime: long enough to hand a list to a download manager and come back
// to it, short enough that a leaked file ages out.
const MEDIA_LINK_TTL_DAYS = 30;
/**
 * The stream path, with an optional trailing file name.
 *
 * The name is cosmetic -- download managers read the real one from `Content-Disposition` -- but a
 * URL that ends in `.mp4` is treated as a file by clients that refuse to queue anything without a
 * recognisable extension, and it gives their task list a readable name instead of the bare last
 * segment of the path ("stream"). It is not part of the signature: the id and the expiry are, so a
 * caller cannot turn one link into another by editing the name.
 */
const STREAM_PATH = /^\/api\/media\/([a-f0-9]{24})\/stream(?:\/[^/?#]*)?$/;

function sign(id: string, exp: number, secret: string): string {
  return createHmac("sha256", secret).update(`${id}.${exp}`).digest("base64url");
}

/** A stream URL that answers without a session. Relative, so it works behind any origin. */
export function mediaLinkUrl(id: string, secret: string, name?: string): string {
  const exp = Math.floor(Date.now() / 1000) + MEDIA_LINK_TTL_DAYS * 86_400;
  const suffix = name ? "/" + encodeURIComponent(name.slice(0, 180)) : "";
  return `/api/media/${id}/stream${suffix}?exp=${exp}&token=${sign(id, exp, secret)}`;
}

/**
 * The media id when the request is a stream URL carrying a valid, unexpired token for that very
 * id -- the one shape of API request the session gate lets through on a token alone. A token
 * signed for another id fails here because the id is inside the signed message.
 */
export function authorizedMediaLink(request: Pick<FastifyRequest, "url">, secret: string): string | undefined {
  let url: URL;
  try { url = new URL(request.url, "http://localhost"); } catch { return undefined; }
  const id = STREAM_PATH.exec(url.pathname)?.[1];
  if (!id) return undefined;
  const exp = Number(url.searchParams.get("exp"));
  const token = url.searchParams.get("token") ?? "";
  if (!Number.isFinite(exp) || exp <= Date.now() / 1000 || !token) return undefined;
  const expected = sign(id, exp, secret);
  return expected.length === token.length && timingSafeEqual(Buffer.from(expected), Buffer.from(token)) ? id : undefined;
}
