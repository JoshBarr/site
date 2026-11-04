// What the scene is still streaming in, for the loading spinner. The tile
// caches register how many loads they have in flight; one-off fetches, like
// the manifests, count until they settle.

const sources = new Set<() => number>();

/** Counts `inFlight()` as loading until the returned function is called. */
export function addLoadingSource(inFlight: () => number) {
  sources.add(inFlight);

  return () => {
    sources.delete(inFlight);
  };
}

/** Counts `promise` as loading until it settles. */
export function track<T>(promise: Promise<T>): Promise<T> {
  const done = addLoadingSource(() => 1);
  promise.then(done, done);

  return promise;
}

/** Loads in flight across the scene. */
export function loadingCount() {
  let count = 0;

  for (const inFlight of sources) count += inFlight();

  return count;
}
