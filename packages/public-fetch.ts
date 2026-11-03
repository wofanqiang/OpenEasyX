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
  if (host.includes(":")) {
    // An IPv4 address written in IPv6 form is the same address: ::ffff:127.0.0.1 is the loopback,
    // and ::ffff:7f00:1 is the same one in hex. Reading only the dotted form let the loopback
    // through, and a document could point the server at itself.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped) return isInternalHost(mapped[1]);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hexMapped) {
      const high = parseInt(hexMapped[1], 16);
      const low = parseInt(hexMapped[2], 16);
      const octets = [high >> 8, high & 0xff, low >> 8, low & 0xff];
      return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
        || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 192 && octets[1] === 168)
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
    }
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("fe80:")) return true;                       // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;                 // unique-local fc00::/7
    if (/^fe[c0][0-9a-f]:/.test(host)) return true;                  // site-local fec0::/10
    if (host.startsWith("2001:db8:")) return true;                   // documentation
    if (host.startsWith("ff")) return true;                          // multicast
    return false;
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  // 0.0.0.0/8 (this network), 10/8, 127/8, the link-local 169.254/16, the private ranges, the
  // carrier-grade NAT 100.64/10, the IETF blocks 192.0.0/24 and 198.18/15, and everything above
  // 223 (multicast and reserved).
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
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

export type FetchPublicOptions = {
  /**
   * Extra per-hop rule for providers that only serve from their own hosts. It runs on the address
   * we were given and on every redirect target, so a site allowlist cannot be bypassed by a 302
   * either.
   */
  assertHop?: (url: URL) => void;
};

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
  options: FetchPublicOptions = {},
): Promise<Response> {
  const check = (target: string) => {
    const safe = publicUrl(target, label);
    options.assertHop?.(new URL(safe));
    return safe;
  };
  let target = check(value);
  // A caller that asked for `redirect: "manual"` inspects the 3xx itself -- Chaturbate uses that to
  // notice a session that bounced to the login page. Following the chain here would hide exactly
  // the signal it is looking for, and since it never follows, there is no second hop to check.
  if (init.redirect === "manual") return fetcher.fetch(target, init);
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
    target = check(next);
  }
  throw new RefusedAddressError(`${label} redirected a stream address more than ${PUBLIC_FETCH_REDIRECTS} times`);
}
