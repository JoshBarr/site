import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { HISTORY, type RouteEnd } from "../../src/lib/flights";
import { fetchAirspace, LatLon, lookupRoutes } from "../../src/lib/flightStore";
import {
  buses,
  flights,
  headings,
  type LiveData,
  type LiveRecord,
  quakes,
  rain,
  routePrefix,
  routes,
  tide,
  toRecord,
  traffic,
  trains,
  vessels,
  weather,
  windStations,
} from "../../src/lib/liveRecords";
import { fetchBuses, fetchTrains } from "../../src/lib/metlink";
import { fetchTraffic } from "../../src/lib/nzta";
import { fetchQuakes } from "../../src/lib/quakes";
import { fetchGaugeSites, fetchRainfall } from "../../src/lib/rainGauges";
import { fetchMeanLevel, fetchTide } from "../../src/lib/tide";
import { onMap, TRAIL } from "../../src/lib/trains";
import { pollHarbour, reportedHeading } from "../../src/lib/vesselStore";
import {
  TRAIL as VESSEL_TRAIL,
  UNDER_WAY,
  type Vessel,
} from "../../src/lib/vessels";
import { getConditions } from "../../src/lib/weather";
import { fetchWind } from "../../src/lib/windStations";
import type { LiveBucket } from "./positions";
import { all, LiveTable, newest, put } from "./table";

// The live feeds as the poller runs them: each polled about as often as it
// changes (measured in plans/infra.md), and each poll that brings something
// new appended to its log as it was fetched (see plans/dynamo.md). Each
// keeps what it's stored over its window, for the positions published from
// them (./positions.ts).

type LogCollection =
  | typeof trains
  | typeof buses
  | typeof flights
  | typeof vessels
  | typeof traffic
  | typeof weather
  | typeof quakes
  | typeof tide
  | typeof rain
  | typeof windStations;

interface Spec<L extends LogCollection> {
  log: L;
  /** How often it's polled, ms. */
  every: number;
  /** How far into each invocation it's first polled, ms. */
  offset: number;
  /** How far back what it's stored is kept, ms: 0 for only the newest. */
  window: number;
  /**
   * Polls the feed, given what it last stored: what to store, or null if
   * there's nothing new.
   */
  poll(
    previous: LiveRecord<L> | null
  ): Effect.Effect<LiveData<L> | null, unknown, LiveTable>;
}

export interface Feed {
  readonly name: string;
  readonly every: number;
  readonly offset: number;
  /** Polls the feed, and stores what's new. */
  readonly poll: Effect.Effect<void, unknown, LiveTable | LiveBucket>;
  /** Logs what this invocation polled and wrote. */
  readonly report: Effect.Effect<void>;
}

