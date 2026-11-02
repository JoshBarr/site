import {
  Camera,
  PerspectiveCamera,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { clamp, float, uniform } from "three/tsl";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";

// Thin-lens depth of field. The blur circle is A·f/s · |1 − s/d| for aperture
// A, focal length f, focus distance s and depth d. A real lens focused
// hundreds of metres away is sharp to the horizon, so the aperture here is
// miniature-scale, and grows with s so that A·f/s holds steady: every shot
// gets the same softness behind the subject, zoomed in or out.

/** Blur at the horizon, as a fraction of the largest blur. */
const backgroundBlur = uniform(0.3);

/** Distance to the plane of focus, metres. */
const focusDistance = uniform(1000);

/** Largest blur radius, pixels. Set as a fraction of the frame height. */
const maxRadius = uniform(7);
const MAX_RADIUS_OF_HEIGHT = 0.008;

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
 * frame, in front of the target, gets the focus to itself.
 */
export function updateLens(
  renderer: WebGPURenderer,
  camera: Camera,
  target: Vector3,
  delta: number
) {
  maxRadius.value =
    renderer.getDrawingBufferSize(size).y * MAX_RADIUS_OF_HEIGHT;
  camera.getWorldPosition(origin);
  camera.getWorldDirection(axis);
  const fov = camera instanceof PerspectiveCamera ? camera.fov : 50;
  const slop = 2 * Math.tan((fov * Math.PI) / 360) * FOCUS_SLOP;
  // Along the view axis, as depth is.
  const subject = Math.max(toTarget.subVectors(target, origin).dot(axis), 10);
  const landmark = landmarkDistance(slop);
  // Landmarks are the subject themselves: no pull toward the camera.
  const focus = landmark < subject ? landmark : subject * FOCUS_PULL;
  // Ease by ratio, so racking 200 m → 2 km takes as long as 2 km → 20 km.
  const ease = 1 - Math.exp(-delta / FOCUS_TIME);
  focusDistance.value *= Math.pow(focus / focusDistance.value, ease);
}

/** Blurs `color` by the scene depth (`viewZ`, negative in front). */
export function depthOfField(color, viewZ) {
  // Signed: negative in front of focus, where it grows without bound.
  const blur = clamp(
    backgroundBlur.mul(float(1).sub(focusDistance.div(viewZ.negate()))),
    -1,
    1
  );

  // The dof node blurs by smoothstep(0, focalLength, |viewZ| − focus) and
  // treats negatives as in front, so hand it the signed blur in place of depth.
  return dof(color, blur.negate(), 0, 1, maxRadius);
}
