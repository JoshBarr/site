// Live trains around Wellington: shared by /api/trains and the scene.

/** Metlink's rail lines, by their short names. */
export type Line = "KPL" | "HVL" | "MEL" | "WRL" | "JVL";

/** A train's latest fix. Units: metres, degrees from true north. */
export interface Train {
  /** Metlink's id for the unit reporting. */
  id: string;
  line: Line;
  /** GTFS direction: 0 out of Wellington, 1 in. */
  direction: number;
  /** NZTM2000 easting and northing. */
  position: [number, number];
  /** Which way it was going, or null when not reported. */
  bearing: number | null;
  /** When the fix was taken, epoch ms. */
  time: number;
  /**
   * Where it's been lately, oldest first, ending at `position`: easting,
   * northing and time, as `position` and `time`.
   */
  trail: [number, number, number][];
}

export interface TrainsResponse {
  /** Server clock, epoch ms, so clients can correct for their own. */
  time: number;
  trains: Train[];
}

/**
 * How far back trails go: they've faded out two minutes behind a train,
 * which is drawn a little behind live.
 */
export const TRAIL = 3 * 60_000;

/** A train not heard from in this long has gone out of service, or dark. */
const STALE = 5 * 60_000;

/**
 * The terrain root the scene covers, NZTM [west, south, east, north]:
 * trains beyond it aren't sent.
 */
export const MAP_BOUNDS = [1715232, 5395232, 1780768, 5460768];

/** Whether a fix is too old to show. */
export function isStale({ time }: Pick<Train, "time">) {
  return Date.now() - time > STALE;
}
