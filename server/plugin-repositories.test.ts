import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginRepositoryManager, repositoryPlugins } from "./plugin-repositories.js";

function temp(name: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `easyx-${name}-`));
  return directory;
}

describe("plugin repositories", () => {
  it("refuses a repository that can only be fetched in clear text", async () => {
    // A clone over HTTP can be rewritten on the way, and what arrives is code the server runs.
    const manager = new PluginRepositoryManager(temp("repos-http"), temp("official"));
    await expect(manager.add("http://example.test/plugins.git")).rejects.toThrow(/HTTPS, SSH, or Git/);
    await expect(manager.add("https://example.test/plugins.git", "")).rejects.not.toThrow(/HTTPS, SSH, or Git/);
  });

  it("describes what a checkout holds without running any of it", () => {
    // The manifest is a file next to the entry point; reading it costs a disk read, while
    // importing the module would run whatever the author wrote inside the server process.
    const checkout = temp("repos-plugins");
    const plugin = path.join(checkout, "plugins", "demo");
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({ id: "demo", name: "Demo Plugin", version: "2.1.0" }));
    fs.writeFileSync(path.join(plugin, "index.mjs"), `require("node:fs").writeFileSync(${JSON.stringify(path.join(plugin, "executed.marker"))}, "ran");\nexport default { manifest: { id: "demo" } };\n`);
    const bare = path.join(checkout, "plugins", "bare");
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, "index.mjs"), "export default { manifest: { id: 'bare' } };\n");

    const found = repositoryPlugins(checkout);

    // The order a directory lists in is the filesystem's business, not ours.
    expect([...found].sort((left, right) => left.directory.localeCompare(right.directory))).toEqual([
      { id: "bare", name: "bare", version: "", directory: "bare" },
      { id: "demo", name: "Demo Plugin", version: "2.1.0", directory: "demo" },
    ]);
    // The module was never imported, so the code inside it never ran.
    expect(fs.existsSync(path.join(plugin, "executed.marker"))).toBe(false);
  });

  it("leaves nothing behind when a repository cannot be fetched", async () => {
    const data = temp("repos-clean");
    const manager = new PluginRepositoryManager(data, temp("official"));
    await expect(manager.add("https://127.0.0.1:1/plugins.git")).rejects.toBeTruthy();
    const leftovers = fs.readdirSync(path.join(data, "plugin-repositories")).filter((entry) => entry.startsWith(".staging-"));
    expect(leftovers).toEqual([]);
  });

  it("reports a missing repository instead of pretending to update it", async () => {
    const manager = new PluginRepositoryManager(temp("repos-missing"), temp("official"));
    await expect(manager.refresh("does-not-exist")).rejects.toThrow(/not found/);
  });
});
