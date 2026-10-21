// The remote documents this server parses hand it the addresses it should fetch next: a player
// module, a stream manifest, a segment inside that manifest. Checking the address itself is not
// enough. `fetch` follows redirects on its own, so validating only the URL it was handed lets a
// reachable CDN answer 302 with a loopback or cloud-metadata address and have this server request
// *that* instead -- the guard would have approved the first hop and never seen the second.
//
// So every hop is checked, and the chain is bounded: a host that keeps redirecting is refused
// rather than chased. `server/live-cam-images.ts` does the same for portraits; these helpers are
// the shared version for the stream path.
//
// Names are checked, not resolved: a DNS lookup per hop would cost more than it prevents, and the
// targets that matter here are literals.

/** How many redirects a public fetch may follow before the chain is treated as a refusal. */
export const PUBLIC_FETCH_REDIRECTS = 5;

/**
 * A URL the remote document chose that this server will not request. Kept as its own type because
 * callers must not mistake the refusal for evidence about the room: `server/offline-error.ts`
 * parks a room for an hour on the messages that mean "the provider says it is offline".
 */
export class RefusedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedAddressError";
  }
}

/**
 * The refused address points inside this host's network. Callers use this subtype to tell "we
 * refused to go there" apart from "the address was malformed", which is a different failure.
 */
export class InternalAddressError extends RefusedAddressError {
  constructor(message: string) {
    super(message);
    this.name = "InternalAddressError";
  }
}

/** Hosts that must never be reached from a URL a downloaded document chose for us. */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0") return true;
  if (/\.(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) return true;
  // A colon only survives URL parsing inside a bracketed IPv6 literal, so these prefixes are safe
  // to read as addresses rather than as names.
  if (host.includes(":")) return host === "::1" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(host);
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Returns `value` when it is safe to request, or throws. `label` names the provider in the message
 * so the failure reads as "Stripchat returned ..." / "SuperChat returned ..." rather than as an
 * internal error.
 */
export function publicUrl(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RefusedAddressError(`${label} returned a stream address that is not a URL`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RefusedAddressError(`${label} returned a stream address with an unsupported scheme`);
  }
  if (isInternalHost(url.hostname)) {
    throw new InternalAddressError(`${label} returned a stream address that points inside this host's network`);
  }
  return url.toString();
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetches a URL a remote document chose, checking every hop of the redirect chain.
 *
 * `redirect: "manual"` is what makes this work: with the platform default the whole chain happens
 * inside one call and only the first URL is ever ours to inspect.
 */
export async function fetchPublic(
  fetcher: { fetch: typeof globalThis.fetch },
  value: string,
  label: string,
  init: RequestInit = {},
): Promise<Response> {
  let target = publicUrl(value, label);
  for (let hop = 0; hop <= PUBLIC_FETCH_REDIRECTS; hop += 1) {
    const response = await fetcher.fetch(target, { ...init, redirect: "manual" });
    const location = isRedirect(response.status) ? response.headers.get("location") : null;
    // A 3xx without a Location cannot be followed; hand it back so the caller applies its own
    // "not a playlist" verdict instead of inventing a redirect failure.
    if (!location) return response;
    // The redirect body is never read, and an undrained stream keeps its socket busy.
    try { await response.body?.cancel(); } catch { /* Nothing to release. */ }
    let next: string;
    // Relative Location values are legal and resolve against the hop that sent them.
    try { next = new URL(location, target).toString(); } catch { throw new RefusedAddressError(`${label} returned a redirect to an address that is not a URL`); }
    // Throws before the request is made, which is the whole point of following the chain by hand.
    target = publicUrl(next, label);
  }
  throw new RefusedAddressError(`${label} redirected a stream address more than ${PUBLIC_FETCH_REDIRECTS} times`);
}
