import { useSyncExternalStore } from "react";
import { REPLAY } from "../../lib/replay";

// The scene's clock, which everything drawn goes by instead of Date.now():
// the sun, the lights, and every live layer. Now, unless the page asks for
// another moment (`?t=<ISO date>`, or picked in the time panel); then the
// layers replay from there, as the poller logged them, running on in real
// time. `?freeze` holds it still.

/** One setting of the clock: replaced each time it's set. */
export interface Seek {
  /** Scene time when it was set, ms: layers count their seconds from it. */
  epoch: number;
  /** Whether it's somewhere other than now. */
  replaying: boolean;
}

/** Scene time minus wall time, ms. */
let offset = 0;

/** The time the scene's held at, with `?freeze`. */
let frozen: number | null = null;

let seek: Seek | null = null;
const listeners = new Set<() => void>();

/** As the page asks, the first time the clock's read. */
function current() {
  if (seek) return seek;

  const params = new URLSearchParams(location.search);
  const t = params.get("t");
  const start = t ? new Date(t).getTime() : NaN;

  if (Number.isFinite(start)) offset = start - Date.now();

  if (params.has("freeze")) frozen = Date.now() + offset;

  seek = { epoch: read(), replaying: offset !== 0 || frozen !== null };

  return seek;
}

const read = () => frozen ?? Date.now() + offset;

/** Whether the clock's held still, with `?freeze`. */
export function isFrozen() {
  current();

  return frozen !== null;
}

/** The scene's time now, epoch ms. */
export function sceneNow() {
  current();

  return read();
}

/**
 * Sets the scene's clock to `time` (epoch ms), held there if it's frozen,
 * or back to now and running with null.
 */
export function setSceneTime(time: number | null) {
  current();
  offset = time === null ? 0 : time - Date.now();

  if (frozen !== null) frozen = time;

  seek = { epoch: read(), replaying: time !== null || frozen !== null };

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

const LIVE: Seek = { epoch: 0, replaying: false };

/** The clock's last setting; a new one each time it's set. */
export const useSeek = () =>
  useSyncExternalStore(subscribe, current, () => LIVE);

/**
 * Replays ask for whole steps of this, ms, so asking again within one is
 * the same request, cached.
 */
const STEP = 10_000;

/**
 * Where to fetch a live layer's `path` from for the scene's time: as it is
 * now, or replaying, as it was then (`at`, on a whole `step`). Null when
 * the scene's further back than the poller's logs go.
 */
export function layerUrl(path: string, step = STEP) {
  if (!current().replaying) return path;

  const at = Math.floor(sceneNow() / step) * step;

  if (at < Date.now() - REPLAY) return null;

  return `${path}${path.includes("?") ? "&" : "?"}at=${at}`;
}

/**
 * This browser's clock minus the server's, ms, from an answer's `time`:
 * fixes are on the server's clock. Replaying, they're on the scene's.
 */
export const skewFrom = (time: number) =>
  current().replaying ? 0 : Date.now() - time;
