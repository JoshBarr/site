import { uniform } from "three/tsl";

// One account of the light under cloud. Droplets take almost nothing out of
// the light: a cloud turns the sun's beam aside, some of it back up and the
// rest out of its base as an even light. So what's under a sky of cloud is
// lit by the beam where there's a gap, and everywhere by what the cloud
// passes; and the ground, the haze over it and the cloud's own underside
// all have it from the same sum. (Each had a number of its own until
// 2026-11-27: a seventh of the sun under a deck, 0.9 on the sky's light, the
// sun's 1.2 on the deck's underside, 0.4 of the haze's glow.)

/**
 * Of the sun's (or the moon's) beam, the share that gets under the cloud,
 * over the whole sky: what the air and anything else that doesn't look up
 * its own shadow is lit by, and what's beyond the cloud shadow map's edge.
 */
export const sunUnderCloud = uniform(1);

/**
 * The sun on a level white wall, as the scene's light: what the top of a
 * deck is lit by, of which its underside shows what gets down through it.
 */
export const sunOnDeck = uniform(0);

/** A layer of cloud, as the light meets it. */
export interface CloudOver {
  /** Of the sky, how much it covers, 0..1. */
  cover: number;
  /** Of the light on its cloud, what comes out underneath, 0..1. */
  passes: number;
}

/** The light on level ground. */
export interface LightUnder {
  /** Of the beam, the share still a beam: through the gaps. */
  beam: number;
  /** The even light, as `sky` is given. */
  diffuse: number;
}

/**
 * The light under `layers` of cloud, the highest first, of a `beam` (the
 * sun's light on level ground) and the `sky`'s above them. Each column of
 * sky's taken on its own: where a layer's clear both go by, and where it's
 * cloud what it passes of both comes out even.
 */
export function lightUnder(
  layers: CloudOver[],
  beam: number,
  sky: number
): LightUnder {
  let share = 1;
  let diffuse = sky;

  for (const { cover, passes } of layers) {
    const cloud = Math.min(Math.max(cover, 0), 1);

    diffuse = diffuse * (1 - cloud) + cloud * passes * (beam * share + diffuse);
    share *= 1 - cloud;
  }

  return { beam: share, diffuse };
}
