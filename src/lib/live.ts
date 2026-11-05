import { foldBuses } from "./busStore";
import type { Bus } from "./buses";
import type { Timetable } from "./cablecar";
import type { Aircraft, RouteEnd } from "./flights";
import { foldFlights } from "./flightStore";
import {
  buses,
  cableCar,
  flights,
  quakes,
  rain,
  routePrefix,
  routes,
  satellites,
  tide,
  timeline,
  traffic,
  trains,
  vessels,
  weather,
} from "./liveRecords";
import { canRead, readNewest, readOldest, readSince } from "./liveTable";
import { loadPositions, type Positions } from "./positions";
import type { Quake } from "./quakes";
import type { Rainfall } from "./rainGauges";
import type { Orbit } from "./satellites";
import type { Tide } from "./tide";
import { nextDay, nzMidnight, type TimelineDay, toDay } from "./timeline";
import type { TrafficResponse } from "./traffic";
import { type Train, TRAIL } from "./trains";
import { foldTrains } from "./trainStore";
import { TRAIL as VESSEL_TRAIL, type Vessel } from "./vessels";
import { foldVessels } from "./vesselStore";
import type { Conditions } from "./weather";

// Each live layer as its API route serves it: folded from the poller's logs
// in the table (see plans/dynamo.md), or when the table can't be read, from
// the positions the poller last published (./positions.ts). Given a moment
// `at` (./replay.ts), each is as it was then, read only from the table:
// what's published is now.

/** Fix times lag poll times (edge case 3), so a minute more is read. */
const LAG = 60_000;

/**
 * What `read` makes of the table, or if there's no table or it fails,
 * what `fallback` makes of the published positions. Replaying (`at` given),
 * only the table will do.
 */
async function fromTable<T>(
  layer: string,
  read: () => Promise<T>,
  fallback: (positions: Positions) => T,
  at: number | undefined
): Promise<T> {
  if (at !== undefined) {
    if (!canRead()) throw new Error("no table to replay from");

    return read();
  }

  if (canRead()) {
    try {
      return await read();
    } catch (e) {
      console.error(`[${layer}] table read failed, using positions:`, e);
    }
  }

  return fallback(await loadPositions());
}

/**
 * A log's polls from the `window` before `at` (or now), oldest first; with
 * none that recent, the newest however old (edge case 1: moored ships).
 */
async function readWindow<
  C extends typeof trains | typeof buses | typeof flights | typeof vessels,
>(log: C, window: number, at: number | undefined) {
  const polls = await readSince(log, (at ?? Date.now()) - window - LAG, at);

  if (polls.length) return polls;

  const newest = await readNewest(log, "", at);

  return newest ? [newest] : [];
}

/** The trains running at `at`, or now. */
export const loadTrains = (at?: number): Promise<Train[]> =>
  fromTable(
    "trains",
    async () =>
      foldTrains(await readWindow(trains, TRAIL, at), at ?? Date.now()),
    (positions) => positions.trains,
    at
  );

/** The buses on the road at `at`, or now. */
export const loadBuses = (at?: number): Promise<Bus[]> =>
  fromTable(
    "buses",
    async () => foldBuses(await readWindow(buses, TRAIL, at), at ?? Date.now()),
    (positions) => positions.buses,
    at
  );

/** The ships in the harbour at `at`, or now. */
export const loadVessels = (at?: number): Promise<Vessel[]> =>
  fromTable(
    "vessels",
    async () =>
      foldVessels(
        await readWindow(vessels, VESSEL_TRAIL, at),
        at ?? Date.now()
      ),
    (positions) => positions.vessels,
    at
  );

/** Routes this instance has read, by callsign, and until when to trust them. */
const remembered = new Map<
  string,
  { airports: RouteEnd[] | null; until: number }
>();

/** How long a route read is trusted, ms: the poller looks them up daily. */
const REMEMBER = 10 * 60_000;

/**
 * Every airport on each callsign's route, from the poller's newest lookup
 * (as of `at`, if given): null if it isn't known. Those never looked up are
 * left out. Only routes as of now are remembered.
 */
async function readRoutes(callsigns: Set<string>, at: number | undefined) {
  const found = new Map<string, RouteEnd[] | null>();
  const now = Date.now();

  await Promise.all(
    [...callsigns].map(async (callsign) => {
      const known = remembered.get(callsign);

      if (at === undefined && known && known.until > now) {
        found.set(callsign, known.airports);

        return;
      }

      const route = await readNewest(routes, routePrefix(callsign), at);

      if (!route) return;

      found.set(callsign, route.data.airports);

      if (at !== undefined) return;
      remembered.set(callsign, {
        airports: route.data.airports,
        until: now + REMEMBER,
      });
    })
  );

  return found;
}

