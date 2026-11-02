import { luminance, max, uniform, vec4 } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

// Lights glow at night: a bloom on what's brighter than any lit surface gets
// after dark. Off by day, when sun glints on the water would bloom too.
// Kept faint and tight: city lights seen across a harbour are crisp points
// with only a hint of halo.

/** Linear luminance a light must pass to glow; only what's over it does. */
const THRESHOLD = 1;

/**
 * The bloom's five blur levels add up to about three times this of what
 * goes in, whatever the radius.
 */
const STRENGTH = 0.12;

/** 0..1: how far the glow spreads. */
const RADIUS = 0.15;

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

  const node = bloom(color, strength, RADIUS, THRESHOLD);

  // Three's high pass lets a light through whole once it's over the
  // threshold, so every lit window bloomed at full brightness. Only the
  // excess glows here, coming in gradually.
  node.highPassFn = ({ input, threshold }) => {
    const v = luminance(input.rgb);

    return vec4(input.rgb.mul(max(v.sub(threshold), 0).div(max(v, 1e-4))), 1);
  };

  return node;
}
