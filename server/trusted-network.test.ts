import { describe, expect, it } from "vitest";
import { isPrivateAddress, trustProxyOption } from "./trusted-network.js";

describe("trusted network for proxy headers", () => {
  it("trusts the private peers a reverse proxy connects from", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "172.31.255.254", "192.168.3.21", "169.254.1.1", "::1", "fe80::1", "fd00::5", "::ffff:172.17.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("does not trust a client that arrives from a public address", () => {
    // A public peer must never have its X-Forwarded-For believed, or it could name the address of
    // the operator and push them into the login rate-limit bucket.
    for (const address of ["8.8.8.8", "1.1.1.1", "203.0.113.9", "172.32.0.1", "172.15.0.1", "2001:db8::1", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("believes nobody by default", () => {
    // The application is published straight to the internet, so a client can put any address it
    // likes into X-Forwarded-For. Believing that header let anyone walk past the login limiter:
    // every forged address was a fresh bucket. The limiter keeps working with one shared bucket,
    // and its lockout is short.
    expect(trustProxyOption(undefined)).toBe(false);
    expect(trustProxyOption("")).toBe(false);
    expect(trustProxyOption("TRUE")).toBe(true);
    expect(trustProxyOption("false")).toBe(false);
  });

  it("trusts private peers only when a deployment says so", () => {
    expect(trustProxyOption("private")).toBe(isPrivateAddress);
    expect(trustProxyOption("PRIVATE")).toBe(isPrivateAddress);
  });
});
