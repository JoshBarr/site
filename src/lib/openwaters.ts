import { z } from "zod";
import { toNztm } from "./nztm";
import { readJson } from "./schemas";
import type { Vessel } from "./vessels";

// Ships around Wellington Harbour from Open Waters AIS
// (https://openwaters.io/ais/), an open network of shore receivers, with
// AISHub's. It keeps each ship's last known state and the positions heard
// from it, so one request says where everything is and another where a ship
// has been. Free for personal use; reads need no token, but one gets its own
// rate limit rather than sharing the server's address's.

const API = "https://ais.openwaters.io/v1";

/** Te Whanganui-a-Tara and its entrance: min lat, min lon, max lat, max lon. */
const HARBOUR = "-41.4,174.74,-41.19,174.96";

const TIMEOUT = 5_000;
const KNOTS = 1852 / 3600;

/** One position from a track: as a `Vessel`'s, with its time. */
export type TrackPoint = Pick<
  Vessel,
  "position" | "speed" | "course" | "heading" | "time"
>;

/** [lon, lat]. */
const lonLat = z.tuple([z.number(), z.number()]);

const harbour = z.object({
  features: z.array(
    z.object({
      geometry: z.object({ coordinates: lonLat }),
      properties: z.object({
        mmsi: z.number(),
        name: z.string().optional(),
        type: z.number().optional(),
        /** Knots. */
        sog: z.number().optional(),
        cog: z.number().optional(),
        heading: z.number().optional(),
        to_bow: z.number().optional(),
        to_stern: z.number().optional(),
        to_port: z.number().optional(),
        to_starboard: z.number().optional(),
        /** When the last message about it, of any kind, was heard. */
        seen: z.string(),
      }),
    })
  ),
});

type Properties = z.infer<typeof harbour>["features"][number]["properties"];

const track = z.object({
  /** The positions, oldest first: a LineString's, a Point's one, or none. */
  geometry: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("LineString"), coordinates: z.array(lonLat) }),
      z.object({
        type: z.literal("Point"),
        coordinates: lonLat.transform((at) => [at]),
      }),
    ])
    .nullable(),
  /** One of each for every position. */
  properties: z.object({
    times: z.array(z.string()),
    sog: z.array(z.number().nullable()),
    cog: z.array(z.number().nullable()),
    heading: z.array(z.number().nullable()),
  }),
});

async function get<T>(
  path: string,
  params: Record<string, string>,
  schema: z.ZodType<T>
) {
  const token = process.env.OPENWATERS_TOKEN;

  const response = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
    headers: {
      "User-Agent": "joshbarr.com scene",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) {
    throw new Error(`openwaters ${path}: HTTP ${response.status}`);
  }

  return readJson(response, schema, `openwaters ${path}`);
}

/** NZTM2000, to the decimetre: finer than AIS places a ship. */
function nztm([lon, lat]: [number, number]): [number, number] {
  const [easting, northing] = toNztm(lat, lon);

  return [Math.round(easting * 10) / 10, Math.round(northing * 10) / 10];
}

function dimension(p: Properties): Vessel["dimension"] {
  const { to_bow: a, to_stern: b, to_port: c, to_starboard: d } = p;

  if (a === undefined || b === undefined) return null;

  if (c === undefined || d === undefined) return null;

  return a + b > 0 && c + d > 0 ? [a, b, c, d] : null;
}

/**
 * Every ship in the harbour heard in the last `maxAge` ms, or in the last
 * `maxAgeMoving` if it was under way, without trails. A moving ship's `time`
 * is when it was last heard at all, which may be after its position.
 */
export async function fetchHarbour(maxAge: number, maxAgeMoving: number) {
  const { features } = await get(
    "/vessels",
    {
      bbox: HARBOUR,
      kind: "vessel",
      max_age: String(Math.round(maxAge / 1000)),
      max_age_moving: String(Math.round(maxAgeMoving / 1000)),
    },
    harbour
  );

  return features.map(({ geometry, properties: p }): Vessel => ({
    mmsi: p.mmsi,
    name: p.name?.trim() || null,
    type: p.type ?? 0,
    position: nztm(geometry.coordinates),
    speed: (p.sog ?? 0) * KNOTS,
    course: p.cog ?? null,
    heading: p.heading ?? null,
    dimension: dimension(p),
    time: Date.parse(p.seen),
    trail: [],
  }));
}

/** Every position heard from a ship since `since` (epoch ms), oldest first. */
export async function fetchTrack(
  mmsi: number,
  since: number
): Promise<TrackPoint[]> {
  const { geometry, properties: p } = await get(
    `/vessels/${mmsi}/track`,
    { from: new Date(since).toISOString(), interval: "0" },
    track
  );

  if (!geometry) return [];

  return geometry.coordinates.map((at, i) => ({
    position: nztm(at),
    time: Date.parse(p.times[i]),
    speed: (p.sog[i] ?? 0) * KNOTS,
    course: p.cog[i],
    heading: p.heading[i],
  }));
}
