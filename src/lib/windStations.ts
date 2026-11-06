import { hilltop, readings } from "./hilltop";

// The wind as it's measured, at Greater Wellington Regional Council's
// weather stations on the map, through their Hilltop server (./hilltop.ts).
// The scene turns what they read into the wind out at sea, by how each has
// read against it before (public/wind/stations.json, from
// scripts/wind/build_stations.py, which lists the same stations).

/**
 * For speeds in km/h. Hilltop says the fire weather (NRFA) stations' are
 * m/s, but Belmont's would then average 75 km/h.
 */
const KMH = 1 / 3.6;

/** Each site, its measurements, and what its speeds are multiplied by for m/s. */
export const STATIONS = [
  {
    site: "Karori Stream at Samuel Marsden School",
    speed: "Wind Speed",
    direction: "Wind Direction",
    scale: 1,
  },
  {
    site: "NRFA at Belmont",
    speed: "Wind Speed",
    direction: "Wind Direction",
    scale: KMH,
  },
  {
    site: "NRFA at Remutaka Forest Park",
    speed: "Wind Speed",
    direction: "Wind Direction",
    scale: KMH,
  },
  {
    site: "Birch Lane AQ",
    speed: "Wind Speed (10m)",
    direction: "Wind Direction (10m)",
    scale: 1,
  },
  {
    site: "Upper Hutt at Savage Park AQ",
    speed: "Wind Speed (10m)",
    direction: "Wind Direction (10m)",
    scale: 1,
  },
  {
    site: "Willis St AQ",
    speed: "Wind Speed (6m)",
    direction: "Wind Direction (6m)",
    scale: 1,
  },
] as const;

/** A station's reading is the mean over this long to its newest, ms. */
const MEAN_OVER = 10 * 60_000;

/**
 * The newest reading's at most this old to be kept, ms: the air quality
 * stations send theirs once an hour, to ten past.
 */
const FRESH = 75 * 60_000;

/** Faster than this, m/s, it's a fault: Karori's sometimes reads 200. */
const GALE = 60;

export interface StationReading {
  site: string;
  /** m/s, a vector mean over the ten minutes to `at`. */
  speed: number;
  /** Degrees it blows from. */
  direction: number;
  /** Its newest reading, epoch ms. */
  at: number;
}

export interface WindReadings {
  /** When they were asked, epoch ms. */
  time: number;
  /** Those heard from lately; empty if none were. */
  stations: StationReading[];
}

async function series(site: string, measurement: string) {
  const body = await hilltop({
    Request: "GetData",
    Site: site,
    Measurement: measurement,
    TimeInterval: `PT${FRESH / 60_000}M/now`,
  });

  return readings(body);
}

const round = (value: number, places: number) =>
  Math.round(value * 10 ** places) / 10 ** places;

/** A station's reading: when, m/s, and the degrees it blows from. */
interface Paired {
  at: number;
  speed: number;
  from: number;
}

/**
 * A station's speeds (as Hilltop gives them, times `scale` for m/s) with
 * the directions read at the same times, oldest first, without faults.
 */
export function pair(
  speeds: { at: number; value: number }[],
  directions: { at: number; value: number }[],
  scale: number
): Paired[] {
  const from = new Map(directions.map(({ at, value }) => [at, value]));

  return speeds
    .flatMap(({ at, value }) => {
      const blowing = from.get(at);
      const metres = value * scale;

      return blowing === undefined || metres < 0 || metres > GALE
        ? []
        : [{ at, speed: metres, from: blowing }];
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * The station's wind as it was known at `now` (epoch ms), from its readings
 * (`pair`): the mean over the ten minutes to its newest then, or null if
 * that's older than's fresh.
 */
export function windAt(
  site: string,
  paired: Paired[],
  now: number
): StationReading | null {
  // The newest at or before now.
  let lo = 0;
  let hi = paired.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (paired[mid].at <= now) lo = mid + 1;
    else hi = mid;
  }

  const newest = paired[lo - 1]?.at;

  if (newest === undefined || !(now - newest <= FRESH)) return null;

  // Summed as vectors: x east, z south.
  let x = 0;
  let z = 0;
  let count = 0;

  for (let i = lo - 1; i >= 0 && paired[i].at > newest - MEAN_OVER; i--) {
    const toward = ((paired[i].from + 180) * Math.PI) / 180;
    x += Math.sin(toward) * paired[i].speed;
    z -= Math.cos(toward) * paired[i].speed;
    count++;
  }

  x /= count;
  z /= count;
  const toward = (Math.atan2(x, -z) * 180) / Math.PI;

  return {
    site,
    speed: round(Math.hypot(x, z), 2),
    direction: round((((toward + 180) % 360) + 360) % 360, 1),
    at: newest,
  };
}

/**
 * Each station's wind over its last ten minutes, as at `now` (epoch ms):
 * those that don't answer, or haven't lately, are left out.
 */
export async function fetchWind(now = Date.now()): Promise<WindReadings> {
  const asked = await Promise.allSettled(
    STATIONS.map(async ({ site, speed, direction, scale }) => {
      const [speeds, directions] = await Promise.all([
        series(site, speed),
        series(site, direction),
      ]);

      return windAt(site, pair(speeds, directions, scale), now);
    })
  );

  const stations = asked.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );

  return { time: now, stations };
}
