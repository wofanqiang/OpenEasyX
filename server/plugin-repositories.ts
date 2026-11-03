import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type RepositoryPlugin = {
  /** The plugin's own identifier, when the repository states it without running the code. */
  id: string;
  name: string;
  version: string;
  directory: string;
};

export type PluginRepository = {
  id: string;
  name: string;
  url: string;
  official: boolean;
  removable: boolean;
  addedAt: string;
  updatedAt: string;
  pluginCount?: number;
  /**
   * The commit the checkout was taken from. A repository is a moving target, so this is what
   * makes "what is installed" a question with an answer.
   */
  commit?: string;
  /** The plugins the checkout holds, read from the repository itself without running any of them. */
  plugins?: RepositoryPlugin[];
};

/**
 * What an update would bring, before anything changes.
 *
 * The point of asking first is that an update replaces code that runs inside the server. The
 * operator sees the new commit and the files that differ, and decides.
 */
export type RepositoryUpdate = {
  id: string;
  currentCommit?: string;
  newCommit?: string;
  /** The files that differ, when the previous commit is still reachable in the repository. */
  changedFiles?: string[];
  changedCount: number;
  plugins: RepositoryPlugin[];
};

type StoredRepository = Omit<PluginRepository, "official" | "removable" | "pluginCount">;

const OFFICIAL: PluginRepository = {
  id: "official",
  name: "OpenEasyX Official",
  url: process.env.OPEN_EASYX_OFFICIAL_REPOSITORY?.trim() || "https://github.com/raccommode/OpenEasyX",
  official: true,
  removable: false,
  addedAt: "built-in",
  updatedAt: "built-in",
};

function repositoryName(url: string) {
  return url.replace(/\/$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/i, "") || "Plugin repository";
}

/**
 * A repository address the server will clone from.
 *
 * Plain HTTP is refused. A clone over HTTP can be rewritten on the way, and what arrives is code
 * the server runs -- so a repository that can only be fetched in clear text is a repository whose
 * contents nobody can vouch for. HTTPS, SSH and Git are the ways to fetch a repository whose
 * contents stay what the author published.
 */
function validateGitUrl(raw: string) {
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\0\r\n]/.test(value)) throw Object.assign(new Error("Enter a valid Git repository URL"), { statusCode: 400 });
  if (/^[\w.-]+@[\w.-]+:[\w./-]+(?:\.git)?$/i.test(value)) return value;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw Object.assign(new Error("Use an HTTPS, SSH, or Git repository URL"), { statusCode: 400 }); }
  if (!["https:", "ssh:", "git:"].includes(parsed.protocol) || !parsed.hostname) throw Object.assign(new Error("Use an HTTPS, SSH, or Git repository URL"), { statusCode: 400 });
  if (parsed.protocol === "https:" && (parsed.username || parsed.password)) throw Object.assign(new Error("Repository URLs cannot contain credentials"), { statusCode: 400 });
  return value;
}

function pluginRoots(checkout: string) {
  const roots = [checkout, path.join(checkout, "plugins")].filter((candidate) => fs.existsSync(candidate));
  return roots.filter((root) => fs.readdirSync(root, { withFileTypes: true }).some((entry) => entry.isDirectory()
    && ["index.ts", "index.mjs", "index.js"].some((name) => fs.existsSync(path.join(root, entry.name, name)))));
}

/**
 * The plugins a checkout holds, described without running any of them.
 *
 * A plugin states what it is in a manifest next to its entry point. Reading that file costs
 * nothing but a disk read; importing the module would run whatever the author wrote, in the server
 * process, before anyone had seen what was installed. A repository that ships no manifest is
 * still listed -- by its directory name -- so the operator can see that something is there.
 */
export function repositoryPlugins(checkout: string): RepositoryPlugin[] {
  const found: RepositoryPlugin[] = [];
  for (const root of pluginRoots(checkout)) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, entry.name);
      if (!["index.ts", "index.mjs", "index.js"].some((name) => fs.existsSync(path.join(directory, name)))) continue;
      let manifest: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
      } catch { /* no manifest: the directory name is all we can say without running the code */ }
      const name = typeof manifest.name === "string" ? manifest.name : entry.name;
      const version = typeof manifest.version === "string" ? manifest.version : "";
      found.push({ id: typeof manifest.id === "string" ? manifest.id : entry.name, name, version, directory: entry.name });
    }
  }
  return found;
}

