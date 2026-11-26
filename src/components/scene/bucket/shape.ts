// One bucket's shape and how it hangs. The fountain's buckets are fibreglass
// scoops: a pointed foot, a wide mouth cut on a slant so the rim's low at
// the front, its lip, and high at the back. Each hangs on a level axle
// through its sides, a little below its middle, and rests leaning back on a
// stop; full, it tips forward over its lip, pours, and swings back.
//
// In a bucket's own frame, at its size 1 (it's drawn and worked out scaled
// by its size, m): the axle's along x, the lip faces +z, and y is up the
// bucket's axis, its pivot at the origin. The proportions are by eye from
// photos.

export type V3 = [number, number, number];

/** The foot's this far below the axle. */
export const FOOT = 0.5;

/** The rim's this high over the axle at the back, and at the lip. */
const BACK = 0.4;
const LIP = 0.06;

/** Its radius at the foot and the rim. */
const FOOT_RADIUS = 0.13;
const RIM_RADIUS = 0.48;

/** Flattened across the axle, drawn out toward the lip. */
const ACROSS = 0.85;
const FORE = 1.1;

/** At rest it leans back this far on its stop, radians. */
export const REST = 0.2;

/**
 * A point on the shell: `s` 0..1 from foot to rim, `phi` round from the lip
 * (0) toward +x. The lip's drawn out a little more, into a spout.
 */
export function shell(s: number, phi: number): V3 {
  const radius = FOOT_RADIUS + (RIM_RADIUS - FOOT_RADIUS) * s ** 0.55;
  const rim = BACK - ((BACK - LIP) * (1 + Math.cos(phi))) / 2;
  const spout = 1 + 0.15 * s ** 3 * Math.max(Math.cos(phi), 0) ** 4;

  return [
    radius * Math.sin(phi) * ACROSS,
    -FOOT + s * (rim + FOOT),
    radius * Math.cos(phi) * FORE * spout,
  ];
}

/** The middle of its lip. */
export const LIP_POINT: V3 = shell(1, 0);

/** The middle of its mouth: what water falling in must hit. */
export const MOUTH: V3 = (() => {
  const n = 32;
  const sum: V3 = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const p = shell(1, (i / n) * 2 * Math.PI);
    sum[0] += p[0] / n;
    sum[1] += p[1] / n;
    sum[2] += p[2] / n;
  }

  return sum;
})();

/** The mouth's radius, about: across, where it's narrowest. */
export const MOUTH_RADIUS = RIM_RADIUS * ACROSS;

/**
 * Where a point of the bucket, in its own frame, is once it's tipped `tip`
 * radians forward from rest: turned about the axle (x), y toward z.
 */
function tipped([x, y, z]: V3, tip: number): V3 {
  const a = tip - REST;
  const c = Math.cos(a);
  const s = Math.sin(a);

  return [x, y * c - z * s, y * s + z * c];
}

/** How a bucket hangs: its pivot, size and which way its lip faces. */
export interface Hang {
  /** Its pivot, m, in the fountain's frame. */
  pivot: V3;
  /** Its size: a scale on the shape, about its height in m. */
  size: number;
  /** Which way its lip faces, radians about y from +z toward +x. */
  facing: number;
}

/** A point of the bucket, its own frame, into the fountain's, at `tip`. */
export function place({ pivot, size, facing }: Hang, point: V3, tip: number) {
  const [x, y, z] = tipped(point, tip);
  const c = Math.cos(facing);
  const s = Math.sin(facing);

  return [
    pivot[0] + (x * c + z * s) * size,
    pivot[1] + y * size,
    pivot[2] + (-x * s + z * c) * size,
  ] satisfies V3;
}

/** The way its lip faces, a level unit vector in the fountain's frame. */
export const ahead = ({ facing }: Hang): V3 => [
  Math.sin(facing),
  0,
  Math.cos(facing),
];

/** Its axle, a level unit vector in the fountain's frame. */
export const axle = ({ facing }: Hang): V3 => [
  Math.cos(facing),
  0,
  -Math.sin(facing),
];
