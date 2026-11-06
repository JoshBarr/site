import {
  Camera,
  HalfFloatType,
  PerspectiveCamera,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import {
  abs,
  clamp,
  float,
  Fn,
  Loop,
  max,
  min,
  mix,
  perspectiveDepthToViewZ,
  rtt,
  smoothstep,
  uniform,
  uniformArray,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { switchedOff } from "./stats";

// Thin-lens depth of field. The blur circle is A·f/s · |1 − s/d| for aperture
// A, focal length f, focus distance s and depth d. A real lens focused
// hundreds of metres away is sharp to the horizon, so the aperture here is
// miniature-scale, and grows with s so that A·f/s holds steady: every shot
// gets the same softness behind the subject, zoomed in or out. It grows with
// where autofocus would focus, though, not with the focus shift: focusing
// nearer than that softens the distance, and farther sharpens it, as on a
// real lens.

/** Blur at the horizon, as a fraction of the largest blur. */
const backgroundBlur = uniform(0.3);

/** Distance to the plane of focus, metres. */
const focusDistance = uniform(1000);

/**
 * Autofocus's distance over the focus distance: how much more blur the focus
 * shift leaves behind the subject, 1 for none.
 */
const shiftBlur = uniform(1);

/** Largest blur radius, pixels. Set as a fraction of the frame height. */
const maxRadius = uniform(7);
const MAX_RADIUS_OF_HEIGHT = 0.008;

/** One pixel of the frame, in uv. */
const texel = uniform(new Vector2(1, 1));

/** The scene camera's planes, for depths read in the blur's own pass. */
const near = uniform(5);
const far = uniform(80000);

/**
 * Lens blur taps, as three's dof node lays them out (Vogel's spiral, which
 * fills the disc evenly): every fifth of 80 for the bokeh, the rest for the
 * blur.
 */
const SPIRAL = Array.from({ length: 80 }, (_, i) => {
  const r = Math.sqrt(i / 80);
  const angle = i * 2.39996323;

  return new Vector2(r * Math.cos(angle), r * Math.sin(angle));
});

const blurTaps = uniformArray(SPIRAL.filter((_, i) => i % 5 !== 0));
const bokehTaps = uniformArray(SPIRAL.filter((_, i) => i % 5 === 0));

/**
 * Focus this far toward the camera from the orbit target. Blur levels off behind
 * focus but grows without bound in front, so pulling focus in a little barely
 * softens the subject and keeps the foreground much sharper.
 */
const FOCUS_PULL = 0.6;

/** Seconds for focus to settle most of the way on a new subject. */
const FOCUS_TIME = 0.3;

/**
 * A landmark this near the middle of the frame, as a fraction of the frame
 * height, takes the focus: thin towers far off are hard to aim at exactly.
 */
const FOCUS_SLOP = 0.01;

/**
 * The most focus can be moved from where autofocus puts it, in stops: each
 * one doubles its distance, or halves it.
 */
export const FOCUS_SHIFT_MAX = 2;

/** Focus moved from where autofocus puts it, in stops; 0 leaves it there. */
let focusShift = 0;

export const getFocusShift = () => focusShift;

/** Moves focus beyond (more) or in front of (less) where autofocus puts it. */
export function setFocusShift(stops: number) {
  focusShift = Math.min(Math.max(stops, -FOCUS_SHIFT_MAX), FOCUS_SHIFT_MAX);
}

/** Something standing on the ground that autofocus can land on. */
export type FocusSubject =
  | {
      /** A vertical mast, e.g. a tower. */
      kind: "post";
      /** World position of the base. */
      base: [number, number, number];
      height: number;
      /** Radius at a height above the base, m. */
      radius: (height: number) => number;
    }
  | {
      /** A ball, e.g. the disc a rotor sweeps, whichever way it faces. */
      kind: "ball";
      centre: [number, number, number];
      radius: number;
    };

const subjects = new Set<FocusSubject[]>();

/** Lets autofocus land on these. Returns a function that takes them away. */
export function addFocusSubjects(list: FocusSubject[]) {
  subjects.add(list);

  return () => {
    subjects.delete(list);
  };
}

const size = new Vector2();
const origin = new Vector3();
const axis = new Vector3();
const toTarget = new Vector3();

/**
 * Distance along the view axis to the nearest subject it passes within
 * `slop` (radians) of, measured to the subject's centre line. Infinity for
 * none.
 */
function landmarkDistance(slop: number) {
  let nearest = Infinity;

  for (const list of subjects) {
    for (const subject of list) {
      if (subject.kind === "post") {
        // Closest approach to the mast's axis, seen from above.
        const [x, y, z] = subject.base;
        const across = axis.x * axis.x + axis.z * axis.z;

        if (across < 1e-6) continue;
        const t = ((x - origin.x) * axis.x + (z - origin.z) * axis.z) / across;

        if (t <= 0 || t >= nearest) continue;
        const up = origin.y + axis.y * t - y;

        if (up < 0 || up > subject.height + t * slop) continue;

        const miss = Math.hypot(
          origin.x + axis.x * t - x,
          origin.z + axis.z * t - z
        );

        const radius = subject.radius(Math.min(up, subject.height));

        if (miss <= radius + t * slop) nearest = t;
      } else {
        const [x, y, z] = subject.centre;
        const dx = x - origin.x;
        const dy = y - origin.y;
        const dz = z - origin.z;
        const t = dx * axis.x + dy * axis.y + dz * axis.z;

        if (t <= 0 || t >= nearest) continue;

        const miss = Math.sqrt(
          Math.max(dx * dx + dy * dy + dz * dz - t * t, 0)
        );

        if (miss <= subject.radius + t * slop) nearest = t;
      }
    }
  }

  return nearest;
}

/**
 * Focus on what the camera orbits around, `target`, racking smoothly as it
 * moves, and size the blur to the frame. A landmark in the middle of the
 * frame, in front of the target, gets the focus to itself. The focus shift
 * moves it nearer or farther from there.
 */
export function updateLens(
  renderer: WebGPURenderer,
  camera: Camera,
  target: Vector3,
  delta: number
) {
  renderer.getDrawingBufferSize(size);
  maxRadius.value = size.y * MAX_RADIUS_OF_HEIGHT;
  texel.value.set(1 / size.x, 1 / size.y);

  if (camera instanceof PerspectiveCamera) {
    near.value = camera.near;
    far.value = camera.far;
  }

  camera.getWorldPosition(origin);
  camera.getWorldDirection(axis);
  const fov = camera instanceof PerspectiveCamera ? camera.fov : 50;
  const slop = 2 * Math.tan((fov * Math.PI) / 360) * FOCUS_SLOP;
  // Along the view axis, as depth is.
  const subject = Math.max(toTarget.subVectors(target, origin).dot(axis), 10);
  const landmark = landmarkDistance(slop);

  // Landmarks are the subject themselves: no pull toward the camera.
  // Then moved in or out as the viewer asks.
  const focus =
    (landmark < subject ? landmark : subject * FOCUS_PULL) * 2 ** focusShift;

  // Ease by ratio, so racking 200 m → 2 km takes as long as 2 km → 20 km.
  const ease = 1 - Math.exp(-delta / FOCUS_TIME);
  focusDistance.value *= Math.pow(focus / focusDistance.value, ease);
  shiftBlur.value *= Math.pow(2 ** -focusShift / shiftBlur.value, ease);
}

/** Signed blur at a scene depth (negative in front of focus), -1..1. */
const blurAt = (viewZ) =>
  clamp(
    backgroundBlur
      .mul(shiftBlur)
      .mul(float(1).sub(focusDistance.div(viewZ.negate()))),
    -1,
    1
  );

/**
 * How blurred something `distance` m along the view axis is, 0..1 of the
 * largest blur: for what blurs into bright blots, to fade it instead.
 */
export const lensBlur = (distance) =>
  switchedOff("dof")
    ? float(0)
    : smoothstep(0, 1, abs(blurAt(distance.negate())));

/**
 * Blurs `color` by the scene's `depth` texture, as three's dof node does but
 * in three passes at half size rather than seven, two of them full size:
 * near and far share one blur, and how blurred each pixel is comes from the
 * depth as it's needed. A 64-tap average makes the blur, then the brightest
 * of 16 taps around spreads highlights (sun on the water, lamps) into
 * discs, the bokeh.
 */
export function depthOfField(color, depth) {
  if (switchedOff("dof")) return color;

  // 0..1 of the largest blur.
  const blurOf = (at) =>
    smoothstep(
      0,
      1,
      abs(blurAt(perspectiveDepthToViewZ(depth.sample(at).r, near, far)))
    );

  const halfSize = { type: HalfFloatType, resolutionScale: 0.5 };
  const half = rtt(color, null, null, halfSize);

  const blurred = rtt(
    Fn(() => {
      const at = uv();
      const amount = blurOf(at);
      const step = texel.mul(maxRadius).mul(amount);
      const sum = vec3(0).toVar();

      Loop(blurTaps.array.length, ({ i }) => {
        const tap: any = blurTaps.element(i);
        sum.addAssign(half.sample(at.add(step.mul(tap))).rgb);
      });

      return vec4(sum.div(blurTaps.array.length), amount);
    })(),
    null,
    null,
    halfSize
  );

  const bokeh = rtt(
    Fn(() => {
      const at = uv();
      const centre = blurred.sample(at);
      const step = texel.mul(maxRadius).mul(centre.a);
      const brightest = centre.rgb.toVar();

      Loop(bokehTaps.array.length, ({ i }) => {
        const tap: any = bokehTaps.element(i);
        brightest.assign(
          max(brightest, blurred.sample(at.add(step.mul(tap))).rgb)
        );
      });

      return vec4(brightest, centre.a);
    })(),
    null,
    null,
    halfSize
  );

  const soft = bokeh.sample(uv());

  // As three's composite: fully soft from half the largest blur.
  return vec4(mix(color.rgb, soft.rgb, min(soft.a, 0.5).mul(2)), 1);
}
