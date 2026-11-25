import { luminance, max, uniform, vec4 } from "three/tsl";
import { switchedOff } from "./stats";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

// Lights glow at night: a bloom on what's brighter than any lit surface gets
// after dark. Off by day, when sun glints on the water would bloom too.
// Kept faint and tight: city lights seen across a harbour are crisp points
// with only a hint of halo.

/** Linear luminance a light must pass to glow; only what's over it does. */
const THRESHOLD = 1;

/**
 * The bloom's blur levels add up to about 2.2 times this of what goes in
 * (three with all five), whatever the radius.
 */
const STRENGTH = 0.12;

/**
 * Of three's five blur levels, each half the size of the last, the ones
 * drawn. A level is two passes, and a pass costs about a tenth of a
 * millisecond on an M1 however small it is: the two widest, a quarter of the
 * glow spread over hundreds of pixels, made no difference to see at this
 * strength (?off=bloomlevels for all five, ?off=bloom for no glow).
 */
const LEVELS = 3;

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
  if (!night || switchedOff("bloom")) return null;

  const node = bloom(color, strength, RADIUS, THRESHOLD);

  if (!switchedOff("bloomlevels")) {
    // SAFETY: BloomNode blurs and sizes its levels up to _nMips
    // (BloomNode.js, updateBefore), which its types leave out. A three
    // that's dropped it ignores this and draws all five.
    (node as typeof node & { _nMips: number })._nMips = LEVELS;

    // The rest are never drawn: nothing of them in the sum.
    for (const tint of node.bloomTintColors.slice(LEVELS)) tint.setScalar(0);
  }

  // Three's high pass lets a light through whole once it's over the
  // threshold, so every lit window bloomed at full brightness. Only the
  // excess glows here, coming in gradually.
  node.highPassFn = ({ input, threshold }) => {
    const v = luminance(input.rgb);

    return vec4(input.rgb.mul(max(v.sub(threshold), 0).div(max(v, 1e-4))), 1);
  };

  return node;
}
