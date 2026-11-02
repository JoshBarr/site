// Live ships in Wellington Harbour: shared by /api/vessels and the scene.

/** A vessel's latest report. Units: metres, m/s, degrees from true north. */
export interface Vessel {
  mmsi: number;
  name: string | null;
  /** AIS ship type: 60–69 passenger, 70–79 cargo, 52 tug…; 0 if unknown. */
  type: number;
  /** NZTM2000 easting and northing of the AIS antenna. */
  position: [number, number];
  /** Over the ground. */
  speed: number;
  /** Course over the ground, or null when not reported. */
  course: number | null;
  /** Which way the bow points, or null when not reported. */
  heading: number | null;
  /** Antenna to bow, stern, port and starboard; null until reported. */
  dimension: [number, number, number, number] | null;
  /** When the position was received, epoch ms. */
  time: number;
  /**
   * Where it's been under way lately, oldest first: easting, northing and
   * time, as `position` and `time`.
   */
  trail: [number, number, number][];
}

export interface VesselsResponse {
  /** Server clock, epoch ms, so clients can correct for their own. */
  time: number;
  vessels: Vessel[];
}

/** Faster than this (m/s) is under way rather than drifting at a mooring. */
export const UNDER_WAY = 0.5;

/** A ship under way that's gone quiet could be anywhere by now. */
export const STALE_UNDER_WAY = 10 * 60_000;

/**
 * One at a mooring or anchor is likely still there. Plenty go quiet at their
 * berth, or are only heard now and then, so this spans a quiet night.
 */
export const STALE_STATIONARY = 12 * 3600_000;

/** How far back trails go: by then they've faded out. */
export const TRAIL = 15 * 60_000;

/**
 * Reports further apart than this aren't joined in a trail: the ship could
 * have gone any way between them.
 */
export const TRAIL_GAP = 4 * 60_000;

/** Whether a report is too old to show. */
export function isStale({ speed, time }: Pick<Vessel, "speed" | "time">) {
  const age = Date.now() - time;

  return age > (speed > UNDER_WAY ? STALE_UNDER_WAY : STALE_STATIONARY);
}
