import { http, HttpResponse } from "msw/http";
import { NOW } from "../clock";
import { server } from "../msw";

// Aircraft from adsb.lol (readsb's JSON), and their routes from adsb.im.

const AIRSPACE = "https://api.adsb.lol/v2/point/-41.327/174.805/25";
const ROUTESET = "https://adsb.im/api/0/routeset";

/** What adsb.lol says is around Wellington at NOW. */
export const airspace = <Report>(ac: Report[], now = NOW) => ({
  ac,
  msg: "No error",
  now,
  total: ac.length,
  ctime: now,
  ptime: 0,
});

/** Air New Zealand from Auckland, descending into Wellington. */
export const ANZ441 = {
  hex: "c81e2c",
  type: "adsb_icao",
  flight: "ANZ441  ",
  r: "ZK-NHA",
  t: "A21N",
  category: "A3",
  lat: -41.25,
  lon: 174.85,
  seen_pos: 1.2,
  alt_baro: 3000,
  alt_geom: 3100,
  gs: 180,
  track: 200,
  geom_rate: -704,
  mlat: [],
  seen: 1.2,
};

/** Qantas from Sydney, with only pressure altitude. */
export const QFA163 = {
  hex: "7c6b2d",
  type: "adsb_icao",
  flight: "QFA163  ",
  r: "VH-VXA",
  t: "B738",
  category: "A3",
  lat: -41.4,
  lon: 174.6,
  seen_pos: 0.5,
  alt_baro: 10000,
  gs: 300,
  true_heading: 250,
  baro_rate: 0,
};

/** A light aircraft taxiing, without a callsign. */
export const TAXIING = {
  hex: "c8233e",
  flight: "        ",
  r: "ZK-MCJ",
  t: "AT76",
  category: "A2",
  lat: -41.33,
  lon: 174.81,
  seen_pos: 3,
  alt_baro: "ground",
  gs: 5,
  track: 90,
};

/** What adsb.lol also reports, that isn't drawn. */
export const NOT_DRAWN = [
  // An airport vehicle.
  {
    hex: "c87ec2",
    flight: "APT1    ",
    alt_baro: "ground",
    category: "C2",
    lat: -41.328402,
    lon: 174.810614,
    seen_pos: 9.253,
  },
  // Its position is too old.
  { ...ANZ441, hex: "c80001", flight: "NZM123  ", seen_pos: 90 },
  // No position.
  { hex: "c80002", flight: "JST221  ", alt_baro: 20000, seen_pos: 2 },
  // No altitude.
  { hex: "c80003", flight: "SDA1    ", lat: -41.3, lon: 174.9, seen_pos: 2 },
];

const AIRPORTS = {
  AKL: { iata: "AKL", icao: "NZAA", lat: -37.008099, lon: 174.792007 },
  WLG: { iata: "WLG", icao: "NZWN", lat: -41.327202, lon: 174.804993 },
  SYD: { iata: "SYD", icao: "YSSY", lat: -33.946098, lon: 151.177002 },
  NSN: { iata: "NSN", icao: "NZNS", lat: -41.298302, lon: 173.220993 },
};

const ELEVATION = { AKL: 7.01, WLG: 12.5, SYD: 6.4, NSN: 10.36 };

type Airport = keyof typeof AIRPORTS;

/** adsb.im's answer for a callsign: its route, or that it isn't known. */
export function routeReply(callsign: string, airports?: Airport[]) {
  if (!airports) {
    return {
      _airport_codes_iata: "unknown",
      _airports: [],
      airline_code: "unknown",
      airport_codes: "unknown",
      callsign,
      number: "unknown",
    };
  }

  return {
    _airport_codes_iata: airports.join("-"),
    _airports: airports.map((code) => ({
      ...AIRPORTS[code],
      alt_meters: ELEVATION[code],
      alt_feet: ELEVATION[code] / 0.3048,
      countryiso2: "NZ",
      location: code,
      name: code,
    })),
    airline_code: callsign.slice(0, 3),
    airport_codes: airports.map((code) => AIRPORTS[code].icao).join("-"),
    callsign,
    number: callsign.slice(3),
    plausible: true,
  };
}

/**
 * Answers adsb.lol and adsb.im. The requests made of each are in what's
 * returned.
 */
export function adsb(
  reports: () => Response,
  routes: () => Response = () => HttpResponse.json([])
) {
  const airspaceRequests: Request[] = [];
  const routeRequests: Request[] = [];

  server.use(
    http.get(AIRSPACE, ({ request }) => {
      airspaceRequests.push(request);

      return reports();
    }),
    http.post(ROUTESET, ({ request }) => {
      routeRequests.push(request.clone());

      return routes();
    })
  );

  return { airspace: airspaceRequests, routes: routeRequests };
}
