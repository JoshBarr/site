import type { StructureType } from "./grid";

// The shapes of Transpower's structures. The data gives each one's kind
// (steel tower or pole, one circuit or two) and its line's voltage, and the
// lidar its height; the rest here is typical of such towers, not from
// drawings: check against photos.
//
// A structure's frame: x across the line, y up from its foot, z along the
// line. Everything above its body (crossarms, earth peak) is the same on
// every tower of a kind; the body below is as tall as the tower needs.

/** A crossarm: its tip, where the insulator hangs. */
interface Arm {
  /** Across from the tower's axis, m; negative is the other side. */
  x: number;
  /** Below the tower's top, m. */
  below: number;
}

interface Common {
  /** From the foot of the head (the body's top) to the tower's top, m. */
  head: number;
  /** The body is never shorter than this, whatever the lidar says, m. */
  minBody: number;
  /** Crossarm tips, top to bottom. */
  arms: Arm[];
  /** Each circuit's conductors, as indices into `arms`. */
  circuits: number[][];
  /** Insulator strings hang this far below the arms' tips, m. */
  insulator: number;
  /** Earth wires, where they're clamped: the tops of the peaks. */
  earth: Arm[];
  /**
   * A conductor's drawn width, m: three or four times the metal's (see
   * Wires.tsx).
   */
  gauge: number;
}

/** A steel lattice tower: a tapering body, a cage with crossarms, a peak. */
export interface CageSpec extends Common {
  form: "cage";
  /** Face width where the body meets the cage, and at the cage's top, m. */
  waist: number;
  crown: number;
  /** The earth peak's height over the cage, m. */
  peak: number;
  /** The body's faces widen by this for each metre down from the waist. */
  spread: number;
  /**
   * Width of the corner legs and of the bracing, m: about twice as wide as
   * the steel is, or the tower's spindly.
   */
  leg: number;
  brace: number;
}

/**
 * A flat-topped lattice tower: over the body's waist two limbs lean out to
 * a bridge, the middle conductor hanging in the window between them.
 */
export interface BridgeSpec extends Common {
  form: "bridge";
  waist: number;
  spread: number;
  /** Where the limbs meet the bridge, m either side of the axis. */
  limbs: number;
  /** The bridge is this far below the top (the earth peaks rise over it), m. */
  bridge: number;
  leg: number;
  brace: number;
}

/** A tubular pole with short arms. */
export interface PoleSpec extends Common {
  form: "pole";
  /** Diameter at the top, m, and how much it widens each metre down. */
  top: number;
  taper: number;
}

/** Two posts and a beam: a pi pole, or a substation's gantry. */
export interface FrameSpec extends Common {
  form: "frame";
  /** The posts stand this far either side of the axis, m. */
  posts: number;
  /** The beam's reach either side, m. */
  beam: number;
  top: number;
  taper: number;
}

export type TowerSpec = CageSpec | BridgeSpec | PoleSpec | FrameSpec;

export type TowerKind =
  | "double110"
  | "double220"
  | "single110"
  | "single220"
  | "hvdc"
  | "poleDouble"
  | "poleSingle"
  | "piPole"
  | "gantry";

/** Three arms a side: a circuit down each. */
const BOTH_SIDES = [
  [0, 2, 4],
  [1, 3, 5],
];

