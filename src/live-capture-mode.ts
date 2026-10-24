/**
 * The live capture modes the settings page offers, and the normalisation that keeps it honest.
 *
 * The ids are exactly the server's `liveCaptureInput` enum (`settingsSchema` in
 * `server/output-settings.ts`). They live in their own module rather than inline in the settings
 * JSX so a test can hold both ends together: a mode offered here and unknown to the server fails
 * `PUT /api/settings` with a 400, which surfaces as "settings will not save" and says nothing about
 * the cause.
 */
export type LiveCaptureInput = "split" | "master" | "auto";

/** What every install recorded with before the setting existed, so it stays the default. */
export const LIVE_CAPTURE_INPUT_DEFAULT: LiveCaptureInput = "split";

export type LiveCaptureInputOption = { id: LiveCaptureInput; label: string; description: string };

/**
 * The labels describe the trade-off rather than the mechanism: the choice is not about features,
 * it is about one mode removing the other's A/V drift at its source.
 */
export const liveCaptureInputOptions: readonly LiveCaptureInputOption[] = [
  {
    id: "split",
    label: "Two inputs (separate renditions)",
    description: "Records the video and audio renditions as two independent inputs. Everything recorded before this setting existed worked this way. The two inputs start at different live edges, so the capture carries a constant offset that is measured during recording and corrected when the file is remuxed -- which re-encodes the audio.",
  },
  {
    id: "master",
    label: "One input (master playlist)",
    description: "Records through the built-in HLS proxy, which serves a single playlist naming both renditions. One demuxer keeps them on one timeline, so there is no offset to measure or correct and the audio is copied instead of re-encoded. Slightly more work for the server, since the stream passes through it.",
  },
  {
    id: "auto",
    label: "Automatic",
    description: "Uses one master playlist whenever the stream has a separate audio rendition, and two inputs otherwise. Falls back on its own when the proxy cannot serve it, so a recording never fails because of this setting.",
  },
];

/**
 * A stored value as a mode the select can show and the server will accept.
 *
 * A blank select is worse than it looks: the right value would have to be guessed back, and because
 * the whole automation panel saves in one request, one unrecognised value rejects every other setting
 * alongside it. Anything unknown reads as the default instead.
 */
export function captureMode(value: unknown): LiveCaptureInput {
  return liveCaptureInputOptions.some((mode) => mode.id === value) ? (value as LiveCaptureInput) : LIVE_CAPTURE_INPUT_DEFAULT;
}
