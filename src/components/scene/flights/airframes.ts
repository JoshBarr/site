import type { Aircraft } from "../../../lib/flights";

// What to draw for an aircraft: a shape and how long it is, from its ICAO
// type where we know it, else its ADS-B category.

export type Shape = "jet" | "prop" | "light" | "helicopter";

export interface Airframe {
  shape: Shape;
  /** Metres, nose to tail. */
  length: number;
}

/** Types seen around Wellington, and a few that visit. Length in metres. */
const TYPES = new Map(
  Object.entries({
    A319: ["jet", 33.8],
    A320: ["jet", 37.6],
    A20N: ["jet", 37.6],
    A321: ["jet", 44.5],
    A21N: ["jet", 44.5],
    B737: ["jet", 33.6],
    B738: ["jet", 39.5],
    B38M: ["jet", 39.5],
    B39M: ["jet", 42.2],
    E190: ["jet", 36.2],
    B788: ["jet", 56.7],
    B789: ["jet", 62.8],
    B77W: ["jet", 73.9],
    B772: ["jet", 63.7],
    A359: ["jet", 66.8],
    A333: ["jet", 63.7],
    C25A: ["jet", 16.3],
    C56X: ["jet", 16],
    GLF6: ["jet", 30.4],
    DH8C: ["prop", 25.7],
    DH8D: ["prop", 32.8],
    AT72: ["prop", 27.2],
    AT75: ["prop", 27.2],
    AT76: ["prop", 27.2],
    SF34: ["prop", 19.7],
    B190: ["prop", 17.6],
    JS32: ["prop", 14.4],
    BE20: ["prop", 13.4],
    B350: ["prop", 14.2],
    PC12: ["prop", 14.4],
    C208: ["light", 11.5],
    P68: ["prop", 9.4],
    BN2P: ["prop", 10.9],
    C150: ["light", 7.3],
    C152: ["light", 7.3],
    C172: ["light", 8.3],
    C182: ["light", 8.8],
    C185: ["light", 7.9],
    C206: ["light", 8.6],
    C210: ["light", 8.6],
    PA18: ["light", 6.9],
    PA28: ["light", 7.3],
    PA32: ["light", 8.4],
    BE36: ["light", 8.4],
    PA31: ["prop", 9.9],
    SR22: ["light", 7.9],
    DA40: ["light", 8],
    // Topdressers.
    CRES: ["light", 11.1],
    P750: ["light", 11.8],
    DA42: ["prop", 8.6],
    EC35: ["helicopter", 10.2],
    EC30: ["helicopter", 10.7],
    EC45: ["helicopter", 13],
    BK17: ["helicopter", 13],
    AS50: ["helicopter", 10.9],
    AS55: ["helicopter", 12.9],
    A109: ["helicopter", 13],
    AW09: ["helicopter", 12.7],
    B06: ["helicopter", 11.8],
    B407: ["helicopter", 12.7],
    B429: ["helicopter", 12.7],
    R22: ["helicopter", 8.8],
    R44: ["helicopter", 11.7],
    R66: ["helicopter", 11.6],
    S76: ["helicopter", 16],
    NH90: ["helicopter", 19.6],
  } satisfies Record<string, [Shape, number]>)
);

/** By ADS-B emitter category when the type isn't known. */
const CATEGORIES = new Map(
  Object.entries({
    A1: ["light", 9],
    A2: ["prop", 26],
    A3: ["jet", 38],
    A4: ["jet", 47],
    A5: ["jet", 65],
    A6: ["jet", 20],
    A7: ["helicopter", 12],
  } satisfies Record<string, [Shape, number]>)
);

export function airframeFor({ type, category }: Aircraft): Airframe {
  const fallback: [Shape, number] = ["light", 9];

  const [shape, length] =
    TYPES.get(type ?? "") ?? CATEGORIES.get(category ?? "") ?? fallback;

  return { shape, length };
}
