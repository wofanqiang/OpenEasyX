/**
 * Whether an address sits on a private, loopback or link-local network.
 *
 * This decides one thing: is the socket peer a reverse proxy on this host (or a peer on the
 * compose network)? Only those peers get their `X-Forwarded-For` believed. A client arriving from
 * a public address is never trusted, so it cannot name someone else's address and push them into
 * a rate-limit bucket -- which is exactly what happens when the header is trusted blindly.
 */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  // Node reports IPv4 peers on a dual-stack socket as `::ffff:172.17.0.1`.
  const v4 = value.startsWith("::ffff:") ? value.slice(7) : value;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    return a === 0 || a === 10 || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (value === "::1") return true;
  if (value.startsWith("fe80:")) return true;            // link-local
  return /^f[cd][0-9a-f]{2}:/.test(value);               // unique-local fc00::/7
}

/**
 * The `trustProxy` value for Fastify.
 *
 * The application is published directly (the container's port reaches the internet), so a client
 * can put any address it likes into `X-Forwarded-For`. Believing that header by default let
 * anyone walk past the login rate limiter: every forged address was a fresh bucket, so the
 * password could be guessed as often as the attacker liked.
 *
 * The default is therefore to believe nobody. The limiter then counts every attempt against one
 * bucket, which is a far better trade: attempts stay capped, and the lockout it applies is short
 * (at most a minute) rather than an unlimited guessing budget.
 *
 * `EASYX_TRUST_PROXY=private` restores the old behaviour for a deployment that really does sit
 * behind a reverse proxy on the same host -- the header is only believed when the socket peer is
 * a private address. `true` believes it unconditionally, `false` is the default.
 */
export function trustProxyOption(env: string | undefined = process.env.EASYX_TRUST_PROXY): boolean | ((address: string) => boolean) {
  const value = (env ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "private") return isPrivateAddress;
  return false;
}
