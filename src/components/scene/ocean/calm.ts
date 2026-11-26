import { useSyncExternalStore } from "react";
import { exp, float, pow } from "three/tsl";

// The sea's look where it's calm and level, shared with the water that runs
// out into it (../lakes/water.ts): a river's last reach is at the sea's
// height and shaded as the sea is there, by these, so the two meet without
// a line. ./Ocean.tsx shades with them too: one definition, not two alike.

/** How much of the mirror the sea shows. */
export const MIRROR = 0.5;

/** How tight the sun's glint is off smooth water: the exponent of its lobe. */
export const GLINT = 900;

/**
 * How much of the light that enters the sea scatters back out, over `depth`
 * m of it. Deep water swallows the light and goes darker. Two falloffs, so
 * the chart's bands read: pale shelves over the first five metres or so, the
 * harbour basin and dredged berths (10-20m) a mid tone, Cook Strait (100m+)
 * black. Reflectances, well under the land's (sand 0.26, grass 0.15).
 */
export function seaReflectance(depth) {
  return float(0.001)
    .add(exp(depth.div(-40)).mul(0.014))
    .add(exp(depth.div(-4.5)).mul(0.07));
}

/**
 * Of the sun's light on a facet, `facing` it (a cosine), what scatters back
 * out toward the eye, over the sea's own reflectance: brighter on crests
 * facing the sun.
 */
export function sunScatter(facing) {
  return facing.mul(0.02);
}

/** The sun's glint off a facet that mirrors it, by how nearly (a cosine). */
export function sparkle(sunAmount) {
  return pow(sunAmount, GLINT).mul(40);
}

/** And the wide, faint sheen round it. */
export function sheen(sunAmount) {
  return pow(sunAmount, 60).mul(0.25);
}

/** In shadow the mirror's held back a little, to this share. */
export const MIRROR_SHADED = 0.85;

export interface CalmSea {
  /** What a level, unruffled sea mirrors at this pixel: a colour node. */
  // SAFETY: a TSL vec3 node, which three's types don't name usefully.
  mirrored: any;
  /**
   * And what it mirrors where its surface is tilted by `slope` (along x
   * and z, a vec2 node): the same mirror, looked up a little to one side.
   */
  mirroredBy: (slope: any) => any;
  /** The sea's depth at a world xz, m: a float node. */
  depthAt: (xz: any) => any;
}

let calm: CalmSea | null = null;

const listeners = new Set<() => void>();

/** The sea's drawn (or, with null, no longer): what's shaded as it can be. */
export function setCalmSea(sea: CalmSea | null) {
  calm = sea;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** The sea that's drawn, once it is. */
export function useCalmSea() {
  return useSyncExternalStore(
    subscribe,
    () => calm,
    () => null
  );
}
