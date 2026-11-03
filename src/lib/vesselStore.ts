import { byTime, type Poll } from "./fold";
import type { LiveData, vessels } from "./liveRecords";
import { fetchHarbour, fetchTrack, TrackPoint } from "./openwaters";
import {
  isStale,
  STALE_STATIONARY,
  STALE_UNDER_WAY,
  TRAIL,
  UNDER_WAY,
  Vessel,
} from "./vessels";

// Ships in the harbour from Open Waters, polled by the AWS poller and folded
// from its log into what the scene draws (see plans/dynamo.md).

/** Trail positions closer together than this, ms, are thinned out. */
const TRAIL_STEP = 10_000;

/**
 * Most tracks fetched in one poll. Open Waters allows 120 requests a
 * minute.
 */
const MAX_TRACKS = 30;

/** The newest point, and others at least TRAIL_STEP apart, from `since`. */
function thin(trail: Vessel["trail"], since: number) {
  const kept: Vessel["trail"] = [];

  for (const [i, point] of trail.entries()) {
    if (point[2] <= since) continue;
    const last = kept[kept.length - 1];

    if (!last || point[2] - last[2] >= TRAIL_STEP || i === trail.length - 1) {
      kept.push(point);
    }
  }

  return kept;
}

/**
 * A ship under way, placed by the newest position in its track, with that
 * track added to its trail. Its time is then the position's, so the scene
 * can join the trail to it.
 */
function follow(vessel: Vessel, track: TrackPoint[], since: number): Vessel {
  const latest = track[track.length - 1];

  const trail = [
    ...vessel.trail.filter(([, , time]) => time < (track[0]?.time ?? Infinity)),
    ...track.flatMap(({ position, time, speed }): Vessel["trail"] =>
      speed > UNDER_WAY ? [[...position, time]] : []
    ),
  ];

  return {
    ...vessel,
    ...(latest && {
      ...latest,
      heading: latest.heading ?? vessel.heading,
    }),
    trail: thin(trail, since),
  };
}

/** Which way a ship points, as it reports: its heading, or under way, its course. */
export const reportedHeading = (v: Vessel) =>
  v.heading ?? (v.speed > UNDER_WAY ? v.course : null);

/**
 * Fetches the harbour for the AWS poller, which stores each poll as it is
 * and leaves joining up trails to whoever reads them. Each ship under way
 * is placed by the newest point of its track since `ends` has its trail
 * ending (or the whole TRAIL), with those points as its trail.
 */
export async function pollHarbour(
  ends: ReadonlyMap<number, number>
): Promise<Vessel[]> {
  const now = Date.now();
  const fetched = await fetchHarbour(STALE_STATIONARY, STALE_UNDER_WAY);

  const since = (mmsi: number) =>
    Math.max(ends.get(mmsi) ?? -Infinity, now - TRAIL);

  // A failed track, or one past MAX_TRACKS, resumes from further back the
  // next poll.
  const tracks = new Map(
    await Promise.all(
      fetched
        .filter((v) => v.speed > UNDER_WAY)
        .slice(0, MAX_TRACKS)
        .map(async ({ mmsi }) => {
          const track = await fetchTrack(mmsi, since(mmsi)).catch((e) => {
            console.error(`[vessels] track ${mmsi}:`, e);

            return null;
          });

          return [mmsi, track] as const;
        })
    )
  );

  return fetched.map((vessel) => {
    const track = tracks.get(vessel.mmsi);

    return track ? follow(vessel, track, since(vessel.mmsi)) : vessel;
  });
}

/**
 * The ships in the newest of `polls` (oldest first) that are recent enough
 * to show, each with its tracks from the last TRAIL as its trail. The
 * newest poll may be older than that: moored ships are shown for hours.
 */
export function foldVessels(
  polls: Poll<LiveData<typeof vessels>>[],
  now = Date.now()
): Vessel[] {
  const since = now - TRAIL;
  const tracks = new Map<number, Vessel["trail"]>();

  for (const { data } of polls) {
    for (const { mmsi, trail } of data.vessels) {
      tracks.set(mmsi, [...(tracks.get(mmsi) ?? []), ...trail]);
    }
  }

  return (polls.at(-1)?.data.vessels ?? [])
    .filter((vessel) => !isStale(vessel))
    .map((vessel) => ({
      ...vessel,
      trail: byTime(tracks.get(vessel.mmsi) ?? []).filter(
        ([, , time]) => time > since
      ),
    }));
}
