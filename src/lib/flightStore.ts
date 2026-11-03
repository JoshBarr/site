import { z } from "zod";
import type { Poll } from "./fold";
import { Aircraft, Fix, HISTORY, Route, RouteEnd } from "./flights";
import type { flights, LiveData } from "./liveRecords";
import { toNztm } from "./nztm";
import { readJson } from "./schemas";

// Aircraft around Wellington from adsb.lol, a free community ADS-B network.
// It keeps no history we can use, so the AWS poller logs what it hears (see
// plans/dynamo.md) and trails are folded from that.

const WLG: [number, number] = [-41.327, 174.805];

/** Nautical miles; past the terrain's edge fade (~31 km). */
const RADIUS = 25;
const API = `https://api.adsb.lol/v2/point/${WLG[0]}/${WLG[1]}/${RADIUS}`;

/** Positions older than this, seconds, are left out. */
const MAX_SEEN_POS = 60;

const FEET = 0.3048;
const KNOTS = 1852 / 3600;
const FEET_PER_MINUTE = FEET / 60;

/** What readsb reports for each aircraft, as much of it as we read. */
const report = z.object({
  hex: z.string(),
  flight: z.string().optional(),
  r: z.string().optional(),
  t: z.string().optional(),
  category: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  seen_pos: z.number().optional(),
  /** Feet on the standard pressure setting, or "ground". */
  alt_baro: z.union([z.number(), z.literal("ground")]).optional(),
  /** Feet above the WGS84 ellipsoid, from GNSS. */
  alt_geom: z.number().optional(),
  /** Knots. */
  gs: z.number().optional(),
  track: z.number().optional(),
  true_heading: z.number().optional(),
  /** Feet per minute. */
  geom_rate: z.number().optional(),
  baro_rate: z.number().optional(),
});

type Report = z.infer<typeof report>;

const airspace = z.object({
  /** Epoch ms. */
  now: z.number(),
  ac: z.array(report).optional(),
});

export interface Sighting {
  aircraft: Omit<Aircraft, "fixes" | "route">;
  fix: Fix;
  /** Latitude and longitude, when just heard (not stored). */
  at?: [number, number];
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor(sorted.length / 2)];
}

