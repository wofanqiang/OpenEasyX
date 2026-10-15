import type { Database } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";
import type { LiveCamService } from "./live-cams.js";

/** Favorite reconciliation is optional startup work, never a prerequisite for serving the UI. */
export function restoreLiveCamPerformers(db: Database, plugins: PluginManager, liveCams: LiveCamService,
  report: (error: unknown, providerId: string, username: string) => void) {
  for (const favorite of db.listLiveCamFavorites()) {
    const entry = plugins.list().find((entry) => entry.manifest.id === favorite.providerId && entry.installed && entry.enabled);
    if (!entry) continue;
    try { liveCams.createPerformer(favorite.providerId, { ...favorite, id: favorite.camId, online: false }); }
    catch (error) { report(error, favorite.providerId, favorite.username); }
  }
}
