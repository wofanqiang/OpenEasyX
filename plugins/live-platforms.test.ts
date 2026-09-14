import { describe, expect, it } from "vitest";
import cam4 from "./cam4/index.js";
import stripchat from "./stripchat/index.js";
import bongacams from "./bongacams/index.js";
import myfreecams from "./myfreecams/index.js";
import livejasmin from "./livejasmin/index.js";
import camsoda from "./camsoda/index.js";
import cams from "./cams/index.js";
import xcams from "./xcams/index.js";
import superchatlive from "./superchatlive/index.js";

describe("bundled live platforms", () => {
  const plugins = [cam4, stripchat, bongacams, myfreecams, livejasmin, camsoda, cams, xcams, superchatlive];

  it("ships every requested provider as a unique live-cam plugin", () => {
    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "org.easyx.cam4", "org.easyx.stripchat", "org.easyx.bongacams", "org.easyx.myfreecams",
      "org.easyx.livejasmin", "org.easyx.camsoda", "org.easyx.cams", "org.easyx.xcams",
      "org.easyx.superchatlive",
    ]);
    expect(new Set(plugins.map((plugin) => plugin.manifest.id))).toHaveProperty("size", plugins.length);
    for (const plugin of plugins) {
      expect(plugin.manifest.capabilities).toContain("live-cam");
      expect(plugin.manifest.sourceUrlPatterns?.length).toBeGreaterThan(0);
      expect(plugin.resolveLiveStream).toBeTypeOf("function");
    }
  });
});
