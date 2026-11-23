import { BufferGeometry, Vector3 } from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { block, FOOTING, member, v } from "./craneGeometry";

// Queens Wharf's two heritage cranes, restored in 2000: the level-luffing
// crane on its four-legged portal by the shed, and the tripod crane out on
// the wharf. In each crane's frame x runs the way its jib points, z across,
// y up; the origin is on the wharf under its slewing centre.
//
// Sized by eye from photos (people and cars for scale) and checked against
// what the survey caught of them: the council's model of the luffing crane
// tops out about 40 m up, its jib leaning south-south-east; the lidar found
// the tripod crane's jib tip about 31 m up, a few metres east. Members and
// proportions are guesses.

export interface LuffingCraneSpec {
  /** Between the portal's legs: along the quay, and across it, m. */
  portalLength: number;
  portalWidth: number;
  /** Top of the portal, where the crane slews, m. */
  portalHeight: number;
  /** Jib length from its foot pin, m, and above horizontal, radians. */
  jib: number;
  luff: number;
  /** Top of the A-frame on the machinery house, m. */
  aFrameHeight: number;
  colour: string;
}

export const LUFFING_CRANE_SPEC: LuffingCraneSpec = {
  portalLength: 7,
  portalWidth: 6,
  portalHeight: 8.5,
  jib: 27,
  luff: (70 * Math.PI) / 180,
  aFrameHeight: 20,
  colour: "#3c3f41",
};

export interface TripodCraneSpec {
  /** Feet from the slewing centre, m. */
  footRadius: number;
  /** Where the legs meet, under the slewing ring, m. */
  headHeight: number;
  /** Jib length from its foot pin, m, and above horizontal, radians. */
  jib: number;
  luff: number;
  colour: string;
}

export const TRIPOD_CRANE_SPEC: TripodCraneSpec = {
  footRadius: 4.6,
  headHeight: 8,
  jib: 21,
  luff: (76 * Math.PI) / 180,
  colour: "#c6c9c8",
};

const UP = new Vector3(0, 1, 0);

/** A rope or tie bar: drawn as a member this thick, m. */
const ROPE = 0.06;

/**
 * A lattice jib from `foot` at `luff` above +x: four chords tapering from
 * `width` × `depth` at the foot to `tipWidth` square at the tip, laced with
 * diagonals on all four faces. Returns its parts and the tip's centre.
 */
function latticeJib(
  foot: Vector3,
  length: number,
  luff: number,
  width: number,
  depth: number,
  tipWidth: number,
  panels: number
) {
  const along = v(Math.cos(luff), Math.sin(luff), 0);
  const normal = v(-Math.sin(luff), Math.cos(luff), 0);
  const parts: BufferGeometry[] = [];

  // Corner `k` (0..3, round the section) at `t` (0 foot .. 1 tip).
  const corner = (k: number, t: number) => {
    const w = (width + (tipWidth - width) * t) / 2;
    const d = (depth + (tipWidth - depth) * t) / 2;

    const [sz, sn] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ][k];

    return foot
      .clone()
      .addScaledVector(along, length * t)
      .addScaledVector(normal, sn * d)
      .add(v(0, 0, sz * w));
  };

  for (let k = 0; k < 4; k++) {
    parts.push(member(corner(k, 0), corner(k, 1), 0.28));

    // Lacing, zigzagging up each face.
    for (let p = 0; p < panels; p++) {
      const [t0, t1] = [p / panels, (p + 1) / panels];
      const [a, b] = p % 2 ? [k, (k + 1) % 4] : [(k + 1) % 4, k];
      parts.push(member(corner(a, t0), corner(b, t1), 0.1));
    }
  }

  // Frames across the foot and the tip.
  for (const t of [0, 1]) {
    for (let k = 0; k < 4; k++) {
      parts.push(member(corner(k, t), corner((k + 1) % 4, t), 0.2));
    }
  }

  const tip = foot.clone().addScaledVector(along, length);

  return { parts, tip };
}

/** A hook on its rope, hanging `drop` m below `from`. */
function hook(from: Vector3, drop: number) {
  const bottom = from.clone().add(v(0, -drop, 0));

  return [
    member(from, bottom, ROPE),
    block(bottom.clone().add(v(0, -0.4, 0)), [0.6, 0.8, 0.4]),
  ];
}

/** Where the luffing crane's jib is pinned to the front of its house. */
function luffingJibFoot(spec: LuffingCraneSpec) {
  return v(2.6, spec.portalHeight + 1.6, 0);
}

function luffingJibTip(spec: LuffingCraneSpec) {
  return luffingJibFoot(spec).add(
    v(Math.cos(spec.luff) * spec.jib, Math.sin(spec.luff) * spec.jib, 0)
  );
}

/**
 * The level-luffing crane. Its portal is turned by `slew` (radians, about
 * y) from the jib, so that it can stand square to the quay while the jib
 * points where it's parked.
 */
