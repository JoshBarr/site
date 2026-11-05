// Live buses around Wellington: shared by /api/buses and the scene.
import { current } from "./fold";

/** A bus's latest fix. Units: metres, degrees from true north. */
export interface Bus {
  /** Metlink's id for the bus reporting. */
  id: string;
  /** GTFS route_id of the trip it's on. */
  route: string;
  /** GTFS direction_id of the trip. */
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

export interface BusesResponse {
  /** Server clock, epoch ms, so clients can correct for their own. */
  time: number;
  buses: Bus[];
}

/**
 * How far back trails go: they've faded out two minutes behind a bus,
 * which is drawn a little behind live.
 */
export const TRAIL = 3 * 60_000;

/** A bus not heard from in this long has finished its trip, or gone dark. */
const STALE = 5 * 60_000;

/** The whole feed quiet this long, and what it last said goes too. */
const QUIET = 20 * 60_000;

/** Those of `buss` recent enough to show at `now` (see `current`). */
export const fresh = <T extends Pick<Bus, "time">>(
  buss: T[],
  now = Date.now()
) => current(buss, now, STALE, QUIET);
