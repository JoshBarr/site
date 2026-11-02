import { z } from "zod";
import { fetchHarbour, fetchTrack, TrackPoint } from "./openwaters";
import { canStore, getRedis, getStored } from "./redis";
import { point, trailPoint } from "./schemas";
import {
  isStale,
  STALE_STATIONARY,
  STALE_UNDER_WAY,
  TRAIL,
  UNDER_WAY,
  Vessel,
} from "./vessels";

// The harbour as last fetched from Open Waters, kept in Upstash Redis so it's
// fetched at most every REFRESH however many people are watching, and so
// there's something to show when Open Waters can't be reached.

/** The latest `Snapshot`. Never expires: it's the last known good. */
const SNAPSHOT = "vessels:snapshot";

/** Held by whoever's refreshing, for REFRESH. */
const LOCK = "vessels:lock";

/**
 * Hash of which way each ship last pointed, by MMSI, kept for good: plenty
 * of small craft never send a heading, only a course while under way.
 */
const HEADINGS = "vessels:headings";

/** How often the harbour is fetched, at most. */
const REFRESH = 20_000;

/** Trail positions closer together than this, ms, are thinned out. */
const TRAIL_STEP = 10_000;

/**
 * Most tracks fetched in one refresh. Open Waters allows 120 requests a
 * minute; three refreshes a minute stay under it.
 */
const MAX_TRACKS = 30;

interface Snapshot {
  /** When it was fetched, epoch ms. */
  time: number;
  vessels: Vessel[];
}

const stored = z.object({
  time: z.number(),
  vessels: z.array(
    z.object({
      mmsi: z.number(),
      name: z.string().nullable(),
      type: z.number(),
      position: point,
      speed: z.number(),
      course: z.number().nullable(),
      heading: z.number().nullable(),
      dimension: z
        .tuple([z.number(), z.number(), z.number(), z.number()])
        .nullable(),
      time: z.number(),
      trail: z.array(trailPoint),
    })
  ),
}) satisfies z.ZodType<Snapshot>;

/** HEADINGS' entries for the MMSIs asked for: null for those not in it. */
const storedHeadings = z.record(z.string(), z.number().nullable()).nullable();

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

/** Fetches the harbour, carrying on trails and headings from `previous`. */
async function refresh(previous: Snapshot | null): Promise<Snapshot> {
  const now = Date.now();
  const since = now - TRAIL;
  const fetched = await fetchHarbour(STALE_STATIONARY, STALE_UNDER_WAY);
  const before = new Map(previous?.vessels.map((v) => [v.mmsi, v]));

  // Only ships under way have moved since. Each one's track is fetched from
  // the end of its trail, or for the whole trail if it's new or was moored.
  const moving = fetched
    .filter((v) => v.speed > UNDER_WAY)
    .slice(0, MAX_TRACKS);

  const tracks = new Map(
    await Promise.all(
      moving.map(async ({ mmsi }) => {
        const trail = before.get(mmsi)?.trail.filter(([, , t]) => t > since);
        const from = trail?.length ? trail[trail.length - 1][2] : since;

        const track = await fetchTrack(mmsi, from).catch((e) => {
          console.error(`[vessels] track ${mmsi}:`, e);

          return null;
        });

        return [mmsi, track] as const;
      })
    )
  );

  const vessels = fetched.map((vessel) => {
    const known = before.get(vessel.mmsi);
    const carried = { ...vessel, trail: known?.trail ?? [] };
    const track = tracks.get(vessel.mmsi);

    return track
      ? follow(carried, track, since)
      : { ...carried, trail: thin(carried.trail, since) };
  });

  if (canStore()) await rememberHeadings(vessels);

  return { time: now, vessels };
}

/**
 * Stores which way ships under way or with a heading point, and fills in the
 * last one known for those moored without one.
 */
async function rememberHeadings(vessels: Vessel[]) {
  const redis = getRedis();
  const known: Record<string, number> = {};

  for (const v of vessels) {
    const heading = v.heading ?? (v.speed > UNDER_WAY ? v.course : null);

    if (heading !== null) known[v.mmsi] = heading;
  }

  // Under way, the scene goes by its course instead.
  const missing = vessels.filter(
    (v) => v.heading === null && v.speed <= UNDER_WAY
  );

  const pipeline = redis.pipeline();

  if (Object.keys(known).length) pipeline.hset(HEADINGS, known);

  if (missing.length) {
    pipeline.hmget(HEADINGS, ...missing.map((v) => String(v.mmsi)));
  }

  if (!pipeline.length()) return;
  const results = await pipeline.exec();

  if (!missing.length) return;

  // Without them, these ships are drawn pointing north: no reason to fail.
  const { data: headings } = storedHeadings.safeParse(
    results[results.length - 1]
  );

  for (const v of missing) v.heading = headings?.[v.mmsi] ?? null;
}

/**
 * Ships recent enough to show, with their trails: the stored snapshot, or a
 * fresh one if it's due and nobody else is fetching it. If Open Waters
 * fails, the last one fetched.
 */
export async function loadVessels(): Promise<Vessel[]> {
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
        console.error("[vessels] refresh failed:", e);
      }
    }
  }

  const since = Date.now() - TRAIL;

  return (snapshot?.vessels ?? [])
    .filter((vessel) => !isStale(vessel))
    .map((vessel) => ({
      ...vessel,
      trail: vessel.trail.filter(([, , time]) => time > since),
    }));
}
