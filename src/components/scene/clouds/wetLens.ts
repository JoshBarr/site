import { Camera, Vector3 } from "three/webgpu";
import {
  Fn,
  If,
  clamp,
  float,
  floor,
  fract,
  hash,
  max,
  min,
  mix,
  screenSize,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  time,
  uniform,
  vec2,
  vec4,
} from "three/tsl";
import type { RainUniforms } from "./rain";

// Water on the lens when it's raining on the camera: beads that land, sit
// and evaporate, and heavier drops that run down, leaving a beaded trail.
// Each bends the view behind it, upside down.

/** 0..1: how wet the lens is. */
export const lensWetness = uniform(0);

/** Seconds to wet through in rain, and to dry off out of it. */
const WETTING = 4;
const DRYING = 15;

/** Beads sit in a grid this many cells tall, one at most to a cell. */
const BEAD_ROWS = 12;
/** Drops run down this many columns across a screen height's width. */
const RUN_COLUMNS = 9;
/** A drop shows what's this many of its radii away, inverted. */
const REFRACTION = 2.5;
/** Spread of the samples that soften what a drop shows, of the screen. */
const BLUR = 0.004;

const forward = new Vector3();
const falling = new Vector3();

/**
 * Eases the wetness toward how hard it's raining on the camera, `rainfall`
 * (0..1). Drops land on a lens that faces them: looking down, hardly any do.
 */
export function updateLensWetness(
  camera: Camera,
  rainfall: number,
  rain: RainUniforms,
  delta: number
) {
  camera.getWorldDirection(forward);
  falling
    .set(rain.wind.value.x, -rain.fall.value, rain.wind.value.y)
    .normalize();
  const facing = Math.max(-forward.dot(falling), 0);
  const target = Math.min(rainfall * (0.25 + 0.75 * facing), 1);
  const wet = lensWetness.value;
  const seconds = target > wet ? WETTING : DRYING;
  lensWetness.value = wet + (target - wet) * (1 - Math.exp(-delta / seconds));
}

/**
 * Smooth minimum of two distances: shapes within k of each other run
 * together. h is how much of the result is a's.
 */
function smoothMin(a, b, k) {
  const h = clamp(b.sub(a).div(k).mul(0.5).add(0.5), 0, 1);
  return { d: mix(b, a, h).sub(k.mul(h).mul(float(1).sub(h))), h };
}

/**
 * The finished `frame`, seen through a wet lens. `view` gives the frame's
 * colour at a screen uv, near enough, for what the drops bend into view.
 */
export function wetLens(frame, view: (uv) => any) {
  return Fn(() => {
    const color = frame.rgb.toVar();

    If(lensWetness.greaterThan(0.001), () => {
      const aspect = screenSize.x.div(screenSize.y);
      // Screen heights, y down.
      const p = vec2(screenUV.x.mul(aspect), screenUV.y);

      // Beads, each coming in at its own wetness so more gather as the lens
      // wets, and going as it dries.
      const g = p.mul(BEAD_ROWS);
      const cell = floor(g);
      const seed = cell.y.mul(997).add(cell.x).mul(8);
      const r = (k: number) => hash(seed.add(k));
      const centre = cell.add(0.5).add(vec2(r(0), r(1)).sub(0.5).mul(0.5));
      const t = fract(time.div(mix(4, 10, r(2))).add(r(3)));
      const present = smoothstep(r(4), r(4).add(0.1), lensWetness.mul(1.1));
      // Screen heights.
      const beadRadius = max(
        mix(0.1, 0.28, r(5))
          .mul(smoothstep(0, 0.03, t))
          .mul(sqrt(float(1).sub(t)))
          .mul(present),
        1e-5
      ).div(BEAD_ROWS);
      const fromBead = g.sub(centre).div(BEAD_ROWS);
      const bead = fromBead.length().sub(beadRadius);

      // Runners: one at a time down each column, each trip its own drop.
      // Only once the lens is well wet.
      const width = 1 / RUN_COLUMNS;
      const column = floor(p.x.div(width));
      const speed = mix(0.08, 0.2, hash(column.mul(8).add(50001)));
      const s = time.mul(speed).add(hash(column.mul(8).add(50002)));
      const tripSeed = column.mul(131).add(floor(s)).mul(8).add(90000);
      const q = (k: number) => hash(tripSeed.add(k));
      // Slow to start, then sliding faster as it gathers water.
      const progress = fract(s);
      const headY = progress.mul(progress).mul(1.4).sub(0.2);
      const x = column
        .add(mix(0.25, 0.75, q(0)))
        .mul(width)
        .add(sin(p.y.mul(23).add(q(1).mul(6.28))).mul(width * 0.06));
      const active = smoothstep(
        q(3).mul(0.6).add(0.4),
        q(3).mul(0.6).add(0.5),
        lensWetness
      );
      const runRadius = mix(0.012, 0.022, q(2));
      const headRadius = max(runRadius.mul(active), 1e-5);
      const fromHead = vec2(p.x.sub(x), p.y.sub(headY).mul(0.8));
      const head = fromHead.length().sub(headRadius);

      // Its trail: beads left behind, smaller further up as they dry.
      const behind = headY.sub(p.y);
      const spacing = runRadius.mul(2.2);
      const fromTrail = vec2(
        p.x.sub(x),
        fract(behind.div(spacing)).sub(0.5).mul(spacing)
      );
      const trailRadius = max(
        runRadius
          .mul(0.45)
          .mul(smoothstep(0, 0.02, behind))
          .mul(smoothstep(0.4, 0, behind))
          .mul(active),
        1e-5
      );
      const trail = fromTrail.length().sub(trailRadius);

      // Water runs together: a runner's head into its trail, and the runner
      // into any bead in its way, as much as the smaller of the two is big.
      // What's merged bends the view as one drop.
      const runner = smoothMin(head, trail, min(headRadius, trailRadius));
      const runnerRadius = mix(trailRadius, headRadius, runner.h);
      const merged = smoothMin(runner.d, bead, min(runnerRadius, beadRadius));
      const radius = mix(beadRadius, runnerRadius, merged.h);
      const water = smoothstep(0, radius.mul(-0.25), merged.d);

      const bend = -(1 + REFRACTION);
      const offset = mix(fromBead, mix(fromTrail, fromHead, runner.h), merged.h)
        .mul(water)
        .mul(bend);

      If(water.greaterThan(0.001), () => {
        const uv = screenUV.add(vec2(offset.x.div(aspect), offset.y));
        const seen = view(uv.add(vec2(BLUR, 0)))
          .add(view(uv.sub(vec2(BLUR, 0))))
          .add(view(uv.add(vec2(0, BLUR))))
          .add(view(uv.sub(vec2(0, BLUR))))
          .mul(0.25);
        // Darker toward each drop's rim, where it bends the light away.
        const rim = water.mul(float(1).sub(water)).mul(4);
        color.assign(
          mix(color, seen.mul(1.08), water).mul(float(1).sub(rim.mul(0.3)))
        );
      });
    });

    return vec4(color, 1);
  })();
}
