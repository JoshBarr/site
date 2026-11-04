import { z } from "zod";
import { toNztm } from "./nztm";
import { readJson } from "./schemas";

// Earthquakes from GeoNet (https://www.geonet.org.nz/data/access/quake),
// CC BY 4.0, no key needed. /quake?MMI=-1 is the newest hundred anywhere in
// New Zealand, about a day and a half of them, revised as they're reviewed:
// polled once a minute, none are missed. Kept are those on the map, and
// those further off felt in Wellington.

const API = "https://api.geonet.org.nz/quake?MMI=-1";

const TIMEOUT = 15_000;

export interface Quake {
  /** GeoNet's public ID, e.g. 2026p829637. */
  id: string;
  /** When it struck, epoch ms. */
  time: number;
  /** Epicentre, NZTM easting and northing. */
  position: [number, number];
  /** Of the hypocentre, km. */
  depth: number;
  magnitude: number;
  /** Where, as GeoNet puts it: "20 km east of Paraparaumu". */
  locality: string;
  /** automatic, preliminary or best: how far it's been reviewed. */
  quality: string;
}

/** The middle of the scene's map, NZTM (public/terrain/manifest.json). */
const WELLINGTON: [number, number] = [1748000, 5428000];

/** Quakes this close to Wellington are on the map, or nearly, metres. */
const NEARBY = 50_000;

/** Further off, a quake must shake Wellington this hard to be kept, MMI. */
const FELT = 2;

/** Closer than this, km, intensity stops growing: the fault is that big. */
const NEAR_FIELD = 5;

/**
 * Modified Mercalli intensity `distance` km from the hypocentre of a quake
 * of `magnitude`. A rough fit, not a published model: M6 at 20 km is about
 * MMI 7, M3 at 20 km about 2.5, and Kaikōura (M7.8) at Wellington, ~200 km
 * off, about 6.7, as measured.
 */
export const intensity = (magnitude: number, distance: number) =>
  1.5 * magnitude - 3 * Math.log10(Math.max(distance, NEAR_FIELD)) + 1.9;

/** How hard `quake` shook at NZTM `at`, MMI. */
function intensityAt(quake: Quake, at: [number, number]) {
  const across = Math.hypot(
    quake.position[0] - at[0],
    quake.position[1] - at[1]
  );

  return intensity(quake.magnitude, Math.hypot(across / 1000, quake.depth));
}

const feature = z.object({
  /** Longitude, latitude. */
  geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z.object({
    publicID: z.string(),
    time: z.iso.datetime(),
    depth: z.number(),
    magnitude: z.number(),
    locality: z.string(),
    quality: z.string(),
  }),
});

const quakes = z.object({ features: z.array(feature) });

const round = (value: number, places: number) =>
  Math.round(value * 10 ** places) / 10 ** places;

/** Those GeoNet's heard of lately on the map or felt here, oldest first. */
export async function fetchQuakes(): Promise<Quake[]> {
  const response = await fetch(API, {
    headers: { Accept: "application/vnd.geo+json;version=2" },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`geonet: HTTP ${response.status}`);

  const { features } = await readJson(response, quakes, "geonet");

  return (
    features
      // Not a quake after all.
      .filter(({ properties: { quality } }) => quality !== "deleted")
      .map(
        ({
          geometry: {
            coordinates: [lon, lat],
          },
          properties: p,
        }) => {
          const [easting, northing] = toNztm(lat, lon);

          // To the metre, a tenth of a km and a hundredth of a magnitude:
          // finer is only noise, and a write each time it changes.
          return {
            id: p.publicID,
            time: Date.parse(p.time),
            position: [Math.round(easting), Math.round(northing)],
            depth: round(p.depth, 1),
            magnitude: round(p.magnitude, 2),
            locality: p.locality,
            quality: p.quality,
          } satisfies Quake;
        }
      )
      .filter(
        (quake) =>
          Math.hypot(
            quake.position[0] - WELLINGTON[0],
            quake.position[1] - WELLINGTON[1]
          ) < NEARBY || intensityAt(quake, WELLINGTON) >= FELT
      )
      .sort((a, b) => a.time - b.time)
  );
}
