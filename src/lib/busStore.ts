import { z } from "zod";
import { fetchBuses } from "./metlink";
import { canStore, getRedis, getStored } from "./redis";
import { point, trailPoint } from "./schemas";
import { Bus, isStale, MAP_BOUNDS, TRAIL } from "./buses";

// The buses as last fetched from Metlink, kept in Upstash Redis so they're
// fetched at most every REFRESH however many people are watching. Metlink
// keeps no history, so each bus's trail is built up here, a fix at a time.

/** The latest `Snapshot`. Never expires: it's the last known good. */
const SNAPSHOT = "buses:snapshot";

/** Held by whoever's refreshing, for REFRESH. */
const LOCK = "buses:lock";

/**
 * How often Metlink is asked, at most. Buses report about every 30
 * seconds; this catches each fix soon after.
 */
const REFRESH = 10_000;

interface Snapshot {
  /** When it was fetched, epoch ms. */
  time: number;
  buses: Bus[];
}

const stored = z.object({
  time: z.number(),
  buses: z.array(
    z.object({
      id: z.string(),
      route: z.string(),
      direction: z.number(),
      position: point,
      bearing: z.number().nullable(),
      time: z.number(),
      trail: z.array(trailPoint),
    })
  ),
}) satisfies z.ZodType<Snapshot>;

const [WEST, SOUTH, EAST, NORTH] = MAP_BOUNDS;

const onMap = ({ position: [e, n] }: Bus) =>
  e > WEST && e < EAST && n > SOUTH && n < NORTH;

/** Fetches the buses, carrying on trails from `previous`. */
async function refresh(previous: Snapshot | null): Promise<Snapshot> {
  const now = Date.now();
  const since = now - TRAIL;
  const before = new Map(previous?.buses.map((b) => [b.id, b]));

  const buses = (await fetchBuses()).filter(onMap).map((bus) => {
    // A bus that's started another trip leaves the last one's trail behind.
    const known = before.get(bus.id);

    const sameTrip =
      known?.route === bus.route && known.direction === bus.direction;

    const trail = (sameTrip ? known.trail : []).filter(
      ([, , time]) => time > since && time < bus.time
    );

    return { ...bus, trail: [...trail, ...bus.trail] };
  });

  return { time: now, buses };
}

/**
 * Buses recent enough to show, with their trails: the stored snapshot, or
 * a fresh one if it's due and nobody else is fetching it. If Metlink fails,
 * the last one fetched.
 */
export async function loadBuses(): Promise<Bus[]> {
  let snapshot: Snapshot | null = null;

  if (!canStore()) {
    snapshot = await refresh(null);
  } else {
    const redis = getRedis();
    snapshot = await getStored(SNAPSHOT, stored);

    if (
      (!snapshot || Date.now() - snapshot.time >= REFRESH) &&
      (await redis.set(LOCK, 1, { nx: true, px: REFRESH })) === "OK"
    ) {
      try {
        snapshot = await refresh(snapshot);
        await redis.set(SNAPSHOT, snapshot);
      } catch (e) {
        console.error("[buses] refresh failed:", e);
      }
    }
  }

  const since = Date.now() - TRAIL;

  return (snapshot?.buses ?? [])
    .filter((bus) => !isStale(bus))
    .map((bus) => ({
      ...bus,
      trail: bus.trail.filter(([, , time]) => time > since),
    }));
}
