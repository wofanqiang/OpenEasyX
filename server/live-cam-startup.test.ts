import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "./database.js";
import { LiveCamService } from "./live-cams.js";
import { PluginManager } from "./plugin-manager.js";
import { PerformerConflictError } from "./performer-conflict.js";
import { profileIdentity } from "../packages/profile-identity.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/**
 * A favorite is a bookmark, not a member of the performer list.
 *
 * The startup pass that used to materialize a performer for every favorite was removed: it made
 * "delete performer" undo itself on the next restart, which is the one thing the two entities being
 * independent was supposed to prevent. What remains to protect is the data underneath -- legacy
 * databases can hold the same account twice, and a room is still materialized on demand when it is
 * recorded or armed -- so these tests drive `createPerformer` directly and check that a real server
 * boots against dirty data without inventing performers for favorites nobody has recorded.
 */
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyx-live-startup-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), pluginRoot = path.join(root, "plugins");
  const pluginDir = path.join(pluginRoot, "live"); fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.mjs"), `export default { manifest: { id: "test.startup", name: "Startup", version: "1", description: "Test", author: "Test", capabilities: ["live-cam"], sourceUrlPatterns: ["https://chaturbate.com/*"] }, listLiveCams: async () => ({ cams: [], total: 0, page: 1, pageSize: 24, pages: 1 }), resolveLiveStream: async () => ({ url: "https://cdn.test/live.m3u8" }) };`);
  const db = new Database(data); cleanups.push(() => db.close());
  const plugins = new PluginManager(db, [pluginRoot]); await plugins.load(); plugins.install("test.startup");
  const service = new LiveCamService(db, plugins);
  const cam = (username: string) => ({ id: username, username, pageUrl: `https://chaturbate.com/${username}/`, online: false });
  const source = (id: string, externalId: string, url: string) => db.addSource(id, "test.startup", { externalId, label: externalId, profileUrl: url, domain: "chaturbate.com" });
  const owner = db.createPerformer({ name: "Cherry Crush" });
  const original = source(owner.id, "reference", cam("cherrycrush").pageUrl);
  const legacy = db.upsertPerformer({ externalId: "cherrycrush", name: "cherrycrush" }, "test.startup");
  const duplicate = source(legacy.id, "cherrycrush", "https://chaturbate.com/old-cherry/");
  // Old databases can already contain the same account under two different names.
  db.sqlite.prepare("UPDATE sources SET profile_url=?,profile_key=? WHERE id=?").run(original.profileUrl, profileIdentity(original.profileUrl)!, duplicate.id);
  db.setLiveCamFavorite("test.startup", { ...cam("cherrycrush"), camId: "cherrycrush" }, true);
  return { root, data, pluginRoot, db, plugins, service, cam, source, owner, legacy, duplicate };
}

describe("favorites and performers", () => {
  it("refreshes a legacy shared account without merging it or losing its conflict notice", async () => {
    const { db, plugins, service, duplicate, legacy, cam } = await fixture();
    expect(() => service.createPerformer("test.startup", cam("cherrycrush"))).not.toThrow();
    expect(db.listPerformers()).toHaveLength(2);
    expect(db.listSources()).toHaveLength(2);
    expect(db.getSource(duplicate.id)?.performerId).toBe(legacy.id);
    expect(db.sourceConflicts(legacy.id)).toEqual([expect.objectContaining({ existingPerformer: expect.objectContaining({ name: "Cherry Crush" }) })]);
    // URL formatting changes do not create a new account association either.
    expect(() => service.createPerformer("test.startup", { ...cam("cherrycrush"), pageUrl: "https://chaturbate.com/CHERRYCRUSH?utm_source=test" })).not.toThrow();
    plugins.get("test.startup").listFollowedLiveCams = async () => ({ authoritative: true, cams: [cam("cherrycrush"), cam("healthy")] });
    await expect(service.syncFavorites("test.startup")).resolves.toMatchObject({ authoritative: true, synced: 2 });
    expect(db.getPerformerByName("healthy")).toBeDefined();
  });

  it("raises a genuinely new conflict instead of merging two people, and keeps manual reassignment closed", async () => {
    const { db, service, cam, source, legacy } = await fixture();
    source(legacy.id, "other-owned", cam("blocked").pageUrl);
    const blocked = db.upsertPerformer({ externalId: "blocked", name: "blocked" }, "test.startup");
    const previous = source(blocked.id, "blocked", "https://chaturbate.com/previous/");
    for (const username of ["blocked", "healthy"]) db.setLiveCamFavorite("test.startup", { ...cam(username), camId: username }, true);
    let thrown: unknown;
    try { service.createPerformer("test.startup", cam("blocked")); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(PerformerConflictError);
    expect((thrown as PerformerConflictError).code).toBe("PERFORMER_IDENTITY_CONFLICT");
    expect((thrown as PerformerConflictError).conflict.existingPerformer.name).toBeDefined();
    expect(db.getSource(previous.id)?.profileUrl).toBe("https://chaturbate.com/previous/");
    expect(() => db.updateSource(previous.id, { profileUrl: cam("blocked").pageUrl })).toThrow("already linked");
    expect(() => db.addSource(blocked.id, "another", { externalId: "duplicate", label: "Duplicate", domain: "chaturbate.com", profileUrl: cam("cherrycrush").pageUrl })).toThrow("already linked");
  });

  it("starts against legacy duplicates and an invalid favorite without inventing performers for them", async () => {
    const { root, data, pluginRoot, db, cam } = await fixture();
    db.setLiveCamFavorite("test.startup", { camId: "broken", username: "broken", pageUrl: "https://unsupported.test/broken" }, true);
    db.setLiveCamFavorite("test.startup", { ...cam("healthy"), camId: "healthy" }, true);
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: process.cwd(), env: { ...process.env,
      PORT: "0", EASYX_DATA_DIR: data, EASYX_MEDIA_DIR: path.join(root, "media"), EASYX_EXTERNAL_PLUGINS_DIR: pluginRoot,
      EASYX_EMBEDDED_SUBTITLE_WORKER: "false", EASYX_ADMIN_PASSWORD: "startup-test-passphrase" }, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => { if (child.exitCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; } });
    let logs = "";
    const address = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${logs}`)), 15_000);
      const output = (chunk: Buffer) => {
        logs += chunk.toString(); const match = logs.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      };
      child.stdout.on("data", output); child.stderr.on("data", output);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Startup exited ${code}: ${logs}`)); });
    });
    expect(await (await fetch(`${address}/api/health`)).json()).toMatchObject({ ok: true });

    // The guard for this change: a favorite nobody has recorded stays a bookmark. Read straight off
    // the running server's database so it reflects what startup actually did.
    const reader = new DatabaseSync(path.join(data, "easyx.sqlite"), { readOnly: true });
    const names = reader.prepare("SELECT lower(name) AS name FROM performers").all().map((row) => String((row as { name: string }).name));
    reader.close();
    expect(names.sort()).toEqual(["cherry crush", "cherrycrush"]);
    expect(names).not.toContain("healthy");
    expect(names).not.toContain("broken");

    // This fork gates every /api route behind a session (upstream has no auth hook), so the test
    // logs in with the seeded admin password and carries the cookie on the GET.
    const login = await fetch(`${address}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "startup-test-passphrase" }) });
    expect(login.ok).toBe(true);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("easyx_session=");
  }, 25_000);
});
