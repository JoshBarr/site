import type { TrafficSpeeds } from "./traffic";

// Traffic speeds from NZTA's traffic and travel API
// (https://www.nzta.govt.nz/traffic-and-travel-information/use-our-data/),
// CC BY 4.0, no key needed. Each state highway journey is split into legs
// and legs into links, each with a live speed, refreshed every minute or
// two. Its HTTPS port refuses connections, so this goes over HTTP; it's
// public data. It takes 15 seconds or so to answer, so trafficStore fetches
// it behind the request, not in it.

const API =
  "http://trafficnz.info/service/traffic/rest/4/journeys/byregion/9/1";
const TIMEOUT = 45_000;
/** The highways the scene draws. */
const ROADS = new Set(["SH1", "SH2"]);

interface Link {
  linkName: string;
  /** km; as a number, or sometimes a string. */
  linkLength: number | string;
  /** km/h. */
  linkSpeed: number;
}

interface Leg {
  direction: "I" | "D";
  sequenceNumber: number;
  /** km/h, or -1 without a reading. */
  speed: number;
  coverage: number;
  /** One link comes as an object, not a list. */
  lengths?: Link | Link[];
}

interface Journey {
  name: string;
  legs?: Leg | Leg[];
}

/** As scripts/traffic/build_roads.mjs keys them. */
const linkKey = (link: Link) => `${link.linkName}|${Number(link.linkLength)}`;

/** Every SH1 and SH2 leg and link in the Wellington region with a reading. */
export async function fetchTraffic(): Promise<TrafficSpeeds> {
  const response = await fetch(API, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!response.ok) throw new Error(`nzta: ${response.status}`);
  const body: { response: { journey: Journey | Journey[] } } =
    await response.json();

  const speeds: TrafficSpeeds = { links: {}, legs: {} };
  for (const journey of ([] as Journey[]).concat(body.response.journey)) {
    if (!ROADS.has(journey.name)) continue;
    for (const leg of ([] as Leg[]).concat(journey.legs ?? [])) {
      if (leg.coverage > 0 && leg.speed > 0) {
        const key = `${journey.name} ${leg.direction} ${leg.sequenceNumber}`;
        speeds.legs[key] = Math.round(leg.speed);
      }
      for (const link of ([] as Link[]).concat(leg.lengths ?? [])) {
        if (link.linkSpeed > 0) speeds.links[linkKey(link)] = link.linkSpeed;
      }
    }
  }
  if (!Object.keys(speeds.links).length) throw new Error("nzta: no links");
  return speeds;
}