/** A feed logged in the table. */
interface LogFeed<L extends LogCollection> extends Feed {
  /**
   * What it's stored over its window, oldest first, and the newest however
   * old: read from the table when the container's cold.
   */
  readonly polls: Effect.Effect<LiveRecord<L>[], unknown, LiveTable>;
  /** How many items it's written: when it changes, there's something new. */
  readonly writes: Effect.Effect<number>;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** Fix times lag poll times (edge case 3), so a minute more is kept. */
const LAG = 60_000;

/** A feed, with what it remembers while the container's warm. */
const feed = <L extends LogCollection>(spec: Spec<L>) =>
  Effect.gen(function* () {
    // Undefined until read from the table.
    const recent = yield* Ref.make<LiveRecord<L>[] | undefined>(undefined);
    const written = yield* Ref.make(0);
    const stats = yield* Ref.make({ polls: 0, writes: 0, size: 0 });
    const keep = spec.window && spec.window + LAG;

    const polls = Effect.gen(function* () {
      const known = yield* Ref.get(recent);

      if (known) return known;

      const now = yield* Clock.currentTimeMillis;
      let stored = keep ? yield* all(spec.log, now - keep) : [];

      // None that recent: the newest, however old (edge case 1).
      if (!stored.length) {
        const latest = yield* newest(spec.log);
        stored = latest ? [latest] : [];
      }

      yield* Ref.set(recent, stored);

      return stored;
    });

    const poll = Effect.gen(function* () {
      yield* Ref.update(stats, (s) => ({ ...s, polls: s.polls + 1 }));
      const previous = (yield* polls).at(-1) ?? null;
      const data = yield* spec.poll(previous);

      if (data === null) return;

      const time = yield* Clock.currentTimeMillis;
      const size = yield* put(spec.log, time, data, time);
      const record = toRecord(spec.log, time, data, time);

      // Another invocation polling at the same time (a late schedule, a slow
      // NZTA) appends its own items; whoever reads them dedupes.
      yield* Ref.update(recent, (known = []) => [
        ...known.filter(({ sk }) => sk > time - keep),
        record,
      ]);

      yield* Ref.update(written, (n) => n + 1);

      yield* Ref.update(stats, (s) => ({
        ...s,
        writes: s.writes + 1,
        size,
      }));
    });

    const report = Effect.gen(function* () {
      const { polls, writes, size } = yield* Ref.getAndSet(stats, {
        polls: 0,
        writes: 0,
        size: 0,
      });

      yield* Effect.log(
        `[${spec.log.pk}] ${polls} polls, ${writes} writes of ${kb(size)}`
      );
    });

    return {
      name: spec.log.pk,
      every: spec.every,
      offset: spec.offset,
      poll,
      report,
      polls,
      writes: Ref.get(written),
    } satisfies LogFeed<L>;
  });

/**
 * Whether any of `next` has a newer fix than `previous` had for it, matched
 * by `key`.
 */
function anyNewer<T>(
  next: T[],
  previous: T[] | undefined,
  key: (item: T) => string,
  time: (item: T) => number
) {
  const before = new Map(previous?.map((item) => [key(item), time(item)]));

  return next.some((item) => time(item) > (before.get(key(item)) ?? -Infinity));
}

/** Without fixes' trails: each is only its own position. */
const withoutTrail = <T extends { trail: unknown }>({
  trail: _trail,
  ...fix
}: T) => fix;

/** How long until a route's looked up again, ms. */
const ROUTE_AGAIN = 24 * 3600_000;

/** Until one adsb.im didn't know is. */
const UNKNOWN_AGAIN = 3600_000;

/** Until one adsb.im didn't answer for is. */
const FAILED_AGAIN = 60_000;

const lookUpAgain = (airports: unknown[] | null) =>
  airports ? ROUTE_AGAIN : UNKNOWN_AGAIN;

/** What a container knows of routes, by callsign. */
interface Routes {
  /** Every airport on each one's route, or null if it isn't known. */
  known: Map<string, RouteEnd[] | null>;
  /** When each one's to be looked up again, epoch ms. */
  due: Map<string, number>;
}

/**
 * Looks up the routes of the callsigns in `wanted` (each where it is) that
 * are due, and stores them. Each callsign's is read from the table the
 * first time this container sees it.
 */
const updateRoutes = ({ known, due }: Routes, wanted: Map<string, LatLon>) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    yield* Effect.forEach(
      [...wanted.keys()].filter((callsign) => !due.has(callsign)),
      (callsign) =>
        newest(routes, routePrefix(callsign)).pipe(
          Effect.map((route) => {
            if (!route) return due.set(callsign, now);

            known.set(callsign, route.data.airports);
            due.set(callsign, route.sk.time + lookUpAgain(route.data.airports));
          })
        ),
      { concurrency: 10, discard: true }
    );

    const asking = new Map(
      [...wanted].filter(([callsign]) => (due.get(callsign) ?? 0) <= now)
    );

    if (!asking.size) return;

    // Until it's answered.
    for (const callsign of asking.keys()) due.set(callsign, now + FAILED_AGAIN);

    const found = yield* Effect.tryPromise(() => lookupRoutes(asking));

    yield* Effect.forEach(
      found,
      ([callsign, airports]) =>
        put(routes, { callsign, time: now }, { airports }, now).pipe(
          Effect.map(() => {
            known.set(callsign, airports);
            due.set(callsign, now + lookUpAgain(airports));
          })
        ),
      { concurrency: 10, discard: true }
    );
  });

