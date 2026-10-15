import { safeSegment } from "./utils.js";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./database.js";
import type { LibraryDatabase } from "./library-database.js";

export function registerPerformerMergeRoutes(app: FastifyInstance<any, any, any, any>, db: Database, library: LibraryDatabase, dataDir: string, busy: (performerId: string) => boolean = () => false) {
  const previewFor = (from: string, target: string) => { const preview = db.performerMergePreview(from, target); return { ...preview, blocked: preview.blocked || busy(from) || busy(target) }; };
  app.get<{ Params: { id: string }; Querystring: { profileUrl?: string } }>("/api/performers/:id/conflicts", async (request) => {
    if (!db.getPerformer(request.params.id)) throw Object.assign(new Error("Performer not found"), { statusCode: 404 });
    const query = z.object({ profileUrl: z.string().url().optional() }).parse(request.query);
    return { conflicts: db.sourceConflicts(request.params.id, query.profileUrl) };
  });
  app.get<{ Params: { id: string }; Querystring: { targetId: string } }>("/api/performers/:id/merge-preview", async (request) => {
    const query = z.object({ targetId: z.string().min(1) }).parse(request.query);
    return previewFor(request.params.id, query.targetId);
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/performers/:id/merge", async (request) => {
    const parsed = z.object({ targetId: z.string().min(1), confirmed: z.literal(true) }).safeParse(request.body);
    if (!parsed.success) throw Object.assign(new Error("Choose a target profile and explicitly confirm the merge"), { statusCode: 400 });
    const body = parsed.data;
    const preview = previewFor(request.params.id, body.targetId);
    if (preview.blocked) throw Object.assign(new Error("Finish active scans and finish or cancel active downloads for both performers before merging"), { statusCode: 409 });
    const from = db.getPerformer(request.params.id)!; const target = db.getPerformer(body.targetId)!;
    let imageUrl: string | undefined;
    // Copy the portrait before changing ownership; media files and paths stay intact.
    if (!target.imageUrl && from.imageUrl === `/api/performers/${from.id}/image`) {
      const previous = path.join(dataDir, "performer-images", `${from.id}.jpg`);
      if (fs.existsSync(previous)) {
        fs.copyFileSync(previous, path.join(dataDir, "performer-images", `${target.id}.jpg`));
        imageUrl = `/api/performers/${target.id}/image`;
      }
    }
    const result = db.mergePerformers(from.id, target.id, imageUrl);
    library.mergePerformerNames(from.name, target.name);
    if (safeSegment(from.name) !== from.name) library.mergePerformerNames(safeSegment(from.name), target.name);
    return result;
  });
}
