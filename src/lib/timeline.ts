import { fresh as busesShown } from "./buses";
import type { Poll } from "./fold";
import type {
  buses,
  flights,
  LiveData,
  metar,
  quakes,
  tide,
  traffic,
  trains,
  vessels,
  weather,
} from "./liveRecords";
import { withObserved } from "./metar";
import { STALE as SPEEDS_STALE } from "./traffic";
import { fresh as trainsShown } from "./trains";
import { isStale as shipGone, UNDER_WAY } from "./vessels";

// The scene's day in numbers, for the time-travel timeline: once a minute
// the poller counts what's out (trains, buses, aircraft, ships under way)
// and notes the roads, tide and weather, and adds that to the hour's item
// in the `timeline` collection (liveRecords.ts), as a sum and a count per
// five-minute slot. So a day is 24 small items, read in one query, however
// busy the logs it was counted from.

/** A slot's length, ms. */
export const SLOT = 5 * 60_000;

/** An item's length, ms: it starts on the hour (UTC, so NZ's too). */
export const HOUR = 3_600_000;

/** Slots in an hour's item. */
export const SLOTS = HOUR / SLOT;

/** What's counted or measured each minute, in the order it's drawn. */
export const METRICS = [
  "flights",
  "ships",
  "trains",
  "buses",
  "roads",
  "tide",
  "temperature",
  "rain",
  "cloud",
  "wind",
] as const;

export type Metric = (typeof METRICS)[number];

/** One minute's numbers: null where there's nothing to go by. */
export type Sample = Record<Metric, number | null>;

/** A quake in the timeline, as GeoNet had it when it was last counted. */
interface TimelineQuake {
  id: string;
  /** Origin time, epoch ms. */
  time: number;
  magnitude: number;
  /** km. */
  depth: number;
  locality: string;
}

/**
 * An hour's item: each metric's samples summed per slot, and how many
 * there were, so each slot's mean is one over the other and minutes add up
 * in any order. A metric added later is missing from older items.
 */
export interface TimelineHour {
  sums: Partial<Record<Metric, number[]>>;
  counts: Partial<Record<Metric, number[]>>;
  /** Quakes GeoNet reported in the hour, wherever they happened. */
  quakes: TimelineQuake[];
}

/** Decimal places each metric's sums are kept to. */
const PLACES: Record<Metric, number> = {
  flights: 0,
  ships: 0,
  trains: 0,
  buses: 0,
  roads: 1,
  tide: 3,
  temperature: 2,
  rain: 2,
  cloud: 3,
  wind: 2,
};

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

/** An aircraft's fix this old is it gone, ms: adsb.lol's in a second or so. */
const HEARD = 60_000;

/** The tide's carried on from the gauge's newest minute for this long, ms. */
const TIDE_KEPT = 15 * 60_000;

/** Conditions are for their hour; past this, ms, they're no use. */
const WEATHER_KEPT = 2 * HOUR;

/** The newest poll of each log, as the poller or a replay has it. */
export interface Latest {
  trains?: Poll<LiveData<typeof trains>>;
  buses?: Poll<LiveData<typeof buses>>;
  flights?: Poll<LiveData<typeof flights>>;
  vessels?: Poll<LiveData<typeof vessels>>;
  traffic?: Poll<LiveData<typeof traffic>>;
  weather?: Poll<LiveData<typeof weather>>;
  metar?: Poll<LiveData<typeof metar>>;
  tide?: Poll<LiveData<typeof tide>>;
}

/**
 * Mean speed over the links NZTA has, weighted by their length (in the
 * key, after the `|`), km/h.
 */
function meanSpeed(links: Record<string, number>) {
  let distance = 0;
  let sum = 0;

  for (const [key, speed] of Object.entries(links)) {
    const length = Number(key.slice(key.lastIndexOf("|") + 1)) || 0;

    distance += length;
    sum += length * speed;
  }

  return distance ? sum / distance : null;
}

/**
 * What's out at `now`, going by each log's newest poll: what the scene would
 * draw. A log with no poll at all is null, not none: there's no knowing.
 * An old poll counts as nothing, as it does in the scene: trains and buses
 * aren't written overnight, when there's nothing new.
 */
export function sample(latest: Latest, now: number): Sample {
  const { trains, buses, flights, vessels, traffic, weather, metar, tide } =
    latest;

  // As the scene has them: the airport's observations over the forecast.
  const conditions =
    weather && now - weather.sk < WEATHER_KEPT
      ? withObserved(weather.data, metar?.data, now)
      : null;

  return {
    flights: flights
      ? flights.data.sightings.filter(
          ({ fix }) => fix[2] !== null && now - fix[3] < HEARD
        ).length
      : null,
    ships: vessels
      ? vessels.data.vessels.filter(
          (ship) => ship.speed > UNDER_WAY && !shipGone(ship, now)
        ).length
      : null,
    trains: trains ? trainsShown(trains.data.trains, now).length : null,
    buses: buses ? busesShown(buses.data.buses, now).length : null,
    roads:
      traffic && now - traffic.sk < SPEEDS_STALE
        ? meanSpeed(traffic.data.links)
        : null,
    tide:
      tide && now - tide.data.time < TIDE_KEPT
        ? tide.data.level + (tide.data.rate * (now - tide.data.time)) / HOUR
        : null,
    temperature: conditions?.temperature ?? null,
    // MetService's rate can come back a hair below zero.
    rain: conditions ? Math.max(0, conditions.precipitation) : null,
    cloud: conditions ? Math.max(0, conditions.cloudCover) : null,
    wind: conditions?.wind.speed ?? null,
  };
}

