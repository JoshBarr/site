// The ring under a held press: it closes in as the press is held, then
// pulses as the orbit point's picked there, or fades if nothing could be.

/** Ring's size, px. */
const SIZE = 44;

/** Shown this far into a press, ms: a click shouldn't flash one. */
const SHOW_AFTER = 120;

export interface PressRing {
  /** The point's picked: a pulse, and gone. */
  lock(): void;
  /** Nothing to pick (the sky, or off the map): faded out. */
  miss(): void;
  /** Let go, or moved, before the hold was up. */
  cancel(): void;
}

/** A ring at `x`, `y` (client px) closing in over `hold` ms. */
export function pressRing(x: number, y: number, hold: number): PressRing {
  const ring = document.createElement("div");
  ring.setAttribute("aria-hidden", "true");

  Object.assign(ring.style, {
    position: "fixed",
    left: `${x - SIZE / 2}px`,
    top: `${y - SIZE / 2}px`,
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    borderRadius: "50%",
    border: "2px solid rgba(255, 255, 255, 0.9)",
    boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.25), 0 1px 6px rgba(0, 0, 0, 0.3)",
    pointerEvents: "none",
    opacity: "0",
    zIndex: "1",
  });

  document.body.append(ring);
  const motion = !matchMedia("(prefers-reduced-motion: reduce)").matches;

  const closing = ring.animate(
    [
      { opacity: 0, transform: `scale(${motion ? 1.8 : 1})` },
      { opacity: 1, transform: "scale(1)" },
    ],
    {
      delay: SHOW_AFTER,
      duration: Math.max(hold - SHOW_AFTER, 1),
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      fill: "forwards",
    }
  );

  // Ending the press cancels it, which rejects this (AbortError): expected,
  // and left unhandled it fails the test run.
  closing.finished.catch(() => {});

  let done = false;

  const end = (frames: Keyframe[], duration: number) => {
    if (done) return;
    done = true;
    closing.cancel();

    ring
      .animate(frames, { duration, easing: "ease-out", fill: "forwards" })
      .finished.catch(() => {})
      .finally(() => ring.remove());
  };

  return {
    lock: () =>
      end(
        [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: `scale(${motion ? 0.4 : 1})` },
        ],
        300
      ),
    miss: () =>
      end(
        [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: `scale(${motion ? 1.4 : 1})` },
        ],
        200
      ),
    cancel: () => end([{ opacity: 0 }], 0),
  };
}
