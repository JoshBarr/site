// public/roads/signs.json, as scripts/traffic/build_signs.mjs writes it: the
// signs along State Highways 1 and 2 there's evidence for (what for each is
// in scripts/traffic/signs.evidence.json), placed on roads.json's
// carriageways.

const ROADS_URL = process.env.NEXT_PUBLIC_ROADS_URL ?? "/roads";

/** A message sign: NZTA's ids for it, the lately changed first. */
interface MessageFace {
  kind: "vms";
  ids: number[];
  /** Large on the motorways and open road, small in town. */
  size: "large" | "small";
}

/** A direction sign's panel, worded as OSM's `destination` tags have it. */
export interface DirectionFace {
  kind: "direction";
  /** Destinations, a line each. */
  lines: string[];
  /** Which way: `down` is over the lanes it's for. */
  arrow: "left" | "right" | "ahead" | "down";
  /** The street it's by, where the sign names one. */
  street?: string;
  /** State highways shown as shields: "SH1". */
  refs?: string[];
  /** A pictogram OSM records (airport, ferry…): not drawn. */
  symbol?: string;
  /** How many lanes it's over, on a gantry. */
  lanes?: number;
}

/** A speed limit, km/h. */
export interface SpeedFace {
  kind: "speed";
  limit: number;
}

export type Face = MessageFace | DirectionFace | SpeedFace;

interface Panel {
  /** The carriageway whose traffic it faces, and how far along it, m. */
  on: string;
  s: number;
  /** Where along the structure's beam its middle is: 0 at `a`, 1 at `b`. */
  t: number;
  face: Face;
}

export interface Structure {
  id: string;
  /**
   * A post (or pair) on the verge with its sign on it; an arm out over the
   * road from a mast at `a`; or a gantry with a leg at each end.
   */
  kind: "post" | "cantilever" | "gantry";
  /** The carriageway it stands by, and how far along it, m. */
  on: string;
  s: number;
  /** Its ends, NZTM easting and northing: the same point for a post. */
  a: [number, number];
  b: [number, number];
  panels: Panel[];
}

export interface SignsFile {
  structures: Structure[];
}

export async function loadSigns(): Promise<SignsFile> {
  const response = await fetch(`${ROADS_URL}/signs.json`);

  if (!response.ok) throw new Error(`signs: ${response.status}`);

  return response.json();
}
