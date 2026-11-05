import { toNztm } from "./nztm";

// Rain as it's measured, from Greater Wellington Regional Council's rain
// gauges through their Hilltop server (https://hilltop.gw.govt.nz), no key
// needed: forty-odd on the map, telemetered every ten or fifteen minutes.
// Each is a tipping bucket, 0.2 or 0.5 mm a tip, logged as the tips come
// with a nil reading every ten minutes between, so a rate is what fell over
// the last half hour each gauge reported. Its times are NZST all year.

const SERVER = "https://hilltop.gw.govt.nz/data.hts";

const TIMEOUT = 15_000;

/** Gauges this far from the map's centre are kept, m: a little past its edge. */
const REACH = 40_000;

const CENTRE: [number, number] = [1748000, 5428000];

/** A rate is what fell in this long before a gauge's newest reading, ms. */
const RATE_OVER = 30 * 60_000;

/** A gauge not heard from in this long is left out, ms. */
const FRESH = 45 * 60_000;

export interface Gauge {
  /** NZTM easting and northing. */
  position: [number, number];
  /** mm/h, over the half hour to its newest reading. */
  rate: number;
}

export interface Rainfall {
  /** When it was asked, epoch ms. */
  time: number;
  /** Those on the map heard from lately; empty if none were. */
  gauges: Gauge[];
}

/** Hilltop's query string, spaces as %20: it reads a + as a plus. */
const url = (params: Record<string, string>) =>
  `${SERVER}?${new URLSearchParams(params).toString().replaceAll("+", "%20")}`;

async function hilltop(params: Record<string, string>) {
  const response = await fetch(url({ Service: "Hilltop", ...params }), {
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`hilltop: HTTP ${response.status}`);

  const body = await response.text();
  const error = /<Error>([^<]*)<\/Error>/.exec(body);

  if (error) throw new Error(`hilltop: ${error[1]}`);

  return body;
}

/** XML's escapes in an attribute, as written. */
const unescape = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/**
 * Where each rain gauge on the map is, by site name: those further off,
 * without a location, or a second logger at a site, aren't.
 */
export async function fetchGaugeSites(): Promise<
  Map<string, Gauge["position"]>
> {
  const body = await hilltop({
    Request: "SiteList",
    Measurement: "Rainfall",
    Location: "LatLong",
  });

  const sites = new Map<string, Gauge["position"]>();

  for (const [, name, inside] of body.matchAll(
    /<Site Name="([^"]*)">([\s\S]*?)<\/Site>/g
  )) {
    const lat = Number(/<Latitude>([^<]*)</.exec(inside)?.[1]);
    const lon = Number(/<Longitude>([^<]*)</.exec(inside)?.[1]);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || /backup/i.test(name))
      continue;

    const [easting, northing] = toNztm(lat, lon);

    if (Math.hypot(easting - CENTRE[0], northing - CENTRE[1]) <= REACH) {
      sites.set(unescape(name), [Math.round(easting), Math.round(northing)]);
    }
  }

  if (!sites.size) throw new Error("hilltop: no rain gauges on the map");

  return sites;
}

/** A Hilltop time, NZST without saying so, as epoch ms. */
const nzst = (time: string) => Date.parse(`${time}+12:00`);

/**
 * How hard it's raining at each of `sites` (fetchGaugeSites), at `now`
 * (epoch ms).
 */
export async function fetchRainfall(
  sites: Map<string, Gauge["position"]>,
  now = Date.now()
): Promise<Rainfall> {
  // Back far enough for a half hour's rate from the stalest gauge kept.
  const minutes = Math.ceil((FRESH + RATE_OVER) / 60_000);

  const body = await hilltop({
    Request: "GetData",
    Collection: "Rainfall",
    TimeInterval: `PT${minutes}M/now`,
  });

  const gauges: Gauge[] = [];

  for (const [, name, inside] of body.matchAll(
    /<Measurement SiteName="([^"]*)">([\s\S]*?)<\/Measurement>/g
  )) {
    const position = sites.get(unescape(name));

    // The backup logger's series at a site, if it has one, is called
    // "Rainfall Backup".
    if (!position || !/<DataSource Name="Rainfall"/.test(inside)) continue;

    const readings = [
      ...inside.matchAll(/<E><T>([^<]*)<\/T><I1>([^<]*)<\/I1><\/E>/g),
    ].flatMap(([, time, mm]) => {
      const at = nzst(time);
      const amount = Number(mm);

      return Number.isFinite(at) && Number.isFinite(amount)
        ? [{ at, amount }]
        : [];
    });

    const newest = Math.max(...readings.map(({ at }) => at));

    if (!(now - newest <= FRESH)) continue;

    // Each reading is what fell since the one before.
    const fell = readings
      .filter(({ at }) => at > newest - RATE_OVER)
      .reduce((sum, { amount }) => sum + Math.max(amount, 0), 0);

    gauges.push({
      position,
      rate: Math.round((fell / RATE_OVER) * 3_600_000 * 10) / 10,
    });
  }

  return { time: now, gauges };
}