// adsb.lol answers some polls every 5 s with HTTP 429; none every 10 s.
const flightsFeed = (routeMemory: Routes) =>
  feed({
    log: flights,
    every: 10_000,
    offset: 0,
    window: HISTORY,
    poll: (previous) =>
      Effect.gen(function* () {
        const fetched = yield* Effect.tryPromise(fetchAirspace);

        const wanted = new Map(
          fetched.flatMap(({ aircraft: { callsign }, at }) =>
            callsign && at ? [[callsign, at] as const] : []
          )
        );

        // Without routes, trails just end where the aircraft were first and
        // last seen: no reason not to store them.
        yield* updateRoutes(routeMemory, wanted).pipe(
          Effect.catchCause((cause) => Effect.logError("[routes]", cause))
        );

        const sightings = fetched.map(({ aircraft, fix }) => ({
          aircraft,
          fix,
        }));

        return anyNewer(
          sightings,
          previous?.data.sightings,
          ({ aircraft }) => aircraft.hex,
          ({ fix }) => fix[3]
        )
          ? { sightings }
          : null;
      }),
  });

/**
 * Stores which way each ship points when that's changed, and fills in the
 * last one known for those moored without one. `known` is read from the
 * table when the container's cold.
 */
const rememberHeadings = (
  known: Ref.Ref<Map<number, number> | null>,
  ships: Vessel[]
) =>
  Effect.gen(function* () {
    let remembered = yield* Ref.get(known);

    if (!remembered) {
      const stored = yield* all(headings);
      remembered = new Map(stored.map(({ sk, data }) => [sk, data.heading]));
      yield* Ref.set(known, remembered);
    }

    const now = yield* Clock.currentTimeMillis;

    yield* Effect.forEach(
      ships,
      (ship) => {
        const reported = reportedHeading(ship);

        // Under way, the scene goes by its course instead.
        if (reported === null && ship.speed <= UNDER_WAY) {
          ship.heading = remembered.get(ship.mmsi) ?? null;
        }

        // Whole degrees, so a wandering course isn't a write a minute.
        const heading = reported === null ? null : Math.round(reported);

        if (heading === null || remembered.get(ship.mmsi) === heading) {
          return Effect.void;
        }

        return put(headings, ship.mmsi, { heading }, now).pipe(
          Effect.map(() => {
            remembered.set(ship.mmsi, heading);
          }),
          Effect.catchCause((cause) =>
            Effect.logError(`[headings] ${ship.mmsi}:`, cause)
          )
        );
      },
      { concurrency: 10, discard: true }
    );
  });

// Each poll fetches tracks from where trails end, so polling less often
// loses no trail, only how live the ships' positions are. Written every
// poll: moored ships are in each one.
const vesselsFeed = Effect.gen(function* () {
  // When each ship's trail ends, by MMSI.
  const ends = new Map<number, number>();
  const known = yield* Ref.make<Map<number, number> | null>(null);

  return yield* feed({
    log: vessels,
    every: 60_000,
    offset: 15_000,
    window: VESSEL_TRAIL,
    poll: () =>
      Effect.gen(function* () {
        const ships = yield* Effect.tryPromise(() => pollHarbour(ends));

        for (const { mmsi, trail } of ships) {
          const end = trail.at(-1);

          if (end) ends.set(mmsi, end[2]);
        }

        yield* rememberHeadings(known, ships);

        return { vessels: ships };
      }),
  });
});

/** How often MetService is asked, ms: its conditions are for the hour. */
const WEATHER_EVERY = 30 * 60_000;

/** How often the tide gauge is asked, ms: the tide's carried on between. */
const TIDE_EVERY = 5 * 60_000;

/** How long the gauge's 30-day mean is trusted, ms. */
const MEAN_AGAIN = 24 * 3600_000;

const tideFeed = Effect.gen(function* () {
  // The gauge's mean, and when it was fetched: once a day is plenty.
  const mean = yield* Ref.make<{ level: number; fetched: number } | null>(null);

  return yield* feed({
    log: tide,
    every: 60_000,
    offset: 25_000,
    window: 0,
    poll: (previous) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        if (previous && now - previous.sk < TIDE_EVERY) return null;

        let known = yield* Ref.get(mean);

        if (!known || now - known.fetched >= MEAN_AGAIN) {
          known = {
            level: yield* Effect.tryPromise(fetchMeanLevel),
            fetched: now,
          };

          yield* Ref.set(mean, known);
        }

        const { level } = known;

        return yield* Effect.tryPromise(() => fetchTide(level));
      }),
  });
});