export const SPECS: Record<TowerKind, TowerSpec> = {
  // The 110 kV ring's double-circuit towers.
  double110: {
    form: "cage",
    head: 11,
    minBody: 5,
    waist: 2.2,
    crown: 1.1,
    peak: 3,
    spread: 0.2,
    leg: 0.25,
    brace: 0.14,
    arms: [
      { x: -3.4, below: 3 },
      { x: 3.4, below: 3 },
      { x: -4.2, below: 6.6 },
      { x: 4.2, below: 6.6 },
      { x: -3.6, below: 10.2 },
      { x: 3.6, below: 10.2 },
    ],
    circuits: BOTH_SIDES,
    insulator: 1.5,
    earth: [{ x: 0, below: 0 }],
    gauge: 0.11,
  },
  // Bunnythorpe to Wilton: bigger in every way.
  double220: {
    form: "cage",
    head: 19,
    minBody: 7,
    waist: 3.4,
    crown: 1.5,
    peak: 5,
    spread: 0.22,
    leg: 0.34,
    brace: 0.18,
    arms: [
      { x: -6.2, below: 5 },
      { x: 6.2, below: 5 },
      { x: -7.8, below: 11.4 },
      { x: 7.8, below: 11.4 },
      { x: -6.8, below: 17.8 },
      { x: 6.8, below: 17.8 },
    ],
    circuits: BOTH_SIDES,
    insulator: 2.6,
    earth: [{ x: 0, below: 0 }],
    gauge: 0.13,
  },
  // One circuit: two arms one side, one the other.
  single110: {
    form: "cage",
    head: 8.5,
    minBody: 5,
    waist: 1.8,
    crown: 1,
    peak: 2.6,
    spread: 0.2,
    leg: 0.22,
    brace: 0.12,
    arms: [
      { x: -3.2, below: 2.6 },
      { x: 3.4, below: 5 },
      { x: -3.4, below: 7.4 },
    ],
    circuits: [[0, 1, 2]],
    insulator: 1.5,
    earth: [{ x: 0, below: 0 }],
    gauge: 0.11,
  },
  // The 1950s Bunnythorpe to Haywards lines: low and wide, the conductors
  // side by side under a bridge, an earth wire over each limb.
  single220: {
    form: "bridge",
    head: 9,
    minBody: 4,
    waist: 2,
    spread: 0.24,
    limbs: 3.8,
    bridge: 2.5,
    leg: 0.3,
    brace: 0.16,
    arms: [
      { x: -7.6, below: 3 },
      { x: 0, below: 3 },
      { x: 7.6, below: 3 },
    ],
    circuits: [[0, 1, 2]],
    insulator: 2.6,
    earth: [
      { x: -3.8, below: 0 },
      { x: 3.8, below: 0 },
    ],
    gauge: 0.13,
  },
  // The HVDC link: a pole of the link either side, each a circuit of one.
  hvdc: {
    form: "cage",
    head: 8.6,
    minBody: 8,
    waist: 3,
    crown: 1.3,
    peak: 7,
    spread: 0.2,
    leg: 0.34,
    brace: 0.18,
    arms: [
      { x: -8.5, below: 7 },
      { x: 8.5, below: 7 },
    ],
    circuits: [[0], [1]],
    insulator: 4,
    earth: [{ x: 0, below: 0 }],
    gauge: 0.19,
  },
  poleDouble: {
    form: "pole",
    head: 6.4,
    minBody: 4,
    top: 0.4,
    taper: 0.022,
    arms: [
      { x: -2, below: 1 },
      { x: 2, below: 1 },
      { x: -2.4, below: 3.4 },
      { x: 2.4, below: 3.4 },
      { x: -2, below: 5.8 },
      { x: 2, below: 5.8 },
    ],
    circuits: BOTH_SIDES,
    insulator: 1.2,
    earth: [{ x: 0, below: 0 }],
    gauge: 0.1,
  },
  poleSingle: {
    form: "pole",
    head: 5,
    minBody: 4,
    top: 0.35,
    taper: 0.022,
    arms: [
      { x: -1.8, below: 0.8 },
      { x: 1.9, below: 2.6 },
      { x: -1.9, below: 4.4 },
    ],
    circuits: [[0, 1, 2]],
    insulator: 1.2,
    earth: [{ x: 0, below: 0 }],
    gauge: 0.1,
  },
  piPole: {
    form: "frame",
    head: 1,
    minBody: 6,
    posts: 2.6,
    beam: 4.6,
    top: 0.35,
    taper: 0.02,
    arms: [
      { x: -4.4, below: 0.5 },
      { x: 0, below: 0.5 },
      { x: 4.4, below: 0.5 },
    ],
    circuits: [[0, 1, 2]],
    insulator: 1.5,
    earth: [],
    gauge: 0.11,
  },
  // Where a line lands in a substation. Its conductors come down to the
  // beam wherever they fall along it (see network.ts): it has no arms.
  gantry: {
    form: "frame",
    head: 1,
    minBody: 6,
    posts: 8,
    beam: 8.6,
    top: 0.45,
    taper: 0.015,
    arms: [],
    circuits: [],
    insulator: 0,
    earth: [],
    gauge: 0.11,
  },
};

/** The link runs at ±350 kV; nothing else here is over 220. */
const HVDC_KV = 350;

/** Which shape a structure of Transpower's type takes, on a line of `kv`. */
export function kindOf(type: StructureType, kv: number): TowerKind {
  switch (type) {
    case "D":
    case "T":
      if (kv >= HVDC_KV) return "hvdc";

      return kv >= 220 ? "double220" : "double110";
    case "S":
      return kv >= 220 ? "single220" : "single110";
    case "DP":
      return "poleDouble";
    case "SP":
      return "poleSingle";
    case "PI":
      return "piPole";
    case "X":
      return "gantry";
  }
}

/** A gantry's height, which the lidar wasn't asked: by its line's voltage, m. */
export function gantryHeight(kv: number) {
  if (kv >= HVDC_KV) return 13;

  if (kv >= 220) return 14;

  return kv >= 110 ? 11 : 9;
}

/** A tower's body: what's under its head, m. */
function bodyHeight(spec: TowerSpec, height: number) {
  return Math.max(height - spec.head, spec.minBody);
}

/** How tall a tower's drawn: its body may not be as short as measured. */
export function drawnHeight(spec: TowerSpec, height: number) {
  return bodyHeight(spec, height) + spec.head;
}

/** Where a conductor is clamped under an arm: across, and up from the foot. */
export function clampPoint(spec: TowerSpec, arm: Arm, height: number) {
  return {
    x: arm.x,
    y: drawnHeight(spec, height) - arm.below - spec.insulator,
  };
}

/** The same for an earth wire, which sits on its peak. */
export function earthPoint(spec: TowerSpec, arm: Arm, height: number) {
  return { x: arm.x, y: drawnHeight(spec, height) - arm.below };
}
