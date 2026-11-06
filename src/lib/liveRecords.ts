import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { Bus } from "./buses";
import type { CableCarTrip, Timetable } from "./cablecar";
import type { Fix, RouteEnd } from "./flights";
import type { Sighting } from "./flightStore";
import type { Quake } from "./quakes";
import type { Gauge, Rainfall } from "./rainGauges";
import { orbit } from "./satellites";
import { point, trailPoint } from "./schemas";
import type { TrafficSpeeds } from "./traffic";
import type { Tide } from "./tide";
import { METRICS, SLOTS, type TimelineHour } from "./timeline";
import type { Train } from "./trains";
import type { Vessel } from "./vessels";
import type { Conditions } from "./weather";
import type { StationReading, WindReadings } from "./windStations";

// The live table's items (see plans/dynamo.md), as the AWS poller writes
// them and the site reads them. Each collection's schema is a codec between
// a DynamoDB item, attribute by attribute, and the record it holds: decoded
// to read, encoded to write, and checked both ways. Payloads are gzipped
// JSON in `data`; `v` is their format, and an item of a version a schema
// doesn't know doesn't decode, so it's skipped.

const DAY = 24 * 3600;

/** A string attribute that's always `value`. */
const key = <const K extends string>(value: K) =>
  z.codec(z.object({ S: z.literal(value) }), z.literal(value), {
    decode: ({ S }) => S,
    encode: (s) => ({ S: s }),
  });

/** A number attribute that's always `value`: an item's format version. */
const version = <const V extends number>(value: V) =>
  z.codec(z.object({ N: z.literal(`${value}`) }), z.literal(value), {
    decode: () => value,
    encode: () => ({ N: `${value}` as const }),
  });

const number = z.codec(z.object({ N: z.string() }), z.number(), {
  decode: ({ N }) => Number(N),
  encode: (n) => ({ N: String(n) }),
});

/** Epoch ms, zero-padded to sort as a string (until 2286). */
export const sortTime = (time: number) => String(time).padStart(13, "0");

/** A sort key that's a time: when a log's poll or a route's lookup was. */
const time = z.codec(
  z.object({ S: z.string().regex(/^\d{13}$/) }),
  z.number().int().nonnegative(),
  {
    decode: ({ S }) => Number(S),
    encode: (t) => ({ S: sortTime(t) }),
  }
);

/** JSON, gzipped into a binary attribute. */
const gzipped = <T extends z.ZodType>(schema: T) =>
  z.codec(z.object({ B: z.instanceof(Uint8Array) }), schema, {
    decode: ({ B }, payload) => {
      try {
        return JSON.parse(gunzipSync(B).toString());
      } catch {
        payload.issues.push({
          code: "custom",
          message: "not gzipped JSON",
          input: B,
        });

        return z.NEVER;
      }
    },
    encode: (value) => ({ B: gzipSync(JSON.stringify(value)) }),
  });

/** One of the table's collections: its partition, and what's in it. */
const collection = <
  const P extends string,
  const V extends number,
  K extends z.ZodType,
  D extends z.ZodType,
>(
  pk: P,
  v: V,
  { sk, data, ttl }: { sk: K; data: D; ttl: number }
) => ({
  pk,
  v,
  /** Seconds an item's kept after it's written. */
  ttl,
  schema: z.object({
    pk: key(pk),
    sk,
    v: version(v),
    data: gzipped(data),
    /** Epoch seconds: DynamoDB's TTL. */
    expires: number,
  }),
});

/** One poll of a feed, kept for replays. */
const log = <const P extends string, D extends z.ZodType>(pk: P, data: D) =>
  collection(pk, 1, { sk: time, data, ttl: 30 * DAY });

type Schema = { schema: z.ZodType<{ sk: unknown; data: unknown }> };

/** A collection's item, as its schema reads it. */
export type LiveRecord<C extends Schema> = z.output<C["schema"]>;

/** What's in an item's `data`. */
export type LiveData<C extends Schema> = LiveRecord<C>["data"];

/** `data` as `c`'s item with sort key `sk`, written at `written` (epoch ms). */
export const toRecord = <
  C extends Schema & { pk: string; v: number; ttl: number },
