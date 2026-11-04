import type { Vector3 } from "three";
import type { HeightQuery } from "./terrain/Terrain";

/** First step along the ray, m; steps then grow with the distance gone. */
const FIRST_STEP = 5;
const STEP_GROWTH = 0.02;

/** Halvings to close in on where the ray goes under, once it has. */
const REFINE = 12;

/**
 * How far from `from`, along the unit `direction`, the ray first meets the
 * ground or the sea, up to `reach`, m. Null if it doesn't by then: looking at
 * the sky, or out over the horizon.
 */
export function groundAlong(
  from: Vector3,
  direction: Vector3,
  heightAt: HeightQuery,
  reach: number
): number | null {
  const above = (t: number) =>
    from.y +
    direction.y * t -
    Math.max(
      heightAt(from.x + direction.x * t, from.z + direction.z * t) ?? 0,
      0
    );

  if (above(0) <= 0) return 0;
  let near = 0;

  for (let t = FIRST_STEP; near < reach; t += FIRST_STEP + t * STEP_GROWTH) {
    const far = Math.min(t, reach);

    if (above(far) <= 0) {
      let [a, b] = [near, far];

      for (let i = 0; i < REFINE; i++) {
        const middle = (a + b) / 2;

        if (above(middle) > 0) a = middle;
        else b = middle;
      }

      return b;
    }

    near = far;
  }

  return null;
}
