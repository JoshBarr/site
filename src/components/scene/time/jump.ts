import { useCallback, useEffect, useRef, useState } from "react";
import { REPLAY } from "../../../lib/replay";
import { setSceneTime } from "../clock";

// Jumping the scene to a moment: each jump has every layer read its window
// from the table, uncached, so they're kept a few seconds apart.

/**
 * Jumps are at least this far apart, ms. A pick sooner waits for it, and
 * a newer pick in the meantime replaces it.
 */
const GAP = 5000;

/** Picked times are kept this far inside the logs, ms, for the trails. */
export const MARGIN = 15 * 60_000;

/** A pick this close to now is now: live. */
const NEAR_NOW = 2 * 60_000;

/** Puts the scene's time in the address as `?t=`, or takes it out for now. */
function setAddress(time: number | null) {
  const url = new URL(location.href);

  if (time === null) url.searchParams.delete("t");
  else url.searchParams.set("t", new Date(time).toISOString());
  // Next keeps its own state in the history entry.
  history.replaceState(history.state, "", url);
}

/** Sets the scene to `time`, kept inside the logs, or now with null. */
function go(time: number | null) {
  const wall = Date.now();

  if (time === null || time >= wall - NEAR_NOW) {
    setSceneTime(null);
    setAddress(null);
  } else {
    const kept = Math.max(time, wall - REPLAY + MARGIN);

    setSceneTime(kept);
    setAddress(kept);
  }
}

/**
 * `jump(time)` sets the scene to `time` (epoch ms), or live with null, as
 * soon as it may; `waiting` is the time it's waiting to jump to, if any.
 */
export function useJump() {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [waiting, setWaiting] = useState<number | null>(null);

  const jump = useCallback((time: number | null) => {
    clearTimeout(timer.current);

    const wait = last.current + GAP - Date.now();

    const now = () => {
      last.current = Date.now();
      setWaiting(null);
      go(time);
    };

    if (wait <= 0) {
      now();
    } else {
      setWaiting(time ?? Date.now());
      timer.current = setTimeout(now, wait);
    }
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { jump, waiting };
}