/** How often the rain gauges are asked, ms: they're telemetered about as often. */
const RAIN_EVERY = 5 * 60_000;

/** How long the gauges' sites are trusted, ms. */
const SITES_AGAIN = 24 * 3600_000;

const rainFeed = Effect.gen(function* () {
  // Where the gauges are, and when that was fetched: they seldom move.
  const sites = yield* Ref.make<{
    where: Awaited<ReturnType<typeof fetchGaugeSites>>;
    fetched: number;
  } | null>(null);

  return yield* feed({
    log: rain,
    every: 60_000,
    offset: 35_000,
    window: 0,
    poll: (previous) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        if (previous && now - previous.sk < RAIN_EVERY) return null;

        let known = yield* Ref.get(sites);

        if (!known || now - known.fetched >= SITES_AGAIN) {
          known = {
            where: yield* Effect.tryPromise(fetchGaugeSites),
            fetched: now,
          };

          yield* Ref.set(sites, known);
        }

        const { where } = known;

        return yield* Effect.tryPromise(() => fetchRainfall(where, now));
      }),
  });
});

/**
 * How often the weather stations are asked, ms: most send every ten
 * minutes, Karori's every minute.
 */
const WIND_EVERY = 5 * 60_000;

/** Every feed, made once per container, and what they know of routes. */
export const makeFeeds = Effect.gen(function* () {
  const routeMemory: Routes = { known: new Map(), due: new Map() };

  const logs = yield* Effect.all({
    flights: flightsFeed(routeMemory),

    // Buses never go quiet, so every poll writes; they're drawn 45 s behind
    // along their routes, so 20 s apart loses little.
    buses: feed({
      log: buses,
      every: 20_000,
      offset: 5_000,
      window: TRAIL,
      poll: (previous) =>
        Effect.tryPromise(fetchBuses).pipe(
          Effect.map((fetched) => {
            const fixes = fetched.filter(onMap).map(withoutTrail);

            return anyNewer(
              fixes,
              previous?.data.buses,
              ({ id }) => id,
              ({ time }) => time
            )
              ? { buses: fixes }
              : null;
          })
        ),
    }),

    // Trains report in one batch every 30 s: polled every 10 s, a batch is
    // caught within 10 s, and the polls between find nothing to write.
    trains: feed({
      log: trains,
      every: 10_000,
      offset: 3_000,
      window: TRAIL,
      poll: (previous) =>
        Effect.tryPromise(fetchTrains).pipe(
          Effect.map((fetched) => {
            const fixes = fetched.filter(onMap).map(withoutTrail);

            return anyNewer(
              fixes,
              previous?.data.trains,
              ({ id }) => id,
              ({ time }) => time
            )
              ? { trains: fixes }
              : null;
          })
        ),
    }),

    vessels: vesselsFeed,

    // NZTA takes 15 s or so to answer, so it goes first. Written every poll:
    // the scene goes by when speeds were fetched to tell they're stale.
    traffic: feed({
      log: traffic,
      every: 60_000,
      offset: 0,
      window: 0,
      poll: () => Effect.tryPromise(fetchTraffic),
    }),

    // getConditions logs its own failures, and says null: asked again the
    // next minute.
    weather: feed({
      log: weather,
      every: 60_000,
      offset: 20_000,
      window: 0,
      poll: (previous) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          if (previous && now - previous.sk < WEATHER_EVERY) return null;

          return yield* Effect.tryPromise(getConditions);
        }),
    }),

    // Written when GeoNet's list changes: a new quake, or one revised.
    quakes: feed({
      log: quakes,
      every: 60_000,
      offset: 30_000,
      window: 0,
      poll: (previous) =>
        Effect.tryPromise(fetchQuakes).pipe(
          Effect.map((fetched) =>
            previous &&
            JSON.stringify(previous.data.quakes) === JSON.stringify(fetched)
              ? null
              : { quakes: fetched }
          )
        ),
    }),

    tide: tideFeed,

    rain: rainFeed,

    wind: feed({
      log: windStations,
      every: 60_000,
      offset: 40_000,
      window: 0,
      poll: (previous) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          if (previous && now - previous.sk < WIND_EVERY) return null;

          return yield* Effect.tryPromise(() => fetchWind(now));
        }),
    }),
  });

  return { logs, routes: routeMemory.known };
});
