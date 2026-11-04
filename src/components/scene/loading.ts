// What the scene is still streaming in, for the loading spinner and the
// homepage's progress. The tile caches register how many loads they have in
// flight, and how many more they've been asked for and not yet started, and
// count each one done; one-off fetches, like the manifests, count until they
// settle.

interface Source {
  inFlight: () => number;
  queued: () => number;
}

const sources = new Set<Source>();

/** Loads done since the scene started, for progress. */
let loaded = 0;

/**
 * Counts `inFlight()` as loading, and `queued()` as still to come, until the
 * returned function is called.
 */
export function addLoadingSource(
  inFlight: () => number,
  queued: () => number = () => 0
) {
  const source = { inFlight, queued };
  sources.add(source);

  return () => {
    sources.delete(source);
  };
}

/** Counts a load as done, whether it worked or not. */
export function countLoaded() {
  loaded++;
}

/** Counts `promise` as loading until it settles. */
export function track<T>(promise: Promise<T>): Promise<T> {
  const remove = addLoadingSource(() => 1);

  const done = () => {
    remove();
    countLoaded();
  };

  promise.then(done, done);

  return promise;
}

/** Loads in flight across the scene. */
export function loadingCount() {
  let count = 0;

  for (const { inFlight } of sources) count += inFlight();

  return count;
}

/**
 * How far through what's been asked for so far, 0..1. What's asked for grows
 * as finer tiles are wanted, so this can fall back.
 */
export function loadedShare() {
  let outstanding = 0;

  for (const { inFlight, queued } of sources) {
    outstanding += inFlight() + queued();
  }

  return loaded + outstanding ? loaded / (loaded + outstanding) : 0;
}

/**
 * Whether the first view has loaded. Until it has, layers load only what the
 * camera sees, so it arrives sooner; what's out of view for when the camera
 * moves, like the whole city's buildings, waits for it.
 */
let firstViewLoaded = false;

export function hasFirstViewLoaded() {
  return firstViewLoaded;
}

/** How far the first view has loaded, 0..1, only ever rising. */
let progress = 0;
const listeners = new Set<() => void>();

export function firstViewProgress() {
  return progress;
}

export function setFirstViewProgress(value: number) {
  if (value === progress) return;
  progress = value;

  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the first view's progress changes. */
export function subscribeFirstViewProgress(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** When a scene starts over. */
export function startFirstView() {
  firstViewLoaded = false;
  loaded = 0;
  setFirstViewProgress(0);
}

/** Once its view is in. */
export function finishFirstView() {
  firstViewLoaded = true;
  setFirstViewProgress(1);
}
