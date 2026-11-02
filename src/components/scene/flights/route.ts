import type { RouteEnd } from "../../../lib/flights";
import type { GroundAt, ToWorld } from "./path";

// Where an aircraft probably flew beyond what was seen of it: on to the end
// of its route, or back to its start. Only for drawing trails off the edge
// of the map, so it's a plausible line, not a flight plan.

/** Metres between points. */
const STEP = 2000;
/** Furthest drawn, metres; well past where the haze has swallowed it. */
const REACH = 150_000;
/** Shortest drawn, metres: closer than this, it's already there. */
const MIN_LENGTH = 1000;
/** Furthest the turn towards the airport is put off, metres. */
const MAX_LEAD = 20_000;
/** Height per distance coming down to an airport: a three degree glide. */
const DESCENT = Math.tan((3 * Math.PI) / 180);
/** Height per distance climbing to cruise. */
const CLIMB = 0.08;
/** Kept this far above the ground, metres, except close to the airport. */
const CLEARANCE = 150;
/** The clearance tapers away over this distance from the airport, metres. */
const CLEARANCE_TAPER = 5000;
/**
 * Coming down this close to the airport, metres, and pointed within
 * LINED_UP (radians) of it, it's on final: straight in to the runway, not
 * round to the airport's reference point, which is off to one side of it.
 */
const FINAL = 12_000;
const LINED_UP = (20 * Math.PI) / 180;
/**
 * Not yet on final to a known runway, it's brought round to join the
 * extended centreline this far out, metres, and comes straight down it.
 */
const FINAL_FIX = 6000;

/** Where a route meets a runway on the map. */
export interface Runway {
  /**
   * World x, z: the threshold, landing; going back in time from a
   * departure, the far end, where it lifted off.
   */
  at: [number, number];
  /** Radians clockwise from north, the way it's going along the runway. */
  course: number;
}

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

export interface Departure {
  /** World position. */
  x: number;
  y: number;
  z: number;
  /** Radians clockwise from north, the way it's going. */
  heading: number;
  /** Whether it's climbing the way it's going. */
  climbing: boolean;
}

/**
 * Points from `from` towards `to`, starting at `from`: carrying on along its
 * heading, then curving round to the airport, or, given its `runway`, to
 * join the final approach to it. It climbs, if it was, up to `cruise`, and
 * comes down to the airport at no less than three degrees. To go back in
 * time, turn the heading round and the climb over, and reverse.
 */
export function extend(
  from: Departure,
  to: RouteEnd,
  cruise: number,
  toWorld: ToWorld,
  groundAt: GroundAt,
  runway?: Runway
): [number, number, number][] {
  const [tx, tz] = runway?.at ?? toWorld(...to.at);
  const straight = Math.hypot(tx - from.x, tz - from.z);
  if (straight < MIN_LENGTH) return [];

  const bearing = Math.atan2(tx - from.x, from.z - tz);
  const off = wrap(bearing - from.heading);
  if (
    to.elevation !== null &&
    !from.climbing &&
    straight < FINAL &&
    Math.abs(off) < LINED_UP &&
    (!runway || Math.abs(wrap(runway.course - from.heading)) < LINED_UP)
  ) {
    if (runway) {
      // Down to the threshold.
      return [
        [from.x, from.y, from.z],
        [tx, to.elevation, tz],
      ];
    }
    // Down to the ground abeam the airport.
    const length = straight * Math.cos(off);
    return [
      [from.x, from.y, from.z],
      [
        from.x + Math.sin(from.heading) * length,
        to.elevation,
        from.z - Math.cos(from.heading) * length,
      ],
    ];
  }

  // A cubic Bézier, leaving along the heading: to the airport, or to the
  // final approach fix, arriving along the runway, then straight down final.
  const fx = runway ? tx - Math.sin(runway.course) * FINAL_FIX : tx;
  const fz = runway ? tz + Math.cos(runway.course) * FINAL_FIX : tz;
  const span = Math.hypot(fx - from.x, fz - from.z);
  const lead = Math.min(span * 0.4, MAX_LEAD);
  let [c1x, c1z, c2x, c2z] = [0, 0, 0, 0];
  if (runway) {
    c1x = from.x + Math.sin(from.heading) * lead;
    c1z = from.z - Math.cos(from.heading) * lead;
    c2x = fx - Math.sin(runway.course) * lead;
    c2z = fz + Math.cos(runway.course) * lead;
  } else {
    // The quadratic through one control point along the heading, as a cubic.
    const cx = from.x + Math.sin(from.heading) * lead;
    const cz = from.z - Math.cos(from.heading) * lead;
    c1x = from.x + ((cx - from.x) * 2) / 3;
    c1z = from.z + ((cz - from.z) * 2) / 3;
    c2x = fx + ((cx - fx) * 2) / 3;
    c2z = fz + ((cz - fz) * 2) / 3;
  }
  // The control polygon's length bounds the curve's, which can swing wide.
  const steps = Math.max(
    Math.ceil((runway ? span + 2 * lead : span) / STEP),
    1
  );
  const track: [number, number, number][] = [[from.x, 0, from.z]];
  let length = 0;
  const next = (x: number, z: number) => {
    const [px, , pz] = track[track.length - 1];
    length += Math.hypot(x - px, z - pz);
    track.push([x, length, z]);
  };
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const a = (1 - u) ** 3;
    const b = 3 * u * (1 - u) ** 2;
    const c = 3 * u * u * (1 - u);
    const d = u ** 3;
    next(
      a * from.x + b * c1x + c * c2x + d * fx,
      a * from.z + b * c1z + c * c2z + d * fz
    );
  }
  if (runway) {
    const finalSteps = Math.ceil(FINAL_FIX / STEP);
    for (let i = 1; i <= finalSteps; i++) {
      const u = i / finalSteps;
      next(fx + (tx - fx) * u, fz + (tz - fz) * u);
    }
  }

  const top = Math.max(cruise, from.y);
  const glide =
    to.elevation === null
      ? 0
      : Math.max(DESCENT, (from.y - to.elevation) / length);
  const points: [number, number, number][] = [];
  for (const [x, s, z] of track) {
    if (s > REACH) break;
    let y = from.climbing ? Math.min(top, from.y + CLIMB * s) : from.y;
    if (to.elevation !== null) {
      y = Math.min(y, to.elevation + glide * (length - s));
    }
    const taper = Math.min((length - s) / CLEARANCE_TAPER, 1);
    points.push([x, Math.max(y, groundAt(x, z) + CLEARANCE * taper), z]);
  }
  // Exactly where it was seen, whatever the clearance says.
  points[0][1] = from.y;
  return points;
}
