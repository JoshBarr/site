import type { Bus } from "./buses";
import { isStale, TRAIL } from "./buses";
import { foldTrails, type Poll } from "./fold";
import type { buses, LiveData } from "./liveRecords";

// Buses as the scene draws them, from the AWS poller's log of Metlink's
// answers (see plans/dynamo.md).

/**
 * The buses in the newest of `polls` (oldest first) that are recent enough
 * to show, each with its fixes from the last TRAIL as its trail. A bus
 * that's started another trip leaves the last one's trail behind.
 */
export function foldBuses(
  polls: Poll<LiveData<typeof buses>>[],
  now = Date.now()
): Bus[] {
  return foldTrails(
    polls.map(({ data }) => data.buses),
    now - TRAIL,
    (fix, latest) =>
      fix.route === latest.route && fix.direction === latest.direction
  ).filter((bus) => !isStale(bus));
}
