import type { TrafficSpeeds } from "../../../../lib/traffic";
import type { Carriageway } from "../roads";
import type { LaneZone } from "./file";

// What a lane sign's likely showing. NZTA doesn't publish what its lane
// control signs show, so this is an estimate: the speed register says the
// limit's variable where they hang (scripts/traffic/build_signs.mjs), NZTA's
// live speeds say how fast traffic's going under them, and the hour says
// how busy it usually is. How each stretch runs is as Wellington's drivers
// know it: the gorge is 80 unless there's a crash; the Terrace Tunnel 70
// unless it's very busy; the motorway between drops to 60 in the morning
// and evening rush, back to 80 as it eases, and 100 once it's clear. The
// thresholds are guesses.

/** Speeds this near a sign either way are its, m: a link or two. */
const NEAR = 250;

/** Under this, km/h, the gorge has had a crash: 60. */
const CRASH = 30;

/** Under this, km/h, the tunnel's very busy: 60. */
const TUNNEL_BUSY = 45;

/** Under these, km/h, the motorway's queueing (60) or slowed (80). */
const QUEUE = 55;
const SLOWED = 75;

/**
 * At this much traffic, vehicles an hour a lane the busier way, the
 * motorway's in its rush (60), or busy (80): the counters' hours have the
 * morning's at 6 to 9 over 1100, the evening's at 4 to 6 near 1000.
 */
const RUSH = 1000;
const BUSY = 850;

/**
 * How fast traffic's going at `s` along `road`, km/h: NZTA's links within
 * NEAR m, averaged, else its leg there. Null if NZTA has no reading.
 */
export function speedAt(
  road: Pick<Carriageway, "links" | "legs">,
  s: number,
  speeds: TrafficSpeeds | null
): number | null {
  if (!speeds) return null;
  let sum = 0;
  let n = 0;

  for (const [a, z, key] of road.links) {
    if (z >= s - NEAR && a <= s + NEAR && speeds.links[key] !== undefined) {
      sum += speeds.links[key];
      n++;
    }
  }

  if (n) return sum / n;

  for (const [a, z, key] of road.legs) {
    if (s >= a && s < z && speeds.legs[key] !== undefined) {
      return speeds.legs[key];
    }
  }

  return null;
}

/**
 * The limit a lane sign on `zone` likely shows, km/h: from how fast traffic
 * goes under it (km/h, null with no reading) and how busy the hour usually
 * is (vehicles an hour a lane, the busier way).
 */
export function estimateLimit(
  zone: LaneZone,
  kmh: number | null,
  perLane: number
): number {
  const under = (limit: number) => kmh !== null && kmh < limit;

  if (zone === "gorge") return under(CRASH) ? 60 : 80;

  if (zone === "tunnel") return under(TUNNEL_BUSY) ? 60 : 70;

  if (under(QUEUE) || perLane >= RUSH) return 60;

  if (under(SLOWED) || perLane >= BUSY) return 80;

  return 100;
}
