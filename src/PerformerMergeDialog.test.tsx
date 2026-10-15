import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PerformerMergeReview } from "./PerformerMergeDialog.js";

describe("performer merge review", () => {
  it("presents both profiles and disables confirmation while work is active", () => {
    const html = renderToStaticMarkup(<PerformerMergeReview preview={{ from: { id: "a", name: "First", files: 4, sources: 1 }, target: { id: "b", name: "Second", files: 2, sources: 3 }, blocked: true }} targetId="b" selectTarget={() => {}} confirm={() => {}} close={() => {}} pending={false}/>);
    expect(html).toContain("First"); expect(html).toContain("Second");
    expect(html).toContain('type="radio"'); expect(html).toContain("4 stored files");
    expect(html).toContain('disabled="">Merge profiles');
    expect(html).toContain("favorites and playback history are kept");
  });
});