/** Everything in the air (or taxiing) around Wellington right now. */
export async function fetchAirspace(): Promise<Sighting[]> {
  const response = await fetch(API, {
    headers: { "User-Agent": "joshbarr.com scene" },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) throw new Error(`adsb.lol: HTTP ${response.status}`);
  const { now, ac } = await readJson(response, airspace, "adsb.lol");

  const reports = (ac ?? []).filter(
    (r): r is Report & { lat: number; lon: number } =>
      r.lat !== undefined &&
      r.lon !== undefined &&
      (r.seen_pos ?? 0) <= MAX_SEEN_POS &&
      // C1–C3 are airport vehicles and obstacles.
      !r.category?.startsWith("C")
  );

  // Pressure altitude is off by the day's pressure (hundreds of feet), so
  // aircraft without GNSS altitude are corrected by how far the others are.
  // GNSS heights are above the ellipsoid; the geoid here is a few tens of
  // metres off that, which is left alone.
  const offsets = reports.flatMap(({ alt_baro: baro, alt_geom: geom }) =>
    baro !== undefined && baro !== "ground" && geom !== undefined
      ? [geom - baro]
      : []
  );

  const baroOffset = offsets.length ? median(offsets) : 0;

  return reports.flatMap((r): Sighting[] => {
    const baro = r.alt_baro === "ground" ? undefined : r.alt_baro;

    const feet =
      r.alt_baro === "ground"
        ? null
        : (r.alt_geom ?? (baro === undefined ? undefined : baro + baroOffset));

    if (feet === undefined) return [];
    const [easting, northing] = toNztm(r.lat, r.lon);
    const rate = r.geom_rate ?? r.baro_rate;

    return [
      {
        aircraft: {
          hex: r.hex,
          callsign: r.flight?.trim() || null,
          registration: r.r ?? null,
          type: r.t ?? null,
          category: r.category ?? null,
        },
        fix: [
          Math.round(easting),
          Math.round(northing),
          feet === null ? null : Math.round(feet * FEET),
          // Whole seconds: re-reports of the same position then collide.
          Math.round((now - (r.seen_pos ?? 0) * 1000) / 1000) * 1000,
          (r.gs ?? 0) * KNOTS,
          r.track ?? r.true_heading ?? null,
          rate === undefined ? null : rate * FEET_PER_MINUTE,
        ],
        at: [r.lat, r.lon],
      },
    ];
  });
}

// Routes come from adsb.im's lookup by callsign (adsb.lol's own returns
// nothing), with every airport the callsign stops at. Which leg an aircraft
// is flying is picked from its own fixes when it's drawn.

const ROUTES = "https://adsb.im/api/0/routeset";

/**
 * Airports further than this from Wellington, km, are replaced by a point
 * this far along the way to them: beyond the scene, and the projection
 * holds up.
 */
const ROUTE_REACH = 300;
const EARTH_RADIUS = 6371;

const routeReplies = z.array(
  z.object({
    callsign: z.string(),
    /** Missing when the callsign isn't known. */
    plausible: z.union([z.boolean(), z.number()]).optional(),
    _airports: z
      .array(
        z.object({
          iata: z.string(),
          lat: z.number(),
          lon: z.number(),
          alt_meters: z.number().optional(),
        })
      )
      .optional(),
  })
);

type RouteReply = z.infer<typeof routeReplies>[number];

export type LatLon = [number, number];

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Angle between two points on the globe, radians. */
function arc([lat1, lon1]: LatLon, [lat2, lon2]: LatLon) {
  const a =
    Math.sin(radians(lat2 - lat1) / 2) ** 2 +
    Math.cos(radians(lat1)) *
      Math.cos(radians(lat2)) *
      Math.sin(radians(lon2 - lon1) / 2) ** 2;

  return 2 * Math.asin(Math.min(Math.sqrt(a), 1));
}

/** The point `fraction` of the way from `a` to `b` along the great circle. */
function along(a: LatLon, b: LatLon, fraction: number): LatLon {
  const d = arc(a, b);
  const wa = Math.sin((1 - fraction) * d) / Math.sin(d);
  const wb = Math.sin(fraction * d) / Math.sin(d);

  const cartesian = ([lat, lon]: LatLon) => [
    Math.cos(radians(lat)) * Math.cos(radians(lon)),
    Math.cos(radians(lat)) * Math.sin(radians(lon)),
    Math.sin(radians(lat)),
  ];

  const pa = cartesian(a);
  const pb = cartesian(b);
  const [x, y, z] = pa.map((v, i) => wa * v + wb * pb[i]);

  return [
    (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
    (Math.atan2(y, x) * 180) / Math.PI,
  ];
}

function toRouteEnd(
  airport: NonNullable<RouteReply["_airports"]>[number]
): RouteEnd {
  const at: LatLon = [airport.lat, airport.lon];
  const distance = arc(WLG, at) * EARTH_RADIUS;
  const near = distance <= ROUTE_REACH;

  const [easting, northing] = toNztm(
    ...(near ? at : along(WLG, at, ROUTE_REACH / distance))
  );

  return {
    code: airport.iata,
    at: [Math.round(easting), Math.round(northing)],
    elevation: near ? (airport.alt_meters ?? 0) : null,
  };
}

/** adsb.im's routes for the callsigns in `wanted`, each asked where it is. */
async function askRoutes(wanted: Map<string, LatLon>) {
  const response = await fetch(ROUTES, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "joshbarr.com scene",
    },
    body: JSON.stringify({
      planes: [...wanted].map(([callsign, [lat, lng]]) => ({
        callsign,
        lat,
        lng,
      })),
    }),
    signal: AbortSignal.timeout(4000),
  });

  if (!response.ok) throw new Error(`adsb.im: HTTP ${response.status}`);

  return readJson(response, routeReplies, "adsb.im");
}

