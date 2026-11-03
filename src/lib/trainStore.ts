import { foldTrails, type Poll } from "./fold";
import type { LiveData, trains } from "./liveRecords";
import { isStale, Train, TRAIL } from "./trains";

// Trains as the scene draws them, from the AWS poller's log of Metlink's
// answers (see plans/dynamo.md).

/**
 * The trains in the newest of `polls` (oldest first) that are recent enough
 * to show, each with its fixes from the last TRAIL as its trail.
 */
export function foldTrains(
  polls: Poll<LiveData<typeof trains>>[],
  now = Date.now()
): Train[] {
  return foldTrails(
    polls.map(({ data }) => data.trains),
    now - TRAIL
  ).filter((train) => !isStale(train, now));
}
