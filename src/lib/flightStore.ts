import { Aircraft, Fix, HISTORY, Route, RouteEnd } from "./flights";
import { toNztm } from "./nztm";
import { canStore, getRedis } from "./redis";

export { canStore };

// Aircraft around Wellington from adsb.lol, a free community ADS-B network.
// It keeps no history we can use, so fixes are stored in Upstash Redis as
// they're fetched (by visitors, and by a QStash schedule between visits) and
// the trails are built from those. Redis rather than Neon: writes every
// couple of minutes would keep Neon's compute awake around the clock.

/** Sorted set of stored sightings, scored by time. */
const KEY = "flights:fixes";

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
interface Report {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  category?: string;
  lat?: number;
  lon?: number;
  seen_pos?: number;
  /** Feet on the standard pressure setting, or "ground". */
  alt_baro?: number | "ground";
  /** Feet above the WGS84 ellipsoid, from GNSS. */
  alt_geom?: number;
  /** Knots. */
  gs?: number;
  track?: number;
  true_heading?: number;
  /** Feet per minute. */
  geom_rate?: number;
  baro_rate?: number;
}

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
  const { now, ac }: { now: number; ac?: Report[] } = await response.json();
  const reports = (ac ?? []).filter(
    (r) =>
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
  const offsets = reports
    .filter((r) => typeof r.alt_baro === "number" && r.alt_geom !== undefined)
    .map((r) => r.alt_geom - (r.alt_baro as number));
  const baroOffset = offsets.length ? median(offsets) : 0;

  return reports.flatMap((r): Sighting[] => {
    const onGround = r.alt_baro === "ground";
    const feet = onGround
      ? null
      : (r.alt_geom ??
        (typeof r.alt_baro === "number" ? r.alt_baro + baroOffset : undefined));
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

/** A sighting as stored: details, then the fix. Its score is the fix time. */
type Stored = [
  hex: string,
  callsign: string | null,
  registration: string | null,
  type: string | null,
  category: string | null,
  ...fix: Fix,
];

/**
 * Stores sightings for trails, and with `trim` forgets ones too old to be
 * drawn. A report heard twice is the same member, so it's kept once. Reads
 * only ask for recent ones, so trimming is left to the sweep: every visitor
 * request doing it would cost a Redis command each time for nothing.
 */
export async function saveSightings(
  sightings: Sighting[],
  { trim = false } = {}
) {
  if (!sightings.length) return;
  const [first, ...rest] = sightings.map(({ aircraft, fix }) => ({
    score: fix[3],
    member: [
      aircraft.hex,
      aircraft.callsign,
      aircraft.registration,
      aircraft.type,
      aircraft.category,
      ...fix,
    ] as Stored,
  }));
  const pipeline = getRedis().pipeline().zadd(KEY, first, ...rest);
  if (trim) pipeline.zremrangebyscore(KEY, 0, Date.now() - HISTORY - 60_000);
  await pipeline.exec();
}

/** Stored sightings from the last `since` ms, oldest first. */
export async function loadSightings(since: number): Promise<Sighting[]> {
  const stored = await getRedis().zrange<Stored[]>(
    KEY,
    Date.now() - since,
    "+inf",
    { byScore: true }
  );
  return stored.map(
    ([hex, callsign, registration, type, category, ...fix]) => ({
      aircraft: { hex, callsign, registration, type, category },
      fix: fix as Fix,
    })
  );
}

// Routes come from adsb.im's lookup by callsign (adsb.lol's own returns
// nothing), and are kept a day: a flight number flies the same route day
// after day. Each function instance also remembers the ones it's seen, so
// most requests don't ask Redis at all.

const ROUTES = "https://adsb.im/api/0/routeset";
const routeKey = (callsign: string) => `flights:route:${callsign}`;
/** Seconds a route is remembered, or that one isn't known. */
const ROUTE_TTL = 24 * 3600;
const UNKNOWN_TTL = 3600;

/** Routes this instance has seen, by callsign, with when to forget them. */
const remembered = new Map<string, { route: Route | null; until: number }>();

function remember(callsign: string, route: Route | null) {
  const ttl = route ? ROUTE_TTL : UNKNOWN_TTL;
  remembered.set(callsign, { route, until: Date.now() + ttl * 1000 });
}
/**
 * Airports further than this from Wellington, km, are replaced by a point
 * this far along the way to them: beyond the scene, and the projection
 * holds up.
 */
const ROUTE_REACH = 300;
const EARTH_RADIUS = 6371;

/** Wrapped, so an unknown route isn't mistaken for one never looked up. */
type CachedRoute = [Route | null];

interface RouteReply {
  callsign: string;
  plausible?: boolean | number;
  _airports?: {
    iata: string;
    icao: string;
    lat: number;
    lon: number;
    alt_meters?: number;
  }[];
}

type LatLon = [number, number];
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

function routeEnd(
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

/**
 * The leg being flown, of a route that may have several: the one the
 * aircraft is least out of its way on.
 */
function toRoute({ plausible, _airports: airports }: RouteReply, at: LatLon) {
  if (!plausible || !airports || airports.length < 2) return null;
  let best = 0;
  let detour = Infinity;
  for (let i = 0; i < airports.length - 1; i++) {
    const a: LatLon = [airports[i].lat, airports[i].lon];
    const b: LatLon = [airports[i + 1].lat, airports[i + 1].lon];
    const extra = arc(a, at) + arc(at, b) - arc(a, b);
    if (extra < detour) [best, detour] = [i, extra];
  }
  return { from: routeEnd(airports[best]), to: routeEnd(airports[best + 1]) };
}

/**
 * Routes by callsign, remembered or looked up. Missing ones couldn't be
 * found out.
 */
export async function findRoutes(sightings: Sighting[]) {
  const routes = new Map<string, Route | null>();
  const callsigns = [
    ...new Set(
      sightings.map((s) => s.aircraft.callsign).filter((c): c is string => !!c)
    ),
  ];
  if (!callsigns.length) return routes;

  const now = Date.now();
  for (const [callsign, { until }] of remembered) {
    if (until <= now) remembered.delete(callsign);
  }
  for (const callsign of callsigns) {
    const known = remembered.get(callsign);
    if (known) routes.set(callsign, known.route);
  }

  const unknown = callsigns.filter((callsign) => !routes.has(callsign));
  if (canStore && unknown.length) {
    const cached = await getRedis().mget<(CachedRoute | null)[]>(
      ...unknown.map(routeKey)
    );
    cached.forEach((c, i) => {
      if (!c) return;
      routes.set(unknown[i], c[0]);
      remember(unknown[i], c[0]);
    });
  }

  // Asked with where it is, so a route it isn't flying is ruled out. Only
  // stored, it was somewhere around Wellington.
  const wanted = new Map<string, LatLon>();
  for (const { aircraft, at } of sightings) {
    const { callsign } = aircraft;
    if (callsign && !routes.has(callsign) && (at || !wanted.has(callsign))) {
      wanted.set(callsign, at ?? WLG);
    }
  }
  if (!wanted.size) return routes;

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
  const replies: RouteReply[] = await response.json();

  const found = new Map<string, Route | null>();
  for (const reply of replies) {
    const at = wanted.get(reply.callsign);
    if (at) found.set(reply.callsign, toRoute(reply, at));
  }
  for (const [callsign, route] of found) {
    routes.set(callsign, route);
    remember(callsign, route);
  }
  if (canStore && found.size) {
    const pipeline = getRedis().pipeline();
    for (const [callsign, route] of found) {
      pipeline.set(routeKey(callsign), [route] satisfies CachedRoute, {
        ex: route ? ROUTE_TTL : UNKNOWN_TTL,
      });
    }
    await pipeline.exec();
  }
  return routes;
}

/**
 * Sightings gathered into aircraft, each with its fixes in time order. The
 * latest sighting's details win.
 */
export function toAircraft(
  sightings: Sighting[],
  routes = new Map<string, Route | null>()
): Aircraft[] {
  const byHex = new Map<string, Aircraft>();
  for (const { aircraft, fix } of sightings) {
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
  for (const aircraft of byHex.values()) {
    if (aircraft.callsign && routes.has(aircraft.callsign)) {
      aircraft.route = routes.get(aircraft.callsign);
    } else if (!aircraft.callsign) {
      aircraft.route = null;
    }
    aircraft.fixes.sort((a, b) => a[3] - b[3]);
    aircraft.fixes = aircraft.fixes.filter(
      (fix, i, fixes) => i === 0 || fix[3] !== fixes[i - 1][3]
    );
  }
  return [...byHex.values()];
}
