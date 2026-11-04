import { HalfFloatType } from "three/webgpu";
import {
  abs,
  dot,
  exp,
  float,
  floor,
  fract,
  Fn,
  hash,
  If,
  min,
  mix,
  mx_noise_float,
  rtt,
  screenCoordinate,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { switchedOff } from "../stats";
import { isTravelling } from "./jump";

// While the scene's travelling to another time (./jump.ts), the frame plays
// like a television losing its signal: the picture slips its vertical hold
// and rolls, jerks now and then, wobbles side to side in bands, the colours
// pull apart, and snow and scanlines come up over it, worst along the
// tracking band at the bottom. Off, the frame goes straight through, and
// the copy of it the effect bends isn't drawn.

/** 0 for a clean picture, 1 for the worst of it. */
const strength = uniform(0);

/** Seconds, wrapped, for the noise to move by. */
const time = uniform(0);

/** How far the picture's rolled, in frame heights (only its fraction shows). */
const roll = uniform(0);

/** A new frame of snow 60 times a second, wrapped. */
const frame = uniform(0);

/** Seconds to come up and to clear. */
const RISE = 0.15;
const FALL = 0.4;

/** Frame heights a second the picture rolls at full strength. */
const ROLL_SPEED = 0.35;

/** Smooth noise along `x`, about -1..1; `seed` picks a different line of it. */
const noise = (x, seed: number) => mx_noise_float(vec2(x, seed));

/** The frame `screen` (an rtt of it), bent by `strength`. */
function distort(screen) {
  const s = strength;
  const at = uv();

  // Now and then the picture jumps a little, then settles.
  const jerking = step(0.5, noise(time.mul(1.7), 1));
  const jerk = jerking.mul(noise(time.mul(40), 2)).mul(s.mul(0.04));
  const y = fract(at.y.add(roll).add(jerk));

  // The tracking band at the bottom: lines torn sideways.
  const band = smoothstep(0.12, 0, y).mul(s);

  // Wide, slow bands of sideways wobble, and a jitter on every line.
  const line = floor(y.mul(240)).add(frame.mul(1031));
  const fuzz = hash(line).sub(0.5).mul(0.004);
  const wobble = noise(y.mul(4).add(time.mul(0.9)), 3).mul(0.012);
  const tear = noise(y.mul(90).add(time.mul(25)), 4).mul(band.mul(0.06));
  const x = at.x.add(wobble.add(fuzz).mul(s)).add(tear);

  // Red and blue pulled either way, more where it wobbles.
  const split = s.mul(0.003).add(abs(wobble).mul(0.4).mul(s));
  const red = screen.sample(vec2(x.add(split), y)).r;
  const green = screen.sample(vec2(x, y)).g;
  const blue = screen.sample(vec2(x.sub(split), y)).b;
  const picture = vec3(red, green, blue).toVar();

  // Washed out a little, as off air.
  const grey = dot(picture, vec3(0.2126, 0.7152, 0.0722));
  picture.assign(mix(picture, vec3(grey), s.mul(0.35)));

  // Snow, on the picture and over it: thickest in the tracking band.
  const pixel = floor(screenCoordinate.xy);

  const snow = hash(
    pixel.x.add(pixel.y.mul(4096)).add(frame.mul(7919)).mod(16_777_216)
  );

  picture.assign(
    picture
      .mul(snow.sub(0.5).mul(s.mul(0.6)).add(1))
      .add(snow.mul(s.mul(0.03).add(band.mul(0.25))))
  );

  // Scanlines, fixed to the screen, and a dark bar where the frames meet as
  // it rolls.
  const scan = sin(screenCoordinate.y.mul(Math.PI * (2 / 3)))
    .mul(0.5)
    .add(0.5);

  const seam = smoothstep(0, 0.025, min(y, float(1).sub(y)));

  // A broad shadow drifting up the screen.
  const shadow = exp(
    fract(at.y.sub(time.mul(0.23)))
      .sub(0.5)
      .pow(2)
      .mul(-40)
  );

  const shade = float(1)
    .sub(scan.mul(0.3).mul(s))
    .mul(mix(float(1), seam, s))
    .mul(float(1).sub(shadow.mul(0.25).mul(s)));

  return vec4(picture.mul(shade), 1);
}

/**
 * The frame's last pass: `output` straight through, or while travelling,
 * a copy of it bent as a TV losing its signal. `update` each frame before
 * rendering; `dispose` with the pipeline.
 */
export function tvScreen(output) {
  if (switchedOff("tv")) {
    return { node: output, update() {}, dispose() {} };
  }

  const screen = rtt(output, null, null, { type: HalfFloatType });

  // A real branch on a uniform: off, the copy's never read.
  const node = Fn(() => {
    const color = vec4(0).toVar();

    If(strength.greaterThan(0), () => {
      color.assign(distort(screen));
    }).Else(() => {
      color.assign(output);
    });

    return color;
  })();

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  return {
    node,
    update(delta: number) {
      const on = isTravelling() && !reduced.matches;
      const target = on ? 1 : 0;
      const ease = 1 - Math.exp(-delta / (on ? RISE : FALL));

      strength.value += (target - strength.value) * ease;

      if (!on && strength.value < 0.002) strength.value = 0;

      time.value = (time.value + delta) % 1000;
      // Clearing, the picture's caught back on the nearest whole frame.
      roll.value = on
        ? (roll.value + delta * ROLL_SPEED * strength.value ** 2) % 1
        : roll.value + (Math.round(roll.value) - roll.value) * ease;
      frame.value = Math.floor(performance.now() / (1000 / 60)) % 1000;
      // The copy's only drawn while it's shown.
      screen.autoUpdate = strength.value > 0;
    },
    dispose() {
      screen.dispose();
    },
  };
}
