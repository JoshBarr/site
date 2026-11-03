// Replaying the live layers from a moment in the past: the API routes take
// `?at=<epoch ms>` and serve each layer as it was then, from the poller's
// logs (see plans/dynamo.md), which are kept for REPLAY.

/** How far back the scene can be replayed: as long as the logs are kept. */
export const REPLAY = 30 * 86_400_000;

/**
 * A moment this close to now may still have polls coming in (vessels and
 * traffic are polled each minute), so it's cached as briefly as live.
 */
const SETTLED = 2 * 60_000;

/** A browser's clock running this far ahead is still asking for now. */
const AHEAD = 60_000;

/**
 * The moment a request's `?at=` asks for, epoch ms: undefined without one
 * (live), null if it's not a time that can be replayed.
 */
export function replayTime(
  at: string | string[] | undefined,
  now = Date.now()
): number | null | undefined {
  if (at === undefined) return undefined;

  const time = Number(at);

  if (
    !Number.isSafeInteger(time) ||
    time < now - REPLAY ||
    time > now + AHEAD
  ) {
    return null;
  }

  return Math.min(time, now);
}

/**
 * Cache-Control for a layer at `at`: `live`'s for now and the last few
 * minutes, and a day once every poll up to `at` is in, since it won't change.
 */
export const cacheFor = (
  live: string,
  at: number | undefined,
  now = Date.now()
) => (at !== undefined && at < now - SETTLED ? "public, s-maxage=86400" : live);
