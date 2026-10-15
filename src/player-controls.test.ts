import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlsAutoHide, CONTROLS_HIDE_DELAY_MS } from "./player-controls";

function setup(state = { paused: false, pinned: false }) {
  const show = vi.fn(); const hide = vi.fn();
  const controls = createControlsAutoHide({ show, hide, paused: () => state.paused, pinned: () => state.pinned });
  return { show, hide, controls, state };
}

afterEach(() => vi.useRealTimers());

describe("player controls auto-hide", () => {
  it("hides the controls after the idle delay while playing", () => {
    vi.useFakeTimers();
    const { show, hide, controls } = setup();
    controls.reveal();
    expect(show).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(CONTROLS_HIDE_DELAY_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledOnce();
  });

  it("keeps hiding even though playback progress keeps updating", () => {
    vi.useFakeTimers();
    const { hide, controls } = setup();
    controls.reveal();
    for (let tick = 0; tick < 20; tick += 1) vi.advanceTimersByTime(250); // timeupdate cadence
    expect(hide).toHaveBeenCalledOnce();
  });

  it("restarts the idle delay on new activity", () => {
    vi.useFakeTimers();
    const { hide, controls } = setup();
    controls.reveal(); vi.advanceTimersByTime(CONTROLS_HIDE_DELAY_MS - 100);
    controls.reveal(); vi.advanceTimersByTime(CONTROLS_HIDE_DELAY_MS - 100);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(hide).toHaveBeenCalledOnce();
  });

  it("keeps the controls visible while paused or while a menu is open", () => {
    vi.useFakeTimers();
    const paused = setup({ paused: true, pinned: false }); paused.controls.reveal();
    const pinned = setup({ paused: false, pinned: true }); pinned.controls.reveal();
    vi.advanceTimersByTime(CONTROLS_HIDE_DELAY_MS * 3);
    expect(paused.hide).not.toHaveBeenCalled();
    expect(pinned.hide).not.toHaveBeenCalled();
  });

  it("cancel stops a pending hide", () => {
    vi.useFakeTimers();
    const { hide, controls } = setup();
    controls.reveal(); controls.cancel();
    vi.advanceTimersByTime(CONTROLS_HIDE_DELAY_MS * 2);
    expect(hide).not.toHaveBeenCalled();
  });
});
