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
  If,
  int,
  Loop,
  max,
  min,
  mix,
  perspectiveDepthToViewZ,
  rtt,
  smoothstep,
  sqrt,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { switchedOff } from "./stats";

// Thin-lens depth of field. The blur circle is A·f/s · |1 − s/d| for aperture
// A, focal length f, focus distance s and depth d. A real lens focused
// hundreds of metres away is sharp to the horizon, so the aperture here is
// miniature-scale, and grows with s so that A·f/s holds steady: the blur at
// the horizon is set by the f-number alone, wherever the focus is, and the
// depth of field is the same share of the focus distance at every range.
// Focus is autofocus's: the orbit target, or a landmark in front of it, or
// exactly a point the viewer held a press on to orbit around.

/** Blur at the horizon, as a fraction of the largest blur, at f/4. */
const BLUR_AT_F4 = 0.3;

/** Blur at the horizon, as a fraction of the largest blur. */
const backgroundBlur = uniform(BLUR_AT_F4);

/** Distance to the plane of focus, metres. */
const focusDistance = uniform(1000);

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
 * fills the disc evenly): at most this many for the blur, and a quarter as
 * many again for the bokeh.
 */
const BLUR_TAPS = 64;
const GOLDEN_ANGLE = 2.39996323;

const SPIRAL = Array.from({ length: 80 }, (_, i) => {
  const r = Math.sqrt(i / 80);
  const angle = i * GOLDEN_ANGLE;

  return new Vector2(r * Math.cos(angle), r * Math.sin(angle));
});

const bokehTaps = uniformArray(SPIRAL.filter((_, i) => i % 5 === 0));

/**
 * The blur's taps go by the disc's area: all of them only at the largest
 * blur, and never fewer than this. Most of a frame is nearly sharp, its
 * disc a pixel or two across, where 64 taps read the same few texels: at the
 * overview this is most of what the depth of field cost (?off=doftaps for
 * all 64 everywhere).
 */
const FEWEST_TAPS = 5;

/**
 * Blurs under this, 0..1 of the largest, spread no highlights: the disc is
 * within a texel of the half-size blur, and it's mixed in at under a fifth.
 */
const NO_BOKEH = 0.09;

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
 * The target within this share of its distance of the picked point is still
 * on it: the controls' bounds and easing leave it a hair off.
 */
const PICKED_SLOP = 0.01;

/** Full and third stops, widest first, as a camera's dial has them. */
export const F_NUMBERS = [
  1, 1.1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3,
  7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22,
];

/** The scene's own: autofocus's look before there were controls. */
export const DEFAULT_F_NUMBER = 4;

let fNumber = DEFAULT_F_NUMBER;

/** A point the viewer picked to orbit around, focused on exactly. */
let picked: Vector3 | null = null;

/**
 * Focuses exactly on `point` while the orbit target's there: picked by the
 * viewer, it's the subject itself, not the ground behind one.
 */
export function focusOn(point: Vector3) {
  picked = (picked ?? new Vector3()).copy(point);
}

export const getFNumber = () => fNumber;

/** Opens (smaller) or stops down (larger) the lens: more blur or less. */
export function setFNumber(n: number) {
  fNumber = Math.min(
    Math.max(n, F_NUMBERS[0]),
    F_NUMBERS[F_NUMBERS.length - 1]
  );
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
 * frame, in front of the target, gets the focus to itself, unless the target
 * was picked by the viewer. With `own`, the telescope's: the scene's
 * f-number, whatever the viewer set.
 */
export function updateLens(
  renderer: WebGPURenderer,
  camera: Camera,
  target: Vector3,
  delta: number,
  own = false
) {
  renderer.getDrawingBufferSize(size);
  maxRadius.value = size.y * MAX_RADIUS_OF_HEIGHT;
  texel.value.set(1 / size.x, 1 / size.y);

  if (camera instanceof PerspectiveCamera) {
    near.value = camera.near;
    far.value = camera.far;
  }

  backgroundBlur.value =
    (BLUR_AT_F4 * DEFAULT_F_NUMBER) / (own ? DEFAULT_F_NUMBER : fNumber);

  camera.getWorldPosition(origin);
  camera.getWorldDirection(axis);
  // Along the view axis, as depth is.
  const subject = Math.max(toTarget.subVectors(target, origin).dot(axis), 10);
  let focus: number;

  if (picked && picked.distanceTo(target) < subject * PICKED_SLOP) {
    focus = subject;
  } else {
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 50;
    const slop = 2 * Math.tan((fov * Math.PI) / 360) * FOCUS_SLOP;
    const landmark = landmarkDistance(slop);

    // Landmarks are the subject themselves: no pull toward the camera.
    focus = landmark < subject ? landmark : subject * FOCUS_PULL;
  }

  // Ease by ratio, so racking 200 m → 2 km takes as long as 2 km → 20 km.
  const ease = 1 - Math.exp(-delta / FOCUS_TIME);
  focusDistance.value *= Math.pow(focus / focusDistance.value, ease);
}

/** Signed blur at a scene depth (negative in front of focus), -1..1. */
const blurAt = (viewZ) =>
  clamp(
    backgroundBlur.mul(float(1).sub(focusDistance.div(viewZ.negate()))),
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
 * depth as it's needed. An average of up to 64 taps makes the blur, then the
 * brightest of 16 taps around spreads highlights (sun on the water, lamps)
 * into discs, the bokeh.
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

  const everyTap = switchedOff("doftaps");

  const blurred = rtt(
    Fn(() => {
      const at = uv();
      const amount = blurOf(at);
      const step = texel.mul(maxRadius).mul(amount);
      const sum = vec3(0).toVar();

      const count = int(
        everyTap
          ? float(BLUR_TAPS)
          : min(amount.mul(amount).mul(BLUR_TAPS).add(FEWEST_TAPS), BLUR_TAPS)
      ).toVar();

      // Vogel's spiral for however many taps: each a golden angle on from
      // the last, turned by hand rather than by sin and cos.
      const turn = vec2(Math.cos(GOLDEN_ANGLE), Math.sin(GOLDEN_ANGLE));
      const toward = vec2(1, 0).toVar();

      Loop(
        { start: int(0), end: count, type: "int", condition: "<" },
        ({ i }) => {
          const r = sqrt(float(i).add(0.5).div(float(count)));

          sum.addAssign(half.sample(at.add(step.mul(toward).mul(r))).rgb);
          toward.assign(
            vec2(
              toward.x.mul(turn.x).sub(toward.y.mul(turn.y)),
              toward.x.mul(turn.y).add(toward.y.mul(turn.x))
            )
          );
        }
      );

      return vec4(sum.div(float(count)), amount);
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

      If(centre.a.greaterThan(everyTap ? -1 : NO_BOKEH), () => {
        Loop(bokehTaps.array.length, ({ i }) => {
          const tap: any = bokehTaps.element(i);
          brightest.assign(
            max(brightest, blurred.sample(at.add(step.mul(tap))).rgb)
          );
        });
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
