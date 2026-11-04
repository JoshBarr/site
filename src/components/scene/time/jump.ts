import { useSyncExternalStore } from "react";
import { REPLAY } from "../../../lib/replay";
import { setSceneTime } from "../clock";

// Jumping the scene to a moment: each jump has every layer read its window
// from the table, uncached, so they're kept a few seconds apart. One for the
// page, so the drawer and the controls' Back to live share the wait.

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

let last = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The time it's waiting to jump to, if any. */
let waiting: number | null = null;
const listeners = new Set<() => void>();

function setWaiting(time: number | null) {
  waiting = time;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/**
 * Sets the scene to `time` (epoch ms) as soon as it may, or straight back
 * to live with null: live layers don't read the table.
 */
export function jump(time: number | null) {
  clearTimeout(timer);

  const now = () => {
    if (time !== null) last = Date.now();
    setWaiting(null);
    go(time);
  };

  const wait = last + GAP - Date.now();

  if (time === null || wait <= 0) {
    now();
  } else {
    setWaiting(time);
    timer = setTimeout(now, wait);
  }
}

/** The time a jump's waiting to go to, if any. */
export const useWaiting = () =>
  useSyncExternalStore(
    subscribe,
    () => waiting,
    () => null
  );
