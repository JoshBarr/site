import { z } from "zod";
import { readJson } from "./schemas";

// Orbits of the satellites bright enough to see pass over, from CelesTrak
// (https://celestrak.org/NORAD/elements/): its "visual" group, the 150 or
// so brightest, the ISS, Tiangong and Hubble among them. Each is a set of
// mean elements at an epoch, which SGP4 runs on from there; the scene does
// that in the browser. CelesTrak refreshes them every few hours and asks
// that they're fetched no more often, so they're fetched once a day and
// kept in the live table.

const API =
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=json";

const TIMEOUT = 20_000;

/**
 * One satellite's mean elements, as CelesTrak's OMM JSON words them (what
 * satellite.js's json2satrec takes), less what SGP4 doesn't need.
 */
export const orbit = z.object({
  OBJECT_NAME: z.string(),
  /** International designator, e.g. 1998-067A. */
  OBJECT_ID: z.string(),
  /** UTC, ISO 8601 without a zone. */
  EPOCH: z.string(),
  /** Revolutions a day. */
  MEAN_MOTION: z.number(),
  ECCENTRICITY: z.number(),
  /** Degrees, as the next three. */
  INCLINATION: z.number(),
  RA_OF_ASC_NODE: z.number(),
  ARG_OF_PERICENTER: z.number(),
  MEAN_ANOMALY: z.number(),
  NORAD_CAT_ID: z.number(),
  ELEMENT_SET_NO: z.number(),
  BSTAR: z.number(),
  MEAN_MOTION_DOT: z.number(),
  MEAN_MOTION_DDOT: z.number(),
});

export type Orbit = z.infer<typeof orbit>;

/** The visual group's elements, as CelesTrak has them now. */
export async function fetchOrbits(): Promise<Orbit[]> {
  const response = await fetch(API, { signal: AbortSignal.timeout(TIMEOUT) });

  if (!response.ok) throw new Error(`celestrak: HTTP ${response.status}`);

  // Parsed as orbit, which drops the fields it doesn't name.
  return readJson(response, z.array(orbit).min(1), "celestrak");
}
