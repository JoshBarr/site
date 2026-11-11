import {
  dot,
  fract,
  renderOutput,
  screenCoordinate,
  vec2,
  vec4,
} from "three/tsl";

// The scene is dark greys under smooth skies, and the canvas holds 8 bits a
// channel: a sky's ramp fell one level every ten or so pixels, in bands
// across it. A level's worth of noise before it's rounded breaks them up
// into grain too fine to see.

/** Interleaved gradient noise, 0..1: even over any few neighbouring pixels. */
const noise = (at) =>
  fract(fract(dot(at, vec2(0.06711056, 0.00583715))).mul(52.9829189));

/**
 * `color` (the frame's last node, linear) as the canvas shows it, tone mapped
 * and in its colour space, dithered: for a pipeline whose own output
 * transform is off. Two noises summed, less their mean, are triangular over
 * a level either way, which leaves no trace of the rounding in the grain's
 * strength; the same on each channel, so greys stay grey.
 */
export function dithered(color) {
  const shown = renderOutput(color);
  const at = screenCoordinate.xy;

  const grain = noise(at)
    .add(noise(at.add(vec2(47.3, 17.9))))
    .sub(1);

  return vec4(shown.rgb.add(grain.div(255)), shown.a);
}
