import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizedMediaLink, mediaLinkUrl } from "./media-links.js";

const secret = "test-secret-value-0123456789";
const id = "a99ed9c782b49ce372d1c857";
const other = "b11fe0d893c5adf483e2d968";

function signLikeServer(id: string, exp: number): string {
  return createHmac("sha256", secret).update(`${id}.${exp}`).digest("base64url");
}

describe("media link tokens", () => {
  it("hands out a stream URL that answers without a session", () => {
    const url = mediaLinkUrl(id, secret);
    expect(url.startsWith(`/api/media/${id}/stream?exp=`)).toBe(true);
    expect(authorizedMediaLink({ url }, secret)).toBe(id);
  });

  it("rejects an expired link even though the token itself is intact", () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    expect(authorizedMediaLink({ url: `/api/media/${id}/stream?exp=${exp}&token=${signLikeServer(id, exp)}` }, secret)).toBeUndefined();
  });

  it("rejects a token minted for a different media id", () => {
    // The id is inside the signed message, so swapping the path invalidates the token.
    const url = mediaLinkUrl(id, secret).replace(`/media/${id}/`, `/media/${other}/`);
    expect(authorizedMediaLink({ url }, secret)).toBeUndefined();
  });

  it("rejects a tampered token and a link signed with another secret", () => {
    const url = new URL(mediaLinkUrl(id, secret), "http://localhost");
    const token = url.searchParams.get("token")!;
    url.searchParams.set("token", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`);
    expect(authorizedMediaLink({ url: `${url.pathname}${url.search}` }, secret)).toBeUndefined();
    expect(authorizedMediaLink({ url: mediaLinkUrl(id, secret) }, "another-secret-value-9876")).toBeUndefined();
  });

  it("ignores anything that is not a stream URL, and malformed parameters", () => {
    expect(authorizedMediaLink({ url: `/api/media/${id}/thumbnail` }, secret)).toBeUndefined();
    expect(authorizedMediaLink({ url: `/api/media/${id}` }, secret)).toBeUndefined();
    expect(authorizedMediaLink({ url: `/api/media/${id}/stream?exp=soon&token=x` }, secret)).toBeUndefined();
    expect(authorizedMediaLink({ url: `/api/media/${id}/stream?token=x` }, secret)).toBeUndefined();
    expect(authorizedMediaLink({ url: "/api/library" }, secret)).toBeUndefined();
  });
});

/**
 * The trailing file name exists for download managers, not for the server: a URL that ends in
 * ".mp4" is queued by clients that refuse an extension-less target, and the task list shows a real
 * name instead of "stream". It is cosmetic, so it must not affect what the token authorises.
 */
describe("media link file names", () => {
  it("puts the name in the path, encoded", () => {
    const url = mediaLinkUrl(id, secret, "clip one.mp4");
    expect(url.startsWith(`/api/media/${id}/stream/clip%20one.mp4?exp=`)).toBe(true);
    expect(authorizedMediaLink({ url }, secret)).toBe(id);
  });

  it("keeps the same token whether or not a name is present", () => {
    const plain = new URL(mediaLinkUrl(id, secret), "http://localhost");
    const named = new URL(mediaLinkUrl(id, secret, "clip.mp4"), "http://localhost");
    expect(named.searchParams.get("token")).toBe(plain.searchParams.get("token"));
    expect(named.searchParams.get("exp")).toBe(plain.searchParams.get("exp"));
  });

  it("cannot be turned into another path by editing the name", () => {
    const url = mediaLinkUrl(id, secret, "clip.mp4");
    // A slash cannot appear in the name segment, so "stream/<name>" can never become a deeper path.
    expect(authorizedMediaLink({ url: url.replace("/stream/clip.mp4", "/stream/a/b") }, secret)).toBeUndefined();
    expect(authorizedMediaLink({ url: url.replace("/stream/clip.mp4", "/stream/../../thumbnail") }, secret)).toBeUndefined();
  });

  it("still refuses the name form with a token minted for another id", () => {
    const url = mediaLinkUrl(id, secret, "clip.mp4").replace(`/media/${id}/`, `/media/${other}/`);
    expect(authorizedMediaLink({ url }, secret)).toBeUndefined();
  });
});
