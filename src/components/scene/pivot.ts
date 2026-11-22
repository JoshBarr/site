import { Camera, Quaternion, Vector3 } from "three/webgpu";

// Holding a press on something to orbit around it: the point under the
// pointer, from the depth the scene was drawn with, becomes the orbit target.
// The camera stays where it is and turns to look at it; only where the orbit
// can't be (nearer than its closest, or above the camera) does it move.

const ray = new Vector3();
const axis = new Vector3();

/**
 * The point `depth` m along `camera`'s view axis under `x`, `y` (-1..1
 * across and up the view, as three has it).
 */
export function pointAt(camera: Camera, x: number, y: number, depth: number) {
  camera.updateMatrixWorld();
  ray.set(x, y, 0.5).unproject(camera).sub(camera.position).normalize();
  camera.getWorldDirection(axis);

  return ray
    .clone()
    .multiplyScalar(depth / ray.dot(axis))
    .add(camera.position);
}

/**
 * Where the camera goes to orbit `point`, and `point`: from `from`, no
 * nearer than `nearest` and no farther than `farthest`, and no lower than
 * it (the orbit never looks up). In map view (`target` given, what it's
 * aimed at now) the whole view slides over instead, looking as it did.
 */
export function pivotView(
  from: Vector3,
  point: Vector3,
  nearest: number,
  farthest: number,
  target?: Vector3
): [Vector3, Vector3] {
  if (target) return [from.clone().sub(target).add(point), point.clone()];

  const to = from.clone();
  to.y = Math.max(to.y, point.y);
  const back = to.sub(point);
  back.setLength(Math.min(Math.max(back.length(), nearest), farthest));

  return [back.add(point), point.clone()];
}

const turn = new Quaternion();
const still = new Quaternion();
const fromLook = new Vector3();
const toLook = new Vector3();

/**
 * The camera and its target `s` (0..1) of the way through a pivot: turning
 * steadily from one view to the other, and the target's distance changing
 * by ratio, so the view doesn't race at the end of a turn onto something
 * near.
 */
export function pivotAt(
  from: [Vector3, Vector3],
  to: [Vector3, Vector3],
  s: number,
  out: [Vector3, Vector3]
) {
  const [p, t] = out;
  p.lerpVectors(from[0], to[0], s);
  fromLook.subVectors(from[1], from[0]);
  toLook.subVectors(to[1], to[0]);
  const near = fromLook.length();
  const far = toLook.length();

  turn
    .setFromUnitVectors(fromLook.normalize(), toLook.normalize())
    .slerp(still, 1 - s);

  t.copy(fromLook)
    .applyQuaternion(turn)
    .multiplyScalar(near * (far / near) ** s)
    .add(p);

  return out;
}
