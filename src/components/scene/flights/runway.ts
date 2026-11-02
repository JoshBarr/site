import type { Fix } from "../../../lib/flights";
import { RUNWAY } from "../airport/airfield";
import type { ToWorld } from "./path";
import type { Runway } from "./route";

// Wellington's runway as traffic uses it: landing and taking off north on
// 34 or south on 16, into the wind. Routes to or from here are drawn down
// the runway's final approach, not to the airport's reference point, which
// is off to one side of it.

/** The airport whose runway is on the map, as routes name it. */
export const HOME = "WLG";

export type Direction = "34" | "16";

/** Radians clockwise from north, along runway 34. */
const COURSE_34 = Math.atan2(RUNWAY.axis[0], RUNWAY.axis[1]);

/**
 * Airborne traffic within this far of the runway's middle, metres, along
 * and across it, this low, and tracking within ALIGNED of it, shows which
 * way it's in use.
 */
const NEAR = 12_000;
const ACROSS = 600;
const LOW = 800;
const ALIGNED = (20 * Math.PI) / 180;

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * Which way the runway's in use: as the latest traffic lined up on it used
 * it, or, with none seen, into `windFrom` (degrees true).
 */
export function runwayInUse(fixes: Fix[][], windFrom: number): Direction {
  const middle = RUNWAY.length / 2;
  const me = RUNWAY.south[0] + RUNWAY.axis[0] * middle;
  const mn = RUNWAY.south[1] + RUNWAY.axis[1] * middle;
  let latest = -Infinity;
  let seen: Direction | null = null;

  for (const [easting, northing, altitude, time, , track] of fixes.flat()) {
    if (altitude === null || altitude > LOW || track === null) continue;

    if (time <= latest) continue;
    const de = easting - me;
    const dn = northing - mn;
    const along = de * RUNWAY.axis[0] + dn * RUNWAY.axis[1];
    const across = dn * RUNWAY.axis[0] - de * RUNWAY.axis[1];

    if (Math.abs(along) > NEAR || Math.abs(across) > ACROSS) continue;
    const off = Math.abs(wrap((track * Math.PI) / 180 - COURSE_34));

    if (off < ALIGNED) seen = "34";
    else if (off > Math.PI - ALIGNED) seen = "16";
    else continue;
    latest = time;
  }

  if (seen) return seen;

  return Math.cos((windFrom * Math.PI) / 180 - COURSE_34) >= 0 ? "34" : "16";
}

/** Where traffic landing `direction` touches down: its threshold. */
export function landing(direction: Direction, toWorld: ToWorld): Runway {
  const along = direction === "34" ? RUNWAY.threshold34 : RUNWAY.threshold16;

  return {
    at: toWorld(
      RUNWAY.south[0] + RUNWAY.axis[0] * along,
      RUNWAY.south[1] + RUNWAY.axis[1] * along
    ),
    course: direction === "34" ? COURSE_34 : COURSE_34 + Math.PI,
  };
}

/**
 * A departure `direction`, run backwards: it lands the other way, at the end
 * it lifted off from.
 */
export function takingOff(direction: Direction, toWorld: ToWorld): Runway {
  return landing(direction === "34" ? "16" : "34", toWorld);
}
