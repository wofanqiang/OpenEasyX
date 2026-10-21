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
 * The previous behaviour was no trust at all, so `request.ip` was the proxy for every request and
 * the login rate limiter kept a single shared bucket: six wrong passwords from anyone locked out
 * everyone, including the operator. Trusting a private peer by default fixes that without any
 * configuration, while a direct public client still cannot forge the header.
 *
 * `EASYX_TRUST_PROXY=true|false` overrides, for deployments behind something that connects from a
 * public address (a remote load balancer) or the opposite (do not trust anyone).
 */
export function trustProxyOption(env: string | undefined = process.env.EASYX_TRUST_PROXY): boolean | ((address: string) => boolean) {
  const value = (env ?? "").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return isPrivateAddress;
}
