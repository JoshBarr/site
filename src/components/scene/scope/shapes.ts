import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type Material,
  SphereGeometry,
} from "three/webgpu";

// The parts satellites are built from, in metres about their middles, on the
// model's axes: x along its way, y up away from the Earth, z across.

export type Axis = "x" | "y" | "z";

export type At = [number, number, number];

/** Turns a y-up geometry to lie along `axis`, its +y end toward +axis. */
function along(geometry: BufferGeometry, axis: Axis) {
  if (axis === "x") geometry.rotateZ(-Math.PI / 2);

  if (axis === "z") geometry.rotateX(Math.PI / 2);

  return geometry;
}

function place(
  group: Group,
  geometry: BufferGeometry,
  material: Material,
  [x, y, z]: At
) {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  group.add(mesh);

  return mesh;
}

/** A cylinder `length` long along `axis`. */
export function tube(
  group: Group,
  material: Material,
  radius: number,
  length: number,
  axis: Axis,
  at: At = [0, 0, 0],
  segments = 28
) {
  const geometry = new CylinderGeometry(radius, radius, length, segments);

  return place(group, along(geometry, axis), material, at);
}

/**
 * A cone or frustum `length` long along `axis`: `back` radius toward −axis,
 * `front` toward +axis. Open-ended, it's a shell (an engine bell).
 */
export function cone(
  group: Group,
  material: Material,
  back: number,
  front: number,
  length: number,
  axis: Axis,
  at: At = [0, 0, 0],
  open = false
) {
  const geometry = new CylinderGeometry(front, back, length, 28, 1, open);

  return place(group, along(geometry, axis), material, at);
}

export function box(
  group: Group,
  material: Material,
  [sx, sy, sz]: At,
  at: At = [0, 0, 0]
) {
  return place(group, new BoxGeometry(sx, sy, sz), material, at);
}

export function ball(
  group: Group,
  material: Material,
  radius: number,
  at: At = [0, 0, 0]
) {
  return place(group, new SphereGeometry(radius, 24, 16), material, at);
}

/** A dish `radius` across, `depth` deep, facing +`axis`. */
export function dish(
  group: Group,
  material: Material,
  radius: number,
  depth: number,
  axis: Axis,
  at: At = [0, 0, 0]
) {
  // The bottom of a sphere, scaled flat; its cup toward +y, then turned.
  const geometry = new SphereGeometry(
    radius,
    24,
    8,
    0,
    Math.PI * 2,
    Math.PI * 0.6,
    Math.PI * 0.4
  );

  geometry.scale(1, depth / (radius * (1 + Math.cos(Math.PI * 0.6))), 1);

  return place(group, along(geometry, axis), material, at);
}

/**
 * A flat solar panel `long` by `wide`, `thick` through, facing ±y: long
 * along `axis` (x or z), centred at `at`.
 */
export function panel(
  group: Group,
  material: Material,
  long: number,
  wide: number,
  axis: "x" | "z",
  at: At = [0, 0, 0],
  thick = 0.08
) {
  const size: At = axis === "x" ? [long, thick, wide] : [wide, thick, long];

  return box(group, material, size, at);
}
