export const CONTROLS_HIDE_DELAY_MS = 2500;

type AutoHideOptions = {
  show: () => void;
  hide: () => void;
  /** True while playback is paused; the controls then stay visible. */
  paused: () => boolean;
  /** True while something (such as the subtitle menu) needs the controls to stay open. */
  pinned: () => boolean;
  delay?: number;
};

/**
 * Shows the player controls on activity and hides them again after a short idle period while the
 * video plays. The timer is only restarted by `reveal` (pointer, touch or keyboard activity), never
 * by playback progress, so the progress bar disappears in fullscreen as expected.
 */
export function createControlsAutoHide({ show, hide, paused, pinned, delay = CONTROLS_HIDE_DELAY_MS }: AutoHideOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const reveal = () => {
    show(); cancel();
    if (paused()) return;
    timer = setTimeout(() => { timer = undefined; if (!paused() && !pinned()) hide(); }, delay);
  };
  return { reveal, cancel };
}