/**
 * Every airport on each callsign's route in `wanted` (asked where it is),
 * far ones pulled in as `toRouteEnd` does, or null if adsb.im doesn't know
 * it. For the AWS poller, which stores them all and leaves picking the leg
 * to whoever draws the aircraft. Callsigns adsb.im doesn't answer for are
 * left out.
 */
export async function lookupRoutes(wanted: Map<string, LatLon>) {
  const routes = new Map<string, RouteEnd[] | null>();
  const replies = await askRoutes(wanted);

  for (const { callsign, plausible, _airports: airports } of replies) {
    if (!wanted.has(callsign)) continue;

    routes.set(
      callsign,
      plausible && airports && airports.length >= 2
        ? airports.map(toRouteEnd)
        : null
    );
  }

  return routes;
}

/** Metres between two NZTM points. */
const distance = ([e1, n1]: [number, number], [e2, n2]: [number, number]) =>
  Math.hypot(e2 - e1, n2 - n1);

/**
 * How much further out of its way a leg flown backwards counts as, m: it's
 * picked only if no other will do.
 */
const BACKWARDS = 1_000_000;

/** How far an aircraft has to have moved to go by that, not its track, m. */
const MOVED = 1000;

/**
 * The leg of a route with `airports` that an aircraft with `fixes` (oldest
 * first) is flying: the one it's least out of its way on, of those it's
 * heading along. Which way it's heading is how it's moved over its fixes,
 * or if it's barely moved, its track. So of legs into and out of
 * Wellington, one arriving gets the leg in and one leaving the leg out.
 */
export function pickLeg(airports: RouteEnd[], fixes: Fix[]): Route {
  const [e0, n0] = fixes[0];
  const [e, n, , , , track] = fixes[fixes.length - 1];
  const moved = [e - e0, n - n0];

  const heading =
    Math.hypot(moved[0], moved[1]) > MOVED
      ? moved
      : track === null
        ? null
        : [Math.sin(radians(track)), Math.cos(radians(track))];

  let best = 0;
  let least = Infinity;

  for (let i = 0; i < airports.length - 1; i++) {
    const a = airports[i].at;
    const b = airports[i + 1].at;
    const detour = distance(a, [e, n]) + distance([e, n], b) - distance(a, b);

    const backwards =
      heading !== null &&
      heading[0] * (b[0] - a[0]) + heading[1] * (b[1] - a[1]) < 0;

    const score = detour + (backwards ? BACKWARDS : 0);

    if (score < least) [best, least] = [i, score];
  }

  return { from: airports[best], to: airports[best + 1] };
}

/**
 * Every aircraft heard in `polls` (oldest first) since `since`, each with
 * its fixes in time order and the newest details heard. `routes` has every
 * airport on each callsign's route, or null if it isn't known; an aircraft
 * whose callsign isn't in it couldn't be looked up, and has no `route`.
 */
export function foldFlights(
  polls: Poll<LiveData<typeof flights>>[],
  routes: ReadonlyMap<string, RouteEnd[] | null>,
  since = Date.now() - HISTORY
): Aircraft[] {
  const byHex = new Map<string, Aircraft>();

  for (const { data } of polls) {
    for (const { aircraft, fix } of data.sightings) {
      if (fix[3] <= since) continue;
      const known = byHex.get(aircraft.hex);

      if (!known) {
        byHex.set(aircraft.hex, { ...aircraft, fixes: [fix] });
        continue;
      }

      known.fixes.push(fix);

      for (const key of ["callsign", "registration", "type", "category"]) {
        known[key] = aircraft[key] ?? known[key];
      }
    }
  }

  for (const aircraft of byHex.values()) {
    aircraft.fixes.sort((a, b) => a[3] - b[3]);
    aircraft.fixes = aircraft.fixes.filter(
      (fix, i, fixes) => i === 0 || fix[3] !== fixes[i - 1][3]
    );

    const { callsign } = aircraft;

    if (!callsign) {
      aircraft.route = null;
    } else if (routes.has(callsign)) {
      const airports = routes.get(callsign);

      aircraft.route = airports ? pickLeg(airports, aircraft.fixes) : null;
    }
  }

  return [...byHex.values()];
}
