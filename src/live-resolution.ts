/**
 * The recording ceilings the settings page offers, and the normalisation that keeps it honest.
 *
 * A recording follows one rendition for its whole length, so the ceiling decides the layout of
 * every segment of a broadcast. Left at "best available" the layout follows whatever the room is
 * serving at that moment, and a room that moves from 1080p to 1440p mid-show splits its recording
 * into files that no longer share a layout -- which the session splice then refuses to fold back
 * into one file. Pinning the ceiling keeps that layout stable, and 1080p is the default because it
 * leaves a full-HD broadcast untouched while a taller one no longer breaks the recording apart.
 *
 * Like `live-capture-mode.ts`, this lives in its own module so a test can hold both ends together:
 * a value offered here that the server's schema rejects fails `PUT /api/settings` with a 400.
 */
export const RECORDING_MAX_HEIGHT_DEFAULT = 1080;

export type RecordingHeightOption = { id: number; label: string; description: string };

export const recordingHeightOptions: readonly RecordingHeightOption[] = [
  {
    id: 0,
    label: "Best available",
    description: "Records whatever the room is serving, at its highest rendition. A broadcast that changes quality mid-show is then recorded at both, and the parts no longer share one layout -- they stay separate files instead of being folded into one.",
  },
  {
    id: 1440,
    label: "1440p and below",
    description: "Keeps a 1440p broadcast at full quality. Costs the most bandwidth and disk.",
  },
  {
    id: 1080,
    label: "1080p and below (default)",
    description: "Keeps a full-HD broadcast untouched and holds a taller one at 1080p, so every capture of a broadcast shares one layout and can be folded into a single file.",
  },
  {
    id: 720,
    label: "720p and below",
    description: "Roughly a third of 1080p's bandwidth. The reasonable choice when the disk or the uplink is the limit.",
  },
  {
    id: 540,
    label: "540p and below",
    description: "Small enough to keep many rooms recording at once on a thin connection.",
  },
  {
    id: 480,
    label: "480p and below",
    description: "The smallest common rung. A room that offers nothing at or below the ceiling is still recorded, at its smallest rendition.",
  },
  {
    id: 360,
    label: "360p and below",
    description: "Lowest quality offered. Useful for long unattended sessions where space matters more than detail.",
  },
];

/** The ceiling to record with; anything unrecognised falls back to the default. */
export function recordingHeight(value: unknown): number {
  // An empty control must read as "not chosen", not as 0 -- `Number("")` is 0, and 0 is a real
  // choice ("best available"), so the two would otherwise be indistinguishable.
  if (value === undefined || value === null || value === "") return RECORDING_MAX_HEIGHT_DEFAULT;
  const height = Number(value);
  return recordingHeightOptions.some((option) => option.id === height) ? height : RECORDING_MAX_HEIGHT_DEFAULT;
}