/** The hour `time` (epoch ms) is in: when it started. */
export const hourOf = (time: number) => Math.floor(time / HOUR) * HOUR;

const empty = (): TimelineHour => ({ sums: {}, counts: {}, quakes: [] });

/**
 * `hour` (the item for the hour `time` is in, or null for a new one) with
 * `taken` added to `time`'s slot, and `heard` (GeoNet's quakes) noted if
 * they happened in the hour or the one before: each once, as last revised.
 */
export function addSample(
  hour: TimelineHour | null,
  time: number,
  taken: Sample,
  heard: LiveData<typeof quakes>["quakes"] = []
): TimelineHour {
  const start = hourOf(time);
  const slot = Math.floor((time - start) / SLOT);
  const { sums, counts, quakes: noted } = hour ?? empty();
  const next = empty();

  for (const metric of METRICS) {
    const sum = [...(sums[metric] ?? Array<number>(SLOTS).fill(0))];
    const count = [...(counts[metric] ?? Array<number>(SLOTS).fill(0))];
    const value = taken[metric];

    if (value !== null) {
      sum[slot] = round(sum[slot] + value, PLACES[metric]);
      count[slot] += 1;
    }

    // Left out until it's had a sample.
    if (count.some(Boolean)) {
      next.sums[metric] = sum;
      next.counts[metric] = count;
    }
  }

  const byId = new Map(noted.map((quake) => [quake.id, quake]));

  for (const { id, time: when, magnitude, depth, locality } of heard) {
    if (when >= start - HOUR && when <= time) {
      byId.set(id, {
        id,
        time: when,
        magnitude: round(magnitude, 1),
        depth: Math.round(depth),
        locality,
      });
    }
  }

  next.quakes = [...byId.values()].sort((a, b) => a.time - b.time);

  return next;
}

const ZONE = "Pacific/Auckland";

const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** NZ's wall clock at `time`, as if it were UTC, epoch ms. */
function wallClock(time: number) {
  const parts = Object.fromEntries(
    dateParts.formatToParts(time).map(({ type, value }) => [type, value])
  );

  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute)
  );
}

/** The NZ date `time` (epoch ms) falls on, YYYY-MM-DD. */
export const nzDate = (time: number) =>
  new Date(wallClock(time)).toISOString().slice(0, 10);

/** A YYYY-MM-DD date. */
export const DATE = /^\d{4}-\d\d-\d\d$/;

/** When the NZ date `day` (YYYY-MM-DD) began, epoch ms. */
export function nzMidnight(day: string) {
  const wall = Date.parse(`${day}T00:00:00Z`);

  // Back by NZ's offset from UTC then: twice, in case it's a daylight
  // saving change away.
  let time = wall;

  for (let i = 0; i < 2; i++) time = wall - (wallClock(time) - time);

  return time;
}

/** The NZ date after `day`. */
export const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);

/** A day of the timeline, as /api/timeline serves it. */
export interface TimelineDay {
  day: string;
  /** When it began and ends, epoch ms: 23 or 25 hours apart at changes. */
  start: number;
  end: number;
  /** Each metric's mean per slot from `start`, null where it's unknown. */
  series: Partial<Record<Metric, (number | null)[]>>;
  /** The quakes that happened that day. */
  quakes: TimelineQuake[];
}

/**
 * The NZ date `day` from the hours' items (by when each began) that cover
 * it, and the hour after it, for quakes reported after midnight.
 */
export function toDay(
  day: string,
  hours: { sk: number; data: TimelineHour }[]
): TimelineDay {
  const start = nzMidnight(day);
  const end = nzMidnight(nextDay(day));
  const length = (end - start) / SLOT;
  const series: TimelineDay["series"] = {};
  const quakes = new Map<string, TimelineQuake>();

  for (const { sk, data } of hours) {
    for (const quake of data.quakes) {
      if (quake.time >= start && quake.time < end) quakes.set(quake.id, quake);
    }

    if (sk < start || sk >= end) continue;

    const offset = (sk - start) / SLOT;

    for (const metric of METRICS) {
      const sums = data.sums[metric];
      const counts = data.counts[metric];

      if (!sums || !counts) continue;

      const means = (series[metric] ??= Array<number | null>(length).fill(
        null
      ));

      for (let i = 0; i < SLOTS; i++) {
        if (counts[i]) {
          means[offset + i] = round(sums[i] / counts[i], PLACES[metric] + 1);
        }
      }
    }
  }

  return {
    day,
    start,
    end,
    series,
    quakes: [...quakes.values()].sort((a, b) => a.time - b.time),
  };
}
