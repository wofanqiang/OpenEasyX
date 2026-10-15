import fs from "node:fs";
import path from "node:path";
import type { Database } from "./database.js";
import type { PluginContext, EasyXPlugin } from "../packages/plugin-sdk/index.js";

export class SourceSync {
  readonly active = new Set<string>();
  constructor(private db: Database, private mediaRoot: string,
    private scraper: (pluginId: string, url: string) => EasyXPlugin,
    private context: (pluginId: string) => PluginContext,
    private applyDates: (ids: string[]) => Promise<unknown>) {}

  async sync(sourceId: string, hardRefresh = false) {
    if (this.active.has(sourceId)) throw Object.assign(new Error("This source is already being scanned"), { statusCode: 409 });
    const source = this.db.getSource(sourceId);
    if (!source) throw Object.assign(new Error("Source not found"), { statusCode: 404 });
    if (!source.scraperPluginId) throw Object.assign(new Error("Select a scraper plugin for this URL first"), { statusCode: 409 });
    const plugin = this.scraper(source.scraperPluginId, source.profileUrl);
    if (!plugin.listMedia) throw Object.assign(new Error("This plugin does not list media"), { statusCode: 409 });
    this.active.add(sourceId);
    try {
      // Plugins receive a fresh source, without the previous scan watermark.
      const candidates = await plugin.listMedia(this.context(source.scraperPluginId), hardRefresh
        ? { ...source, lastSyncedAt: undefined, nextSyncAt: undefined } : source);
      const current = this.db.getSource(sourceId);
      if (!current || current.profileUrl !== source.profileUrl || current.scraperPluginId !== source.scraperPluginId) {
        throw Object.assign(new Error("Source changed during the scan; run it again"), { statusCode: 409 });
      }
      const scanCandidates = this.db.liveScanCandidates(current, candidates);
      const dates: string[] = [];
      const result = hardRefresh
        ? this.db.hardRefreshItems(current, scanCandidates, (item) => {
          if (!item.storagePath) return false;
          try { const stat = fs.statSync(path.join(this.mediaRoot, item.storagePath)); return stat.isFile() && stat.size > 0; }
          catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
        }, (id) => dates.push(id))
        : this.db.ingestItems(current, scanCandidates, (id) => dates.push(id));
      await this.applyDates(dates);
      this.db.markSourceSynced(source.id, current.syncIntervalSeconds);
      return { ...result, skipped: result.skipped + candidates.length - scanCandidates.length, total: candidates.length };
    } catch (error) {
      this.db.markSourceSynced(source.id, source.syncIntervalSeconds, error instanceof Error ? error.message : String(error));
      throw error;
    } finally { this.active.delete(sourceId); }
  }
}
