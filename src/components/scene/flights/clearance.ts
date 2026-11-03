import { BUILDINGS } from "../airport/airfield";
import type { ToWorld } from "./path";

// Aircraft on the ground are kept out of the airport's buildings. Fixes at
// the gate can be metres out, so a plane parked nose-in to the terminal
// would be drawn inside it; instead it's moved back (or on) along its
// heading until it's clear.

/** Furthest an aircraft is moved, in lengths. */
const REACH = 1;

/** Metres between the positions tried. */
const STEP = 1;

/**
 * An aircraft's outline as polygons of [forward, right] in lengths: the
 * fuselage (a 737 is 3.8 m wide and 39.5 m long, so with a metre to spare),
 * the wings, swept, spanning about the length as the airliners at WLG do,
 * and the tailplane.
 */
const OUTLINE: [number, number][][] = [
  [
    [0.5, 0.06],
    [-0.5, 0.06],
    [-0.5, -0.06],
    [0.5, -0.06],
  ],
  [
    [0.05, 0],
    [-0.12, 0.48],
    [-0.2, 0.48],
    [-0.15, 0],
    [-0.2, -0.48],
    [-0.12, -0.48],
  ],
  [
    [-0.38, 0],
    [-0.48, 0.18],
    [-0.5, 0.18],
    [-0.5, -0.18],
    [-0.48, -0.18],
  ],
];

/** World x, z, ... around a polygon. */
type Ring = Float64Array;

interface Footprint {
  ring: Ring;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * How far, metres, to move an aircraft at world (x, z) facing `heading`
 * (radians clockwise from north) along its heading so it's clear of every
 * building: negative is backwards. 0 if it's clear already, or can't be.
 */
export type Clearance = (
  x: number,
  z: number,
  heading: number,
  length: number
) => number;

/** Even-odd ray cast. */
function inside(ring: Ring, x: number, z: number) {
  let hit = false;

  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i];
    const zi = ring[i + 1];
    const xj = ring[j];
    const zj = ring[j + 1];

    if (zi > z !== zj > z && x < xj + ((z - zj) / (zi - zj)) * (xi - xj))
      hit = !hit;
  }

  return hit;
}

const cross = (ax: number, az: number, bx: number, bz: number) =>
  ax * bz - az * bx;

/** Whether edge i-j of one ring crosses edge k-l of another. */
function crosses(
  ring: Ring,
  i: number,
  j: number,
  other: Ring,
  k: number,
  l: number
) {
  const px = ring[j] - ring[i];
  const pz = ring[j + 1] - ring[i + 1];
  const qx = other[l] - other[k];
  const qz = other[l + 1] - other[k + 1];
  const d1 = cross(px, pz, other[k] - ring[i], other[k + 1] - ring[i + 1]);
  const d2 = cross(px, pz, other[l] - ring[i], other[l + 1] - ring[i + 1]);
  const d3 = cross(qx, qz, ring[i] - other[k], ring[i + 1] - other[k + 1]);
  const d4 = cross(qx, qz, ring[j] - other[k], ring[j + 1] - other[k + 1]);

  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Whether two polygons overlap: one inside the other, or edges crossing. */
function overlaps(a: Ring, b: Ring) {
  if (inside(b, a[0], a[1]) || inside(a, b[0], b[1])) return true;

  for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
    for (let k = 0, l = b.length - 2; k < b.length; l = k, k += 2) {
      if (crosses(a, i, j, b, k, l)) return true;
    }
  }

  return false;
}

export function createClearance(toWorld: ToWorld): Clearance {
  const footprints = BUILDINGS.map((flat): Footprint => {
    const ring = new Float64Array(flat.length);

    for (let i = 0; i < flat.length; i += 2) {
      [ring[i], ring[i + 1]] = toWorld(flat[i], flat[i + 1]);
    }

    const xs = ring.filter((_, i) => i % 2 === 0);
    const zs = ring.filter((_, i) => i % 2 === 1);

    return {
      ring,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    };
  });

  const shapes = OUTLINE.map((shape) => new Float64Array(shape.length * 2));

  return (x, z, heading, length) => {
    const reach = length * (REACH + 0.5);

    const near = footprints.filter(
      (f) =>
        x > f.minX - reach &&
        x < f.maxX + reach &&
        z > f.minZ - reach &&
        z < f.maxZ + reach
    );

    if (!near.length) return 0;
    const forward = [Math.sin(heading), -Math.cos(heading)];
    const right = [Math.cos(heading), Math.sin(heading)];

    const blocked = (shift: number) =>
      OUTLINE.some((outline, s) => {
        const shape = shapes[s];

        outline.forEach(([f, r], i) => {
          const along = f * length + shift;
          shape[2 * i] = x + forward[0] * along + right[0] * r * length;
          shape[2 * i + 1] = z + forward[1] * along + right[1] * r * length;
        });

        return near.some((footprint) => overlaps(shape, footprint.ring));
      });

    if (!blocked(0)) return 0;

    // Backing out first: aircraft park nose-in.
    for (let d = STEP; d <= length * REACH; d += STEP) {
      if (!blocked(-d)) return -d;

      if (!blocked(d)) return d;
    }

    return 0;
  };
}
