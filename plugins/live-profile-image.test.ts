import { describe, expect, it } from "vitest";
import { profileImages, profileImageUrl } from "./live-profile-image.js";
const cam = { id: "alice", username: "alice", pageUrl: "https://chaturbate.com/alice/" };
describe("Provider profile images", () => {
  it("extracts portraits with relative URLs and reversed attribute order, excluding branding", () => {
    expect(profileImages(`<meta content="/logo.jpg" property="og:image"><img src="//images.test/alice.jpg?a=1&amp;b=2" class="profile_pic"><meta content='/portrait.jpg' name='twitter:image'>`, cam))
      .toEqual(["https://images.test/alice.jpg?a=1&b=2", "https://chaturbate.com/portrait.jpg"]);
    expect(profileImageUrl("javascript:alert(1)", cam.pageUrl)).toBeUndefined();
    expect(profileImageUrl("https://images.test/no_image.jpg", cam.pageUrl)).toBeUndefined();
  });
  it("does not store an offline room snapshot that can return the provider logo", () => {
    expect(profileImages('<meta property="og:image" content="https://thumb.live.mmcdn.com/ri/alice.jpg">', { ...cam, online: false })).toEqual([]);
    expect(profileImages('<meta property="og:image" content="https://thumb.live.mmcdn.com/ri/alice.jpg">', { ...cam, online: true })).toHaveLength(1);
  });
});