export function createLuffingCraneGeometry(
  spec: LuffingCraneSpec,
  slew: number
) {
  const l = spec.portalLength / 2;
  const w = spec.portalWidth / 2;
  const h = spec.portalHeight;
  const parts: BufferGeometry[] = [];

  // The portal's points, turned square to the quay. (Turned before the
  // members are made, so their `spread` turns with them.)
  const p = (x: number, y: number, z: number) =>
    v(x, y, z).applyAxisAngle(UP, slew);

  // Four legs, a girder frame round their tops, and braces in each face.
  const feet = [
    [-l, -w],
    [l, -w],
    [l, w],
    [-l, w],
  ];

  const brace = h * 0.45;

  for (let k = 0; k < 4; k++) {
    const [x, z] = feet[k];
    const [nx, nz] = feet[(k + 1) % 4];
    const middle = p((x + nx) / 2, h - 0.5, (z + nz) / 2);
    parts.push(member(p(x, -FOOTING, z), p(x, h, z), 0.7));
    parts.push(member(p(x, h, z), p(nx, h, nz), 0.6, 1));
    parts.push(member(p(x, brace, z), p(nx, brace, nz), 0.3));
    parts.push(member(p(x, brace, z), middle, 0.25));
    parts.push(member(p(nx, brace, nz), middle, 0.25));
    // A bogie under each leg.
    parts.push(block(p(x, 0.4, z), [1.1, 0.8, 1.1]));
  }

  // The slewing ring and deck, the machinery house on it, its cab forward
  // beside the jib, and the counterweight at the back.
  parts.push(block(v(0, h + 0.3, 0), [4.4, 0.6, 4.4]));
  parts.push(block(v(-1, h + 2.3, 0), [6.4, 3.4, 3.6]));
  parts.push(block(v(1.6, h + 2.8, 1.25), [1.8, 2.2, 1.2]));
  parts.push(block(v(-4.6, h + 1.6, 0), [1.4, 2.6, 3]));

  // The A-frame on the house, braced back to the house's rear corners.
  const top = v(-0.6, spec.aFrameHeight, 0);

  for (const z of [-1.5, 1.5]) {
    const apex = top.clone().add(v(0, 0, z * 0.5));
    parts.push(member(v(1.2, h + 4, z), apex, 0.45));
    parts.push(member(v(-3.6, h + 4, z), apex, 0.45));
  }

  parts.push(
    member(top.clone().add(v(0, 0, -0.75)), top.clone().add(v(0, 0, 0.75)), 0.4)
  );

  const foot = luffingJibFoot(spec);
  const jib = latticeJib(foot, spec.jib, spec.luff, 2.2, 1.6, 0.7, 14);
  parts.push(...jib.parts);

  // Tie bars from the A-frame's top to the jib, two-thirds up, and the
  // luffing rope's run from its drum in the house.
  const along = jib.tip.clone().sub(foot).normalize();
  const tie = foot.clone().addScaledVector(along, spec.jib * 0.66);

  for (const z of [-0.5, 0.5]) {
    parts.push(
      member(top.clone().add(v(0, 0, z)), tie.clone().add(v(0, 0.7, z)), 0.18)
    );
  }

  // The head sheave and the hook, hanging well clear of the portal.
  parts.push(block(jib.tip.clone().add(v(0.4, 0, 0)), [1.2, 0.9, 0.8]));
  parts.push(...hook(jib.tip.clone().add(v(0.9, -0.5, 0)), 9));

  return mergeGeometries(parts);
}

/** Highest point of the luffing crane above the wharf, m. */
export function luffingCraneHeight(spec: LuffingCraneSpec) {
  return luffingJibTip(spec).y + 0.5;
}

/** Where the tripod crane's jib is pinned, at the front of its house. */
function tripodJibFoot(spec: TripodCraneSpec) {
  return v(1.2, spec.headHeight + 2.6, 0);
}

function tripodJibTip(spec: TripodCraneSpec) {
  return tripodJibFoot(spec).add(
    v(Math.cos(spec.luff) * spec.jib, Math.sin(spec.luff) * spec.jib, 0)
  );
}

/** The tripod crane: three splayed legs, a house slewing on top, a jib. */
export function createTripodCraneGeometry(spec: TripodCraneSpec) {
  const h = spec.headHeight;
  const parts: BufferGeometry[] = [];

  // Legs out to the back and either side at the front, meeting under the
  // ring, each on a pad.
  for (const angle of [Math.PI, Math.PI / 3, -Math.PI / 3]) {
    const [x, z] = [Math.cos(angle), Math.sin(angle)];
    const r = spec.footRadius;
    // On down the leg's own line below the wharf.
    const below = r + ((r - 0.5) * FOOTING) / h;
    parts.push(
      member(v(x * below, -FOOTING, z * below), v(x * 0.5, h, z * 0.5), 0.7)
    );
    parts.push(block(v(x * r, 0.15, z * r), [1.2, 0.3, 1.2]));
  }

  // The ring the legs carry, a short king post, the house and its
  // counterweight.
  parts.push(block(v(0, h + 0.3, 0), [1.8, 0.8, 1.8]));
  parts.push(member(v(0, h + 0.6, 0), v(0, h + 1.4, 0), 1.1));
  parts.push(block(v(-0.4, h + 2.8, 0), [3.4, 2.8, 2.6]));
  parts.push(block(v(-2.6, h + 2.2, 0), [1, 1.8, 2.2]));

  // A small A-frame on the house, its pendant ropes up to the jib's tip.
  const apex = v(-1.2, h + 6.5, 0);

  for (const z of [-1, 1]) {
    parts.push(member(v(0.6, h + 4.2, z), apex, 0.3));
    parts.push(member(v(-2, h + 4.2, z), apex, 0.3));
  }

  const foot = tripodJibFoot(spec);
  const jib = latticeJib(foot, spec.jib, spec.luff, 1.5, 1, 0.4, 12);
  parts.push(...jib.parts);

  for (const z of [-0.2, 0.2]) {
    parts.push(member(apex, jib.tip.clone().add(v(0, 0.2, z)), ROPE));
  }

  parts.push(block(jib.tip.clone().add(v(0.3, 0, 0)), [0.9, 0.7, 0.5]));
  parts.push(...hook(jib.tip.clone().add(v(0.6, -0.4, 0)), 14));

  return mergeGeometries(parts);
}

/** Highest point of the tripod crane above the wharf, m. */
export function tripodCraneHeight(spec: TripodCraneSpec) {
  return tripodJibTip(spec).y + 0.4;
}
