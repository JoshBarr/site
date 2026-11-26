// When the Carter Fountain runs: the council's fixed hours, and only while
// the wind's light. There's no live feed of it; its hours are from
// sculptures.org.nz (Wikipedia has the same), and its wind sensor, on the
// Band Rotunda, keeps it off at 10 knots or more.

/** Where it stands, NZTM: 150 m out from Oriental Bay (OSM node 170603342). */
export const FOUNTAIN: readonly [number, number] = [1750249.96, 5427518.32];

/** The Band Rotunda, where its wind sensor is (OSM way 195968976). */
export const ROTUNDA: readonly [number, number] = [1750287.35, 5427388.9];

/** Its sensor stops it at 10 knots, m/s. */
export const WIND_LIMIT = 10 * 0.514444;

/**
 * The wind's given as a ten-minute mean, but a sensor trips on what blows
 * now: gusts in a city run about this much over the mean. A guess.
 */
export const GUST_FACTOR = 1.3;

type Session = [from: number, to: number];

const at = (hours: number, minutes = 0) => hours * 60 + minutes;

const WEEKDAY: Session[] = [
  [at(7, 30), at(9)],
  [at(12), at(14)],
  [at(16, 30), at(18)],
  [at(19, 30), at(22, 30)],
];

const FRIDAY: Session[] = [...WEEKDAY.slice(0, 3), [at(19, 30), at(23)]];

const WEEKEND: Session[] = [
  [at(8, 30), at(16, 30)],
  [at(19), at(23)],
];

/** Its sessions by weekday, Sunday first, in minutes past local midnight. */
const HOURS: Session[][] = [
  WEEKEND,
  WEEKDAY,
  WEEKDAY,
  WEEKDAY,
  WEEKDAY,
  FRIDAY,
  WEEKEND,
];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const local = new Intl.DateTimeFormat("en-NZ", {
  timeZone: "Pacific/Auckland",
  weekday: "short",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

/** Whether its hours have it on at `time` (epoch ms), Wellington time. */
export function scheduled(time: number) {
  const parts = Object.fromEntries(
    local.formatToParts(time).map(({ type, value }) => [type, value])
  );

  const day = DAYS.indexOf(parts.weekday);
  const minutes = at(Number(parts.hour), Number(parts.minute));

  return HOURS[day].some(([from, to]) => minutes >= from && minutes < to);
}

/** Whether a mean wind of `speed` m/s at the rotunda trips its sensor. */
export const tooWindy = (speed: number) => speed * GUST_FACTOR >= WIND_LIMIT;

/** ?fountain=on or off holds it so, whatever its hours and the wind. */
export function forced(): boolean | null {
  const value = new URLSearchParams(location.search).get("fountain");

  return value === "on" ? true : value === "off" ? false : null;
}