>(
  c: C,
  sk: LiveRecord<C>["sk"],
  data: LiveData<C>,
  written: number
) =>
  // SAFETY: c's pk and v, which its schema checks are its own when the
  // record's encoded.
  ({
    pk: c.pk,
    sk,
    v: c.v,
    data,
    expires: Math.floor(written / 1000) + c.ttl,
  }) as LiveRecord<C>;

export const trainFix = z.object({
  id: z.string(),
  line: z.enum(["KPL", "HVL", "MEL", "WRL", "JVL"]),
  direction: z.number(),
  position: point,
  bearing: z.number().nullable(),
  time: z.number(),
}) satisfies z.ZodType<Omit<Train, "trail">>;

export const busFix = z.object({
  id: z.string(),
  route: z.string(),
  direction: z.number(),
  position: point,
  bearing: z.number().nullable(),
  time: z.number(),
}) satisfies z.ZodType<Omit<Bus, "trail">>;

export const fix = z.tuple([
  z.number(),
  z.number(),
  z.number().nullable(),
  z.number(),
  z.number(),
  z.number().nullable(),
  z.number().nullable(),
]) satisfies z.ZodType<Fix>;

export const routeEnd = z.object({
  code: z.string(),
  at: point,
  elevation: z.number().nullable(),
}) satisfies z.ZodType<RouteEnd>;

/** What adsb.lol says about an aircraft, besides where it is. */
export const aircraftDetails = z.object({
  hex: z.string(),
  callsign: z.string().nullable(),
  registration: z.string().nullable(),
  type: z.string().nullable(),
  category: z.string().nullable(),
});

const sighting = z.object({
  aircraft: aircraftDetails,
  fix,
}) satisfies z.ZodType<Omit<Sighting, "at">>;

export const vessel = z.object({
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
}) satisfies z.ZodType<Vessel>;

const wind = z.object({ speed: z.number(), direction: z.number() });

/** Every train Metlink reported, on the map, without trails. */
export const trains = log("trains", z.object({ trains: z.array(trainFix) }));

/** Every bus on a trip Metlink reported, on the map, without trails. */
export const buses = log("buses", z.object({ buses: z.array(busFix) }));

/** Everything adsb.lol heard around Wellington: one fix each, no routes. */
export const flights = log(
  "flights",
  z.object({ sightings: z.array(sighting) })
);

/**
 * Every ship in the harbour, moored ones without a heading given the last
 * one known. A ship under way is placed by the newest point of its track,
 * and its trail is the track fetched since the last poll's.
 */
export const vessels = log("vessels", z.object({ vessels: z.array(vessel) }));

export const speeds = z.object({
  links: z.record(z.string(), z.number()),
  legs: z.record(z.string(), z.number()),
}) satisfies z.ZodType<TrafficSpeeds>;

export const conditions = z.object({
  time: z.string(),
  cloudCover: z.number(),
  cloudBase: z.number().nullable(),
  visibility: z.number(),
  humidity: z.number(),
  precipitation: z.number(),
  temperature: z.number().nullable().optional(),
  wind,
  windAloft: wind,
}) satisfies z.ZodType<Conditions>;

export const quake = z.object({
  id: z.string(),
  time: z.number(),
  position: point,
  depth: z.number(),
  magnitude: z.number(),
  locality: z.string(),
  quality: z.string(),
}) satisfies z.ZodType<Quake>;

export const seaLevel = z.object({
  time: z.number(),
  level: z.number(),
  rate: z.number(),
}) satisfies z.ZodType<Tide>;

const gauge = z.object({
  position: point,
  rate: z.number(),
}) satisfies z.ZodType<Gauge>;

export const gauges = z.object({
  time: z.number(),
  gauges: z.array(gauge),
}) satisfies z.ZodType<Rainfall>;

const stationReading = z.object({
  site: z.string(),
  speed: z.number(),
  direction: z.number(),
  at: z.number(),
}) satisfies z.ZodType<StationReading>;

