import { z } from "zod";
import { fetchTrains } from "./metlink";
import { canStore, getRedis, getStored } from "./redis";
import { point, trailPoint } from "./schemas";
import { isStale, MAP_BOUNDS, Train, TRAIL } from "./trains";

// The network as last fetched from Metlink, kept in Upstash Redis so it's
// fetched at most every REFRESH however many people are watching. Metlink
// keeps no history, so each train's trail is built up here, a fix at a time.

/** The latest `Snapshot`. Never expires: it's the last known good. */
const SNAPSHOT = "trains:snapshot";

/** Held by whoever's refreshing, for REFRESH. */
const LOCK = "trains:lock";

/**
 * How often Metlink is asked, at most. Trains report about every 30
 * seconds; this catches each fix soon after.
 */
const REFRESH = 10_000;

interface Snapshot {
  /** When it was fetched, epoch ms. */
  time: number;
  trains: Train[];
}

const stored = z.object({
  time: z.number(),
  trains: z.array(
    z.object({
      id: z.string(),
      line: z.enum(["KPL", "HVL", "MEL", "WRL", "JVL"]),
      direction: z.number(),
      position: point,
      bearing: z.number().nullable(),
      time: z.number(),
      trail: z.array(trailPoint),
    })
  ),
}) satisfies z.ZodType<Snapshot>;

const [WEST, SOUTH, EAST, NORTH] = MAP_BOUNDS;

const onMap = ({ position: [e, n] }: Train) =>
  e > WEST && e < EAST && n > SOUTH && n < NORTH;

/** Fetches the trains, carrying on trails from `previous`. */
async function refresh(previous: Snapshot | null): Promise<Snapshot> {
  const now = Date.now();
  const since = now - TRAIL;
  const before = new Map(previous?.trains.map((t) => [t.id, t]));

  const trains = (await fetchTrains()).filter(onMap).map((train) => {
    const trail = (before.get(train.id)?.trail ?? []).filter(
      ([, , time]) => time > since && time < train.time
    );

    return { ...train, trail: [...trail, ...train.trail] };
  });

  return { time: now, trains };
}

/**
 * Trains recent enough to show, with their trails: the stored snapshot, or
 * a fresh one if it's due and nobody else is fetching it. If Metlink fails,
 * the last one fetched.
 */
export async function loadTrains(): Promise<Train[]> {
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
        console.error("[trains] refresh failed:", e);
      }
    }
  }

  const since = Date.now() - TRAIL;

  return (snapshot?.trains ?? [])
    .filter((train) => !isStale(train))
    .map((train) => ({
      ...train,
      trail: train.trail.filter(([, , time]) => time > since),
    }));
}
