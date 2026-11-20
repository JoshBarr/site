import { z } from "zod";
import { readJson } from "./schemas";
import type { SignMessages } from "./signs";
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

/** Where there's only one, it comes as an object, not a list. */
const oneOrMany = <T extends z.ZodType>(item: T) =>
  z.union([z.array(item), item.transform((one) => [one])]);

const link = z.object({
  linkName: z.string(),
  /** km; as a number, or sometimes a string. */
  linkLength: z.union([z.number(), z.string()]).transform(Number),
  /** km/h. */
  linkSpeed: z.number(),
});

const journeys = z.object({
  response: z.object({
    journey: oneOrMany(
      z.object({
        name: z.string(),
        legs: oneOrMany(
          z.object({
            /** I or D. */
            direction: z.string(),
            sequenceNumber: z.number(),
            /** km/h, or -1 without a reading. */
            speed: z.number(),
            coverage: z.number(),
            lengths: oneOrMany(link).optional(),
          })
        ).optional(),
      })
    ),
  }),
});

/** As scripts/traffic/build_roads.mjs keys them. */
const linkKey = (l: z.infer<typeof link>) => `${l.linkName}|${l.linkLength}`;

/** Every SH1 and SH2 leg and link in the Wellington region with a reading. */
export async function fetchTraffic(): Promise<TrafficSpeeds> {
  const response = await fetch(API, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`nzta: ${response.status}`);

  const body = await readJson(response, journeys, "nzta");

  const speeds: TrafficSpeeds = { links: {}, legs: {} };

  for (const journey of body.response.journey) {
    if (!ROADS.has(journey.name)) continue;

    for (const leg of journey.legs ?? []) {
      if (leg.coverage > 0 && leg.speed > 0) {
        const key = `${journey.name} ${leg.direction} ${leg.sequenceNumber}`;
        speeds.legs[key] = Math.round(leg.speed);
      }

      for (const l of leg.lengths ?? []) {
        if (l.linkSpeed > 0) speeds.links[linkKey(l)] = l.linkSpeed;
      }
    }
  }

  if (!Object.keys(speeds.links).length) throw new Error("nzta: no links");

  return speeds;
}

// What the variable message signs are showing, from the same API: every
// sign in a box round the highways the scene draws (about a hundred, 65 KB,
// two seconds), each with its message in NTCIP markup (../lib/signs.ts).
// Travel times are on them too, as messages. Neither this nor any other
// endpoint has the smart motorway's lane signals or variable speed limits.

/**
 * West, south, east, north: as scripts/traffic/build_signs.mjs has it, so
 * every sign public/roads/signs.json binds is asked after.
 */
const SIGNS_BOUNDS = [174.72, -41.36, 175.2, -40.94];

const SIGNS_API = `http://trafficnz.info/service/traffic/rest/4/signs/vms/withinbounds/${SIGNS_BOUNDS.join("/")}`;

const messageSigns = z.object({
  // With no signs in the bounds it's "".
  response: z.union([
    z.literal(""),
    z.object({
      vms: oneOrMany(
        z.object({
          id: z.number(),
          /** "" when the sign's blank. */
          currentMessage: z.string().nullish(),
        })
      ).optional(),
    }),
  ]),
});

/** What every message sign round State Highways 1 and 2 is showing. */
export async function fetchSigns(): Promise<SignMessages> {
  const response = await fetch(SIGNS_API, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`nzta signs: ${response.status}`);

  const body = await readJson(response, messageSigns, "nzta signs");
  const signs = (body.response || {}).vms ?? [];

  if (!signs.length) throw new Error("nzta signs: none");

  return {
    messages: Object.fromEntries(
      signs.map(({ id, currentMessage }) => [id, currentMessage ?? ""])
    ),
  };
}