export const windReadings = z.object({
  time: z.number(),
  stations: z.array(stationReading),
}) satisfies z.ZodType<WindReadings>;

/** NZTA's speeds. */
export const traffic = log("traffic", speeds);

/** MetService's conditions for the hour. */
export const weather = log("weather", conditions);

/**
 * The quakes GeoNet's heard of lately that are on the map or were felt in
 * Wellington, as it last had them: written when that changes.
 */
export const quakes = log("quakes", z.object({ quakes: z.array(quake) }));

/** The harbour's height above mean sea level, every five minutes. */
export const tide = log("tide", seaLevel);

/** How hard it's raining at each of GWRC's gauges, every five minutes. */
export const rain = log("rain", gauges);

/** The wind at each of GWRC's weather stations, every five minutes. */
export const windStations = log("wind", windReadings);

/** Every airport on a callsign's route, or null if adsb.im doesn't know it. */
export const routes = collection("routes", 1, {
  // `<callsign>#<lookup time>`, so a callsign's newest is a prefix away.
  sk: z.codec(
    z.object({ S: z.string().regex(/^[^#]+#\d{13}$/) }),
    z.object({ callsign: z.string().min(1), time: z.number() }),
    {
      decode: ({ S }) => {
        const [callsign, t] = S.split("#");

        return { callsign, time: Number(t) };
      },
      encode: ({ callsign, time: t }) => ({ S: `${callsign}#${sortTime(t)}` }),
    }
  ),
  data: z.object({ airports: z.array(routeEnd).min(2).nullable() }),
  ttl: 30 * DAY,
});

/** The sort key prefix of a callsign's routes. */
export const routePrefix = (callsign: string) => `${callsign}#`;

/** Which way a ship last pointed, by MMSI: forgotten a week after. */
export const headings = collection("headings", 1, {
  sk: z.codec(z.object({ S: z.string().regex(/^\d+$/) }), z.number(), {
    decode: ({ S }) => Number(S),
    encode: (mmsi) => ({ S: String(mmsi) }),
  }),
  data: z.object({ heading: z.number() }),
  ttl: 7 * DAY,
});

/** A GTFS day, YYYYMMDD. */
const day = z.string().regex(/^\d{8}$/);

const cableCarTrip = z.object({
  service: z.string(),
  direction: z.number(),
  stops: z.array(z.tuple([z.string(), z.number()])).min(2),
}) satisfies z.ZodType<CableCarTrip>;

const timetable = z.object({
  etag: z.string(),
  start: day,
  end: day,
  services: z.record(z.string(), z.array(day)),
  trips: z.array(cableCarTrip),
}) satisfies z.ZodType<Timetable>;

/**
 * The cable car's timetable, from Metlink's GTFS feed: one item, written
 * over when the feed has a new one. That's every few weeks, so it's kept a
 * year from each write, however long the feed stays the same.
 */
export const cableCar = collection("cablecar", 1, {
  sk: key("timetable"),
  data: timetable,
  ttl: 365 * DAY,
});

const slots = z.array(z.number()).length(SLOTS);

const timelineHour = z.object({
  sums: z.partialRecord(z.enum(METRICS), slots),
  counts: z.partialRecord(z.enum(METRICS), slots),
  quakes: z.array(
    z.object({
      id: z.string(),
      time: z.number(),
      magnitude: z.number(),
      depth: z.number(),
      locality: z.string(),
    })
  ),
}) satisfies z.ZodType<TimelineHour>;

/**
 * An hour of the time-travel timeline (./timeline.ts), by when it began:
 * rewritten each minute with that minute added. Kept for a year, though
 * replays only go back 30 days: it's ~1 KB an hour.
 */
export const timeline = collection("timeline", 1, {
  sk: time,
  data: timelineHour,
  ttl: 366 * DAY,
});

/**
 * The visual satellites' orbits, from CelesTrak (./satellites.ts), as they
 * were fetched each day: a replay runs them on from the day's. Kept a little
 * longer than replays go back.
 */
export const satellites = collection("satellites", 1, {
  sk: time,
  data: z.object({ orbits: z.array(orbit) }),
  ttl: 35 * DAY,
});
