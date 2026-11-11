import { switchedOff } from "./stats";

// What a frame costs is nearly all per pixel, and the quality tiers are
// fixed: a machine slower than the ones they were tuned on drops frames at
// every size. So the scene's own pass (not the canvas: the clouds, the lens
// and the dither keep theirs) is drawn smaller, by what the frames take, and
// stretched back over the canvas.

/** The sizes the scene's drawn at, of the canvas's each way, largest first. */
export const SCALES = [1, 0.85, 0.7, 0.6, 0.5];

/**
 * The time between frames to hold, ms: 60 a second. A faster screen isn't
 * chased, and a slower one, or a browser holding the page to 30, is found
 * out by drawing smaller making no difference (see `futile`).
 */
const BUDGET = 1000 / 60;

/**
 * Over this many times the budget, on average, is too slow. With the frames
 * tied to the screen's refresh, the time between them only comes in whole
 * refreshes: at 1.2, a frame in five was late.
 */
const OVER = 1.2;

/** Frames are averaged over this long before anything's decided, ms. */
const WINDOW = 2000;

/**
 * Longer than this, ms, wasn't a frame: the tab came back, or something
 * loaded.
 */
const PAUSE = 250;

/** After a change, frames aren't counted for this long, ms: it hitches. */
const SETTLE = 500;

/**
 * With frames tied to the screen there's no seeing how much room there is,
 * only whether they're late. So after this long without late frames, s, the
 * next size up is tried; when that fails it's twice as long until the next
 * try, up to MAX_WAIT, and back to this when one holds.
 */
const FIRST_WAIT = 6;
const MAX_WAIT = 300;

/**
 * At the smallest size, frames must have got this much shorter than at full
 * size, or the size wasn't what made them slow: it goes back to full, and
 * what they took there becomes the budget.
 */
const GAIN = 0.15;

/** The scale the page asks for outright (?scale=0.7), or null. */
function askedScale() {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const asked = Number(params.get("scale"));

  return params.has("scale") && asked > 0 && asked <= 1 ? asked : null;
}

/**
 * Whether the scale follows the frame time here. Not for scripts driving the
 * browser: the before/after shots (and their sizes) would differ by how busy
 * the machine was. ?governor turns it on for them all the same.
 */
function governed() {
  const params = new URLSearchParams(globalThis.location?.search ?? "");

  if (switchedOff("governor") || askedScale() !== null) return false;

  return params.has("governor") || !globalThis.navigator?.webdriver;
}

let current = 1;

/** The scale the scene was last drawn at, for the frame report. */
export function renderScale() {
  return current;
}

/**
 * Picks the scene pass's scale from the time between frames. Call `frame`
 * once a frame with the time since the last, s, and whether the scene's
 * steady: on screen, loaded, and drawing as fast as it can. It answers with
 * the scale to draw this frame at, one of SCALES (or the page's ?scale=).
 */
export function createGovernor({
  fixed = askedScale(),
  on = governed(),
}: { fixed?: number | null; on?: boolean } = {}) {
  let level = 0;
  let budget = BUDGET;
  // The window so far.
  let sum = 0;
  let count = 0;
  let settling = 0;
  // Time without late frames, s, and how long it must be to try a size up.
  let calm = 0;
  let wait = FIRST_WAIT;
  // Whether the size was just stepped up, to see if it holds.
  let trying = false;
  // What frames took at full size, when they were first too slow.
  let atFull: number | null = null;

  const restart = () => {
    sum = 0;
    count = 0;
  };

  const change = (to: number) => {
    level = to;
    calm = 0;
    settling = SETTLE;
    restart();
  };

  /** A window's average, ms: what to do about it. */
  const decide = (mean: number) => {
    if (mean > budget * OVER) {
      if (trying) {
        // The size up didn't hold.
        trying = false;
        wait = Math.min(wait * 2, MAX_WAIT);
        change(level + 1);
      } else if (level < SCALES.length - 1) {
        if (level === 0) atFull = mean;
        change(level + 1);
      } else if (atFull !== null && mean > atFull * (1 - GAIN)) {
        // Futile: it's the screen, the browser or the processor.
        budget = Math.max(mean, atFull);
        atFull = null;
        change(0);
      }

      return;
    }

    if (trying) {
      trying = false;
      wait = FIRST_WAIT;
    }

    if (level === 0) return;

    calm += WINDOW / 1000;

    if (calm >= wait) {
      trying = true;
      change(level - 1);
    }
  };

  return {
    frame(delta: number, steady: boolean) {
      if (fixed !== null) return (current = fixed);

      const ms = delta * 1000;

      if (!on || !steady || ms > PAUSE) {
        restart();

        return (current = SCALES[level]);
      }

      if (settling > 0) {
        settling -= ms;

        return (current = SCALES[level]);
      }

      sum += ms;
      count++;

      if (sum >= WINDOW) {
        const mean = sum / count;

        restart();
        decide(mean);
      }

      return (current = SCALES[level]);
    },
  };
}