/** Every aircraft heard in the `window` before `at` (or now), with its route. */
export const loadAircraft = (
  window: number,
  at?: number
): Promise<Aircraft[]> =>
  fromTable(
    "flights",
    async () => {
      const now = at ?? Date.now();
      const polls = await readSince(flights, now - window - LAG, at);

      const callsigns = new Set(
        polls.flatMap(({ data }) =>
          data.sightings.flatMap(({ aircraft: { callsign } }) =>
            callsign ? [callsign] : []
          )
        )
      );

      return foldFlights(polls, await readRoutes(callsigns, at), now - window);
    },
    // Published with the longest window there is: cut down to this one.
    (positions) =>
      positions.aircraft.flatMap((plane) => {
        const since = Date.now() - window;
        const fixes = plane.fixes.filter(([, , , time]) => time > since);

        return fixes.length ? [{ ...plane, fixes }] : [];
      }),
    at
  );

/**
 * NZTA's newest speeds at `at` (or now), and when they were fetched; null
 * if there are none.
 */
export const loadTraffic = (
  at?: number
): Promise<Omit<TrafficResponse, "time"> | null> =>
  fromTable(
    "traffic",
    async () => {
      const newest = await readNewest(traffic, "", at);

      return newest && { fetched: newest.sk, ...newest.data };
    },
    (positions) => positions.traffic,
    at
  );

/** MetService's newest conditions at `at` (or now); null if there are none. */
export const loadWeather = (at?: number): Promise<Conditions | null> =>
  fromTable(
    "weather",
    async () => (await readNewest(weather, "", at))?.data ?? null,
    (positions) => positions.weather,
    at
  );

/**
 * The cable car's timetable, as last read from Metlink's feed (without its
 * ETag); null if it hasn't been yet. Only in the table: it's not live, so
 * there's no fallback, and a replay runs to it too.
 */
export async function loadTimetable(): Promise<Omit<Timetable, "etag"> | null> {
  if (!canRead()) throw new Error("no table to read the timetable from");

  const stored = await readNewest(cableCar);

  if (!stored) return null;

  const { etag: _etag, ...timetable } = stored.data;

  return timetable;
}

/**
 * The visual satellites' orbits as fetched last before `at` (or now), with
 * when they were fetched; null if none have been. A replay from before the
 * first fetch gets the first: run back a few days, they're still close.
 */
export async function loadSatellites(
  at?: number
): Promise<{ fetched: number; orbits: Orbit[] } | null> {
  if (!canRead()) throw new Error("no table to read the satellites from");

  const stored =
    (await readNewest(satellites, "", at)) ??
    (at === undefined ? null : await readOldest(satellites));

  return stored && { fetched: stored.sk, orbits: stored.data.orbits };
}

/**
 * GeoNet reports a quake a few minutes after it strikes, and its
 * automatic solution's revised for a while after, ms.
 */
export const QUAKES_REPORTED = 20 * 60_000;

/**
 * The quakes GeoNet had heard of at `at` (or now) that were on the map or
 * felt in Wellington, oldest first. Replaying, as it had them a little
 * after (QUAKES_REPORTED), so those about to strike are there to play as
 * they do.
 */
export const loadQuakes = (at?: number): Promise<Quake[]> =>
  fromTable(
    "quakes",
    async () => {
      const until =
        at === undefined
          ? undefined
          : Math.min(at + QUAKES_REPORTED, Date.now());

      return (await readNewest(quakes, "", until))?.data.quakes ?? [];
    },
    (positions) => positions.quakes,
    at
  );

/** The harbour's newest height at `at` (or now); null if there's none. */
export const loadTide = (at?: number): Promise<Tide | null> =>
  fromTable(
    "tide",
    async () => (await readNewest(tide, "", at))?.data ?? null,
    (positions) => positions.tide,
    at
  );

/** The rain gauges' newest rates at `at` (or now); null if there are none. */
export const loadRain = (at?: number): Promise<Rainfall | null> =>
  fromTable(
    "rain",
    async () => (await readNewest(rain, "", at))?.data ?? null,
    (positions) => positions.rain,
    at
  );

/**
 * The timeline (./timeline.ts) for the NZ date `day`: its hours, and the
 * one after, for quakes reported just after midnight. Only in the table:
 * nothing's published for it.
 */
export async function loadTimelineDay(day: string): Promise<TimelineDay> {
  if (!canRead()) throw new Error("no table to read the timeline from");

  const hours = await readSince(
    timeline,
    nzMidnight(day),
    nzMidnight(nextDay(day))
  );

  return toDay(day, hours);
}
