import type { PerformerConflict } from "../packages/profile-identity.js";

export class PerformerConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "PERFORMER_IDENTITY_CONFLICT";
  constructor(readonly conflict: PerformerConflict) {
    super(`This account is already linked to ${conflict.existingPerformer.name}. Are these the same person?`);
  }
}
