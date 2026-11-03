import { foldBuses } from "./busStore";
import type { Bus } from "./buses";
import type { Aircraft, RouteEnd } from "./flights";
import { foldFlights } from "./flightStore";
import {
  buses,
  flights,
  routePrefix,
  routes,
  traffic,
  trains,
  vessels,
  weather,
} from "./liveRecords";
import { canRead, readNewest, readSince } from "./liveTable";
import { loadPositions, type Positions } from "./positions";
import type { TrafficResponse } from "./traffic";
import { type Train, TRAIL } from "./trains";
import { foldTrains } from "./trainStore";
import { TRAIL as VESSEL_TRAIL, type Vessel } from "./vessels";
import { foldVessels } from "./vesselStore";
import type { Conditions } from "./weather";

// Each live layer as its API route serves it: folded from the poller's logs
// in the table (see plans/dynamo.md), or when the table can't be read, from
// the positions the poller last published (./positions.ts).

/** Fix times lag poll times (edge case 3), so a minute more is read. */
const LAG = 60_000;

/**
 * What `read` makes of the table, or if there's no table or it fails,
 * what `fallback` makes of the published positions.
 */
async function fromTable<T>(
  layer: string,
  read: () => Promise<T>,
  fallback: (positions: Positions) => T
): Promise<T> {
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
 * A log's polls from the last `window`, oldest first; with none that
 * recent, the newest however old (edge case 1: moored ships).
 */
async function readWindow<
  C extends typeof trains | typeof buses | typeof flights | typeof vessels,
>(log: C, window: number, now: number) {
  const polls = await readSince(log, now - window - LAG);

  if (polls.length) return polls;

  const newest = await readNewest(log);

  return newest ? [newest] : [];
}

export const loadTrains = (now = Date.now()): Promise<Train[]> =>
  fromTable(
    "trains",
    async () => foldTrains(await readWindow(trains, TRAIL, now), now),
    (positions) => positions.trains
  );

export const loadBuses = (now = Date.now()): Promise<Bus[]> =>
  fromTable(
    "buses",
    async () => foldBuses(await readWindow(buses, TRAIL, now), now),
    (positions) => positions.buses
  );

export const loadVessels = (now = Date.now()): Promise<Vessel[]> =>
  fromTable(
    "vessels",
    async () => foldVessels(await readWindow(vessels, VESSEL_TRAIL, now), now),
    (positions) => positions.vessels
  );

/** Routes this instance has read, by callsign, and until when to trust them. */
const remembered = new Map<
  string,
  { airports: RouteEnd[] | null; until: number }
>();

/** How long a route read is trusted, ms: the poller looks them up daily. */
const REMEMBER = 10 * 60_000;

/**
 * Every airport on each callsign's route, from the poller's newest lookup:
 * null if it isn't known. Those never looked up are left out.
 */
async function readRoutes(callsigns: Set<string>, now: number) {
  const found = new Map<string, RouteEnd[] | null>();

  await Promise.all(
    [...callsigns].map(async (callsign) => {
      const known = remembered.get(callsign);

      if (known && known.until > now) {
        found.set(callsign, known.airports);

        return;
      }

      const route = await readNewest(routes, routePrefix(callsign));

      if (!route) return;

      found.set(callsign, route.data.airports);
      remembered.set(callsign, {
        airports: route.data.airports,
        until: now + REMEMBER,
      });
    })
  );

  return found;
}

/** Every aircraft heard in the last `window`, with its route. */
export const loadAircraft = (
  window: number,
  now = Date.now()
): Promise<Aircraft[]> =>
  fromTable(
    "flights",
    async () => {
      const polls = await readSince(flights, now - window - LAG);

      const callsigns = new Set(
        polls.flatMap(({ data }) =>
          data.sightings.flatMap(({ aircraft: { callsign } }) =>
            callsign ? [callsign] : []
          )
        )
      );

      return foldFlights(polls, await readRoutes(callsigns, now), now - window);
    },
    // Published with the longest window there is: cut down to this one.
    (positions) =>
      positions.aircraft.flatMap((plane) => {
        const fixes = plane.fixes.filter(([, , , time]) => time > now - window);

        return fixes.length ? [{ ...plane, fixes }] : [];
      })
  );

/** NZTA's newest speeds, and when they were fetched; null if there are none. */
export const loadTraffic = (): Promise<Omit<TrafficResponse, "time"> | null> =>
  fromTable(
    "traffic",
    async () => {
      const newest = await readNewest(traffic);

      return newest && { fetched: newest.sk, ...newest.data };
    },
    (positions) => positions.traffic
  );

/** MetService's newest conditions; null if there are none. */
export const loadWeather = (): Promise<Conditions | null> =>
  fromTable(
    "weather",
    async () => (await readNewest(weather))?.data ?? null,
    (positions) => positions.weather
  );
