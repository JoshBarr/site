import type { CableCarTrip, Timetable } from "../../../lib/cablecar";

// Where the cable car's two cars are, from its timetable. They're tied to
// one cable over the top: as one goes down the other comes up, and they
// stop together and cross at Talavera, in the middle. So the timetable's
// runs are the cable's: each takes the car at the top down, and with it the
// other one up, and the next starts with the other car at the top.
// Positions are along the line, 0 at Kelburn to 1 at Lambton Quay.

/**
 * Seconds a car stands at each stop between the ends. Guessed: the feed
 * gives one time per stop, taken as the middle of it.
 */
const DWELL = 16;

/** Where each stop is along the line, by Metlink's stop id. */
export type Stops = Record<string, number>;

/**
 * One run of the cable: when it's at each stop, epoch ms, and where the car
 * going down is then, and the car coming up.
 */
export interface Run {
  times: number[];
  at: number[];
  up: number[];
  /** Which car's at the top when it starts, and goes down: 0 or 1. */
  down: number;
}

type Schedule = Omit<Timetable, "etag">;

const ZONE = "Pacific/Auckland";

const dates = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const clock = new Intl.DateTimeFormat("en-NZ", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** The day in Wellington at `time` (epoch ms), YYYYMMDD. */
export const dayAt = (time: number) => dates.format(time).replaceAll("-", "");

const utc = (day: string) =>
  Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(4, 6)) - 1,
    Number(day.slice(6))
  );

/** `day` moved by `days`. */
export const addDays = (day: string, days: number) =>
  new Date(utc(day) + days * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");

/** Wellington time ahead of UTC at `time`, ms. */
function offsetAt(time: number) {
  const parts = Object.fromEntries(
    clock.formatToParts(time).map(({ type, value }) => [type, Number(value)])
  );

  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) -
    Math.floor(time / 1000) * 1000
  );
}

/**
 * When a GTFS service day's times count from, epoch ms: noon less 12 hours,
 * Wellington time. (Midnight, but on the days the clocks change.)
 */
export function dayStart(day: string) {
  // At 00:00 UTC it's noon or 1 pm in Wellington, after the clocks change
  // (in the small hours): noon's offset.
  return utc(day) - offsetAt(utc(day));
}

/**
 * The day whose services run on `day`: itself, if the feed covers it, or
 * else the nearest the same day of the week that it does, so a replay from
 * before this feed (or a day past its end) still has the cars running.
 */
export function coveredDay(timetable: Schedule, day: string) {
  if (day < timetable.start) {
    const weeks = Math.ceil((utc(timetable.start) - utc(day)) / 604_800_000);

    return addDays(day, weeks * 7);
  }

  if (day > timetable.end) {
    const weeks = Math.ceil((utc(day) - utc(timetable.end)) / 604_800_000);

    return addDays(day, -weeks * 7);
  }

  return day;
}

/**
 * Where the car coming up is when the one going down is `at`. They're on
 * one cable, so they reach the stops in pairs, top with bottom and inward
 * (Talavera, in the middle, with itself), and stand at them together; in
 * between, in proportion.
 */
function pairing(stops: Stops) {
  const places = [...new Set([0, ...Object.values(stops), 1])].sort(
    (a, b) => a - b
  );

  const n = places.length - 1;

  return (at: number) => {
    let k = 1;

    while (k < n && places[k] < at) k++;
    const t = (at - places[k - 1]) / (places[k] - places[k - 1] || 1);

    return places[n - k + 1] + (places[n - k] - places[n - k + 1]) * t;
  };
}

/** A trip as a run of the cable, given when its day starts; null if unplaced. */
function toRun(
  { direction, stops: calls }: CableCarTrip,
  stops: Stops,
  opposite: (at: number) => number,
  start: number
) {
  const times: number[] = [];
  const at: number[] = [];
  const up: number[] = [];

  for (const [stop, seconds] of calls) {
    const place = stops[stop];

    if (place === undefined) continue;
    times.push(start + seconds * 1000);
    at.push(direction === 1 ? place : opposite(place));
    up.push(direction === 1 ? opposite(place) : place);
  }

  return times.length > 1 ? { times, at, up } : null;
}

/**
 * The cable's runs on `day` (YYYYMMDD), in order. Both ways' trips leave
 * together, one car from each end, so where two start within a minute
 * they're the same run: going by the trip down.
 */
export function runsOn(timetable: Schedule, stops: Stops, day: string): Run[] {
  const services = coveredDay(timetable, day);
  const start = dayStart(day);

  const trips = timetable.trips
    .filter(({ service }) => timetable.services[service]?.includes(services))
    .sort((a, b) => b.direction - a.direction);

  const opposite = pairing(stops);
  const runs: Omit<Run, "down">[] = [];

  for (const trip of trips) {
    const run = toRun(trip, stops, opposite, start);

    if (!run) continue;

    if (runs.some(({ times }) => Math.abs(times[0] - run.times[0]) < 60_000)) {
      continue;
    }

    runs.push(run);
  }

  return runs
    .sort((a, b) => a.times[0] - b.times[0])
    .map((run, i) => ({ ...run, down: i % 2 }));
}

/** Eases from 0 to 1 and stops easing: a car pulling away and pulling in. */
const ease = (u: number) => u * u * (3 - 2 * u);

/**
 * How far down the line the cars on `run` are at `time`: the one going
 * down, and the one coming up.
 */
export function positionsAt(
  { times, at, up }: Run,
  time: number
): [number, number] {
  const last = times.length - 1;

  for (let k = 0; k < last; k++) {
    // Stands at stops between the ends either side of its time there.
    const leave = times[k] + (k > 0 ? (DWELL * 1000) / 2 : 0);
    const arrive = times[k + 1] - (k + 1 < last ? (DWELL * 1000) / 2 : 0);

    if (time <= leave) return [at[k], up[k]];

    if (time < arrive) {
      const u = ease((time - leave) / (arrive - leave));

      return [at[k] + (at[k + 1] - at[k]) * u, up[k] + (up[k + 1] - up[k]) * u];
    }
  }

  return [at[last], up[last]];
}

/**
 * Where each car is at `time` (epoch ms), 0 at the top to 1 at the bottom,
 * given that day's runs: before the first, as it starts; between runs, as
 * the last finished. (Overnight the cars may swap ends, at midnight. And a
 * run after midnight would be the day before's: the cable car has none.)
 */
export function carsAt(runs: Run[], time: number): [number, number] {
  if (!runs.length) return [0, 1];

  let run = runs[0];

  for (const next of runs) {
    if (next.times[0] > time) break;
    run = next;
  }

  return carsOn(run, time);
}

/** Where each car is at `time` on `run`, 0 at the top to 1 at the bottom. */
export function carsOn(run: Run, time: number): [number, number] {
  const [down, up] = positionsAt(run, time);

  return run.down === 0 ? [down, up] : [up, down];
}