async function commitOf(directory: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("git", ["-C", directory, "rev-parse", "HEAD"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const commit = stdout.trim();
    return /^[0-9a-f]{7,40}$/.test(commit) ? commit : undefined;
  } catch { return undefined; }
}

export class PluginRepositoryManager {
  private readonly configFile: string;
  private readonly checkoutRoot: string;

  constructor(private readonly dataDir: string, private readonly officialRoot: string, private readonly legacyRoot?: string) {
    this.configFile = path.join(dataDir, "plugin-repositories.json");
    this.checkoutRoot = path.join(dataDir, "plugin-repositories");
    fs.mkdirSync(this.checkoutRoot, { recursive: true, mode: 0o700 });
  }

  private stored(): StoredRepository[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configFile, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string" && typeof entry.url === "string") : [];
    } catch { return []; }
  }

  private save(repositories: StoredRepository[]) {
    const temporary = `${this.configFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(repositories, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.configFile);
    fs.chmodSync(this.configFile, 0o600);
  }

  private checkout(id: string) { return path.join(this.checkoutRoot, id); }

  /** A directory the clone lands in first, and is only moved into place once it checks out. */
  private staging(id: string) { return path.join(this.checkoutRoot, `.staging-${id}-${process.pid}`); }

  roots() {
    const dynamic = this.stored().flatMap((entry) => pluginRoots(this.checkout(entry.id)));
    return [this.officialRoot, ...(this.legacyRoot ? [this.legacyRoot] : []), ...dynamic];
  }

  list(): PluginRepository[] {
    const count = (roots: string[]) => roots.reduce((total, root) => (fs.existsSync(root)
      ? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && ["index.ts", "index.mjs", "index.js"].some((name) => fs.existsSync(path.join(root, entry.name, name)))).length
      : 0), 0);
    return [
      { ...OFFICIAL, pluginCount: count([this.officialRoot]) },
      ...this.stored().map((entry) => ({
        ...entry,
        official: false,
        removable: true,
        pluginCount: count(pluginRoots(this.checkout(entry.id))),
        plugins: repositoryPlugins(this.checkout(entry.id)),
      })),
    ];
  }

  /**
   * Fetch a repository into a staging directory and only move it into place once it checks out.
   *
   * The clone lands beside the live checkout, is checked for plugins, and only then replaces it.
   * A repository that turns out to hold nothing usable therefore leaves the installed one alone
   * instead of replacing it with an empty directory.
   */
  async add(rawUrl: string, rawName?: string) {
    const url = validateGitUrl(rawUrl);
    if (this.stored().some((entry) => entry.url.toLowerCase() === url.toLowerCase())) throw Object.assign(new Error("This plugin repository is already installed"), { statusCode: 409 });
    await exec("git", ["ls-remote", "--exit-code", url, "HEAD"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    const id = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    const checkout = this.checkout(id);
    const staging = this.staging(id);
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      await exec("git", ["clone", "--depth", "1", "--no-tags", "--", url, staging], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      if (!pluginRoots(staging).length) throw new Error("No OpenEasyX plugins were found. Put plugins in the repository root or in a plugins/ directory.");
      const commit = await commitOf(staging);
      fs.rmSync(checkout, { recursive: true, force: true });
      fs.renameSync(staging, checkout);
      const stamp = new Date().toISOString();
      const entry: StoredRepository = { id, name: rawName?.trim().slice(0, 120) || repositoryName(url), url, addedAt: stamp, updatedAt: stamp, commit };
      this.save([...this.stored(), entry]);
      return this.list().find((repository) => repository.id === id)!;
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * What an update would bring, or the update itself.
   *
   * Without `confirm` nothing changes and nothing is run: the new commit and the files that differ
   * are worked out in a staging clone and reported back. With it, the new tree replaces the old
   * one -- still by way of the staging directory, so a repository that has gone bad leaves the
   * installed version in place.
   */
  async refresh(id: string, confirm = false): Promise<RepositoryUpdate | PluginRepository> {
    const repositories = this.stored();
    const index = repositories.findIndex((entry) => entry.id === id);
    if (index < 0) throw Object.assign(new Error("Plugin repository not found"), { statusCode: 404 });
    const checkout = this.checkout(id);
    const currentCommit = repositories[index].commit ?? await commitOf(checkout);
    const staging = this.staging(id);
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      await exec("git", ["clone", "--depth", "1", "--no-tags", "--", repositories[index].url, staging], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const newCommit = await commitOf(staging);
      if (!pluginRoots(staging).length) throw new Error("The updated repository no longer contains OpenEasyX plugins");
      const plugins = repositoryPlugins(staging);
      let changedFiles: string[] | undefined;
      if (currentCommit && newCommit && currentCommit !== newCommit) {
        try {
          await exec("git", ["-C", staging, "fetch", "--depth", "1", "origin", currentCommit], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
          const { stdout } = await exec("git", ["-C", staging, "diff", "--name-only", currentCommit, newCommit], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
          changedFiles = stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 200);
        } catch { /* the previous commit is no longer reachable: say how much changed, not which */ }
      }
      if (!confirm) {
        return { id, currentCommit, newCommit, changedFiles, changedCount: changedFiles?.length ?? 0, plugins };
      }
      const retired = `${checkout}.retired-${Date.now()}`;
      fs.renameSync(checkout, retired);
      try {
        fs.renameSync(staging, checkout);
      } catch (error) {
        fs.renameSync(retired, checkout);
        throw error;
      }
      fs.rmSync(retired, { recursive: true, force: true });
      repositories[index] = { ...repositories[index], updatedAt: new Date().toISOString(), commit: newCommit };
      this.save(repositories);
      return this.list().find((repository) => repository.id === id)!;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  remove(id: string) {
    const repositories = this.stored();
    if (!repositories.some((entry) => entry.id === id)) throw Object.assign(new Error("Plugin repository not found"), { statusCode: 404 });
    this.save(repositories.filter((entry) => entry.id !== id));
    fs.rmSync(this.checkout(id), { recursive: true, force: true });
    return { removed: true, id };
  }
}
