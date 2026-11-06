import type { Vector3 } from "three/webgpu";
import type { HeightQuery } from "../terrain/Terrain";

// Where the telescope stands: not down on the ground, where the hillside or
// the building beside it fills the long lens, but up over the roofs, high
// enough to see over the hills along the line to the satellite.

/**
 * Clear of the tallest roofs, m over the ground: the Majestic Centre's
 * 116 m, and some.
 */
export const ROOFS = 130;

/** First step out along the line to it, m; steps then grow by this much. */
const FIRST_STEP = 20;
const STEP_GROWTH = 0.05;

/** The line's this far up past the highest hills by here, m: far enough. */
const HIGHEST = 1000;

/** And no further out than this, m, however low it is. */
const REACH = 12_000;

/**
 * The lowest the camera can stand, m up, over (`x`, `z`), to see along the
 * unit `direction` (up into the sky) over the terrain and whatever's built
 * on it; never under `floor`.
 */
export function vantage(
  x: number,
  z: number,
  direction: Vector3,
  heightAt: HeightQuery,
  floor: number
) {
  const across = Math.hypot(direction.x, direction.z);
  // Up per metre across; straight up, nothing along the way.
  const climb = across > 1e-6 ? direction.y / across : Infinity;

  const [dx, dz] =
    across > 1e-6 ? [direction.x / across, direction.z / across] : [0, 0];

  const ground = (d: number) =>
    Math.max(heightAt(x + dx * d, z + dz * d) ?? 0, 0);

  let lowest = Math.max(ground(0) + ROOFS, floor);

  if (!Number.isFinite(climb) || climb <= 0) return lowest;
  const reach = Math.min(HIGHEST / climb, REACH);

  for (let d = FIRST_STEP; d <= reach; d += FIRST_STEP + d * STEP_GROWTH) {
    lowest = Math.max(lowest, ground(d) + ROOFS - d * climb);
  }

  return lowest;
}
