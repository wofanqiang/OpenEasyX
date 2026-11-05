/**
 * Wording for the marker that says a recording fell short of the session it captured.
 *
 * Three places rely on this text and must not invent their own: the recorder detects a shortfall
 * while it finalizes, the one-time backfill promotes the older `truncated`/`videoTruncated` flags
 * already on disk, and the Activity page and the library card show the words verbatim. One place
 * for the wording, or the paths drift apart and a card ends up describing something else.
 */
export type ShortfallFacts = {
  /** How long the session ran, by the wall clock. */
  expectedSec?: number;
  /** How much media the capture actually holds. */
  actualSec?: number;
  /** How long the container is, which for a live capture is the audio track's length. */
  containerSec?: number;
  /** How long the video track itself survived. */
  videoSec?: number;
};

export function shortfallReason(facts: ShortfallFacts): string | undefined {
  const parts: string[] = [];
  if (facts.actualSec !== undefined && facts.expectedSec !== undefined) {
    parts.push(`captured ${Math.round(facts.actualSec)}s of a ${Math.round(facts.expectedSec)}s session`);
  }
  if (facts.videoSec !== undefined && facts.containerSec !== undefined) {
    parts.push(`picture stopped at ${Math.round(facts.videoSec)}s of ${Math.round(facts.containerSec)}s`);
  }
  return parts.length ? parts.join("; ") : undefined;
}
