import { uniform } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

// Lights glow at night: a bloom on what's brighter than any lit surface gets
// after dark. Off by day, when sun glints on the water would bloom too.

/** Linear luminance a light must pass to glow. */
const THRESHOLD = 0.5;
const STRENGTH = 1.1;
/** 0..1: how far the glow spreads. */
const RADIUS = 0.5;

/** A uniform, so it changes through dusk without rebuilding the pass. */
const strength = uniform(0);

/** How strongly lights glow, 0..1. */
export function setNightGlow(night: number) {
  strength.value = STRENGTH * night;
}

/**
 * The glow of `color` (the scene pass's linear HDR output), to add to it,
 * at the strength setNightGlow gives. Null by day: no pass at all.
 */
export function nightGlow(color, night: boolean) {
  if (!night) return null;
  return bloom(color, strength, RADIUS, THRESHOLD);
}
