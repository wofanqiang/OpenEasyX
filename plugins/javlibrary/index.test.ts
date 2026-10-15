import { describe, expect, it, vi } from "vitest";
import javlibrary, { parseStarDirectory } from "./index.js";

describe("JavLibrary plugin", () => {
  it.each(["http://flaresolverr:8191", " http://flaresolverr:8191/ ", "http://flaresolverr:8191/v1/"])("connects to the FlareSolverr API from %s", async (flareSolverrUrl) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "ok", solution: { status: 200, response: '<div class="starbox"></div>' } })));
    await expect(javlibrary.testConnection!({ config: { flareSolverrUrl }, fetch, runCommand: vi.fn(), log: vi.fn() })).resolves.toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledWith("http://flaresolverr:8191/v1", expect.objectContaining({ method: "POST", body: expect.stringContaining('"cmd":"request.get"') }));
  });

  it("parses and deduplicates performer directory entries", () => {
    const html = `<div class="starbox"><div class="searchitem"><a href="vl_star.php?s=abc12">Mikami Yua</a></div><a href="./vl_star.php?s=abc12">Mikami Yua</a></div>`;
    expect(parseStarDirectory(html)).toEqual([{ id: "abc12", name: "Mikami Yua" }]);
  });
});
