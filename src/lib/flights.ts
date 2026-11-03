// Live aircraft around Wellington: shared by /api/flights and the scene.

/**
 * One position report: NZTM2000 easting and northing (m), altitude above sea
 * level (m, null on the ground), when (epoch ms), ground speed (m/s), track
 * (degrees from true north, null if unknown) and climb (m/s, null if unknown).
 */
export type Fix = [
  easting: number,
  northing: number,
  altitude: number | null,
  time: number,
  speed: number,
  track: number | null,
  climb: number | null,
];

/** One end of a flight's route. */
export interface RouteEnd {
  /** IATA code, e.g. AKL. */
  code: string;
  /**
   * NZTM2000 easting and northing: the airport, or for one far off, a point
   * on the great circle towards it.
   */
  at: [number, number];
  /** The airport's elevation, metres; null when `at` is only on the way. */
  elevation: number | null;
}

/** Where a flight is from and going, as published for its callsign. */
export interface Route {
  from: RouteEnd;
  to: RouteEnd;
}

export interface Aircraft {
  /** ICAO 24-bit address, hex. */
  hex: string;
  callsign: string | null;
  registration: string | null;
  /** ICAO type designator, e.g. A320, DH8C. */
  type: string | null;
  /** ADS-B emitter category: A1 light … A5 heavy, A7 rotorcraft. */
  category: string | null;
  /** Null if it isn't known; missing if it couldn't be looked up. */
  route?: Route | null;
  /** Oldest first. */
  fixes: Fix[];
}

export interface FlightsResponse {
  /** Server clock, epoch ms, so clients can correct for their own. */
  time: number;
  aircraft: Aircraft[];
}

/**
 * How far back trails go, with `?history`: past a parked aircraft's 5-min
 * hold and the 30 s planes are drawn behind. Trails fade out within a
 * minute, so older fixes would go undrawn.
 */
export const HISTORY = 7 * 60_000;

/** How far back an ordinary poll goes: enough to bridge a missed one. */
export const RECENT = 2 * 60_000;
