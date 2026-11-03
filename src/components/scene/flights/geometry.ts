import { ModelBuilder, Vec, WINDOW_GLOW } from "../models/builder";
import type { Shape } from "./airframes";

// Unit aircraft, scaled by length. Nose toward -z, from z = -0.5 to 0.5; wings
// along x; the fuselage centred on y = 0. Flat shaded. Every airframe's white
// with a grey tail. Each comes plain, for the many seen from afar, and
// detailed, for the few up close: rounder, with windows, engine intakes,
// winglets, and, when it's down, gear. Props and rotors are apart, so they
// can turn.

const BODY = 0xf2f2ef;
const TAIL = 0x8c8f93;
const WING = 0xd4d6d8;
const NACELLE = 0xe0e1e2;
const DARK = 0x2a2d30;

/** Props' and rotors' blades. */
export const BLADE = DARK;
const GLASS = 0x1c2226;
const STRUT = 0x5a5c5e;
const TYRE = 0x1e1e1e;

/**
 * The fuselage's centre above the ground, unit lengths, where the gear or
 * skids reach down to: an airliner's engines hang low, with half a metre
 * under them.
 */
export const RIDE_HEIGHT: Record<Shape, number> = {
  jet: 0.11,
  prop: 0.08,
  helicopter: 0.156,
};

/** What hangs out: gear. */
export interface Detail {
  gear?: boolean;
}

type Ring = [number, number, number];

/** A fuselage's radius and centre height at z, between its rings. */
function ringAt(rings: Ring[], z: number): [number, number] {
  for (let i = 0; i < rings.length - 1; i++) {
    const [z0, r0, y0] = rings[i];
    const [z1, r1, y1] = rings[i + 1];

    if (z <= z1 || i === rings.length - 2) {
      const u = Math.min(Math.max((z - z0) / (z1 - z0), 0), 1);

      return [r0 + (r1 - r0) * u, y0 + (y1 - y0) * u];
    }
  }

  return [rings[0][1], rings[0][2]];
}

/**
 * A patch painted on a fuselage, just proud of it: z0..z1 along, between
 * angles a0 and a1, degrees from starboard up round over the top.
 */
function patch(
  b: ModelBuilder,
  rings: Ring[],
  z0: number,
  z1: number,
  a0: number,
  a1: number
) {
  const at = (z: number, degrees: number): Vec => {
    const [r, y] = ringAt(rings, z);
    const a = (degrees * Math.PI) / 180;

    return [Math.cos(a) * r * 1.03, y + Math.sin(a) * r * 1.03, z];
  };

  const [, y] = ringAt(rings, (z0 + z1) / 2);
  b.quad([0, y, (z0 + z1) / 2], at(z0, a0), at(z1, a0), at(z1, a1), at(z0, a1));
}

/** A cockpit's windscreen, in panes, from z0 to z1. */
function windscreen(b: ModelBuilder, rings: Ring[], z0: number, z1: number) {
  b.use(GLASS);

  for (const [a0, a1] of [
    [26, 52],
    [56, 86],
    [94, 124],
    [128, 154],
  ]) {
    patch(b, rings, z0, z1, a0, a1);
  }
}

/** A row of cabin windows down each side, lit at night. */
function cabinWindows(
  b: ModelBuilder,
  rings: Ring[],
  from: number,
  to: number,
  pitch: number,
  width: number,
  [low, high]: [number, number]
) {
  b.use(GLASS, WINDOW_GLOW);

  for (let z = from; z <= to; z += pitch) {
    patch(b, rings, z, z + width, low, high);
    patch(b, rings, z, z + width, 180 - high, 180 - low);
  }
}

/** A pair of wings or tailplanes, flat: root and tip chords, [front, back]. */
function wings(
  b: ModelBuilder,
  y: number,
  root: [number, number],
  span: number,
  tip: [number, number],
  thickness: number
) {
  for (const side of [-1, 1]) {
    b.slab(
      [
        [0, y, root[0]],
        [side * span, y, tip[0]],
        [side * span, y, tip[1]],
        [0, y, root[1]],
      ],
      [0, thickness, 0]
    );
  }
}

/**
 * A pair of wings with thickness, thinning to the tips, which `rise` above
 * the root: an airfoil of six points, blunt in front.
 */
function sweptWings(
  b: ModelBuilder,
  y: number,
  root: [number, number],
  span: number,
  tip: [number, number],
  [rootThickness, tipThickness]: [number, number],
  rise = 0
) {
  const airfoil = (
    x: number,
    base: number,
    [front, back]: [number, number],
    t: number
  ): Vec[] => {
    const chord = back - front;

    return [
      [x, base + t * 0.4, front],
      [x, base + t, front + chord * 0.25],
      [x, base + t * 0.6, front + chord * 0.7],
      [x, base + t * 0.1, back],
      [x, base, front + chord * 0.6],
      [x, base, front + chord * 0.15],
    ];
  };

  for (const side of [-1, 1]) {
    b.loft([
      airfoil(0, y, root, rootThickness),
      airfoil(side * span, y + rise, tip, tipThickness),
    ]);
  }
}

/** A vertical fin from the fuselage top: root and top chords. */
function fin(
  b: ModelBuilder,
  y: number,
  root: [number, number],
  height: number,
  top: [number, number],
  thickness: number
) {
  const x = -thickness / 2;
  b.use(TAIL).slab(
    [
      [x, y, root[0]],
      [x, y + height, top[0]],
      [x, y + height, top[1]],
      [x, y, root[1]],
    ],
    [thickness, 0, 0]
  );
}

/** A leg down to a pair of wheels, axles across, standing on `ground`. */
function leg(
  b: ModelBuilder,
  ground: number,
  [x, top, z]: Vec,
  radius: number,
  spread: number,
  strut: number
) {
  const axle = ground + radius;
  b.use(STRUT).cylinder([x, top, z], [x, axle, z], strut);
  b.use(TYRE);

  for (const side of [-1, 1]) {
    const inner = x + side * strut;
    b.cylinder([inner, axle, z], [inner + side * spread, axle, z], radius);
  }
}

/** Blades round a hub at `at` facing along z, from `inner` out to `radius`. */
function blades(
  b: ModelBuilder,
  [x, y, z]: Vec,
  count: number,
  inner: number,
  radius: number,
  width: number,
  start = Math.PI / 4
) {
  for (let i = 0; i < count; i++) {
    const a = start + (i / count) * 2 * Math.PI;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const [nc, ns] = [-s * width, c * width];
    b.slab(
      [
        [x + c * inner - nc, y + s * inner - ns, z],
        [x + c * radius - nc, y + s * radius - ns, z],
        [x + c * radius + nc, y + s * radius + ns, z],
        [x + c * inner + nc, y + s * inner + ns, z],
      ],
      [0, 0, width * 0.3]
    );
  }
}

const JET: Ring[] = [
  [-0.5, 0.004, -0.012],
  [-0.47, 0.03, -0.004],
  [-0.42, 0.05, 0],
  [0.24, 0.053, 0],
  [0.42, 0.03, 0.018],
  [0.5, 0.008, 0.03],
];

const JET_DETAILED: Ring[] = [
  [-0.5, 0.004, -0.012],
  [-0.493, 0.016, -0.009],
  [-0.484, 0.026, -0.006],
  [-0.47, 0.036, -0.003],
  [-0.45, 0.045, -0.001],
  [-0.425, 0.051, 0],
  [-0.4, 0.053, 0],
  [0.24, 0.053, 0],
  [0.3, 0.049, 0.005],
  [0.36, 0.042, 0.011],
  [0.42, 0.03, 0.018],
  [0.46, 0.02, 0.024],
  [0.5, 0.008, 0.03],
];

/** The jet's wingtips are this far above the root. */
export const JET_WING_RISE = 0.04;
const JET_WING_Y = -0.035;

/** Twin-engined airliner: low swept wing, engines under it. */
export function createJetGeometry(detailed = false, { gear }: Detail = {}) {
  const b = new ModelBuilder();
  b.sides = detailed ? 20 : 8;
  b.use(BODY).tube(detailed ? JET_DETAILED : JET);

  if (!detailed) {
    sweptWings(
      b,
      JET_WING_Y,
      [-0.1, 0.12],
      0.475,
      [0.13, 0.2],
      [0.012, 0.012],
      JET_WING_RISE
    );

    for (const x of [-0.17, 0.17]) {
      b.tube(
        [
          [-0.13, 0.026, -0.07],
          [-0.02, 0.026, -0.07],
          [0.02, 0.016, -0.065],
        ],
        x
      );
    }

    wings(b, 0.012, [0.36, 0.48], 0.17, [0.45, 0.5], 0.008);
    fin(b, 0.03, [0.28, 0.48], 0.17, [0.43, 0.5], 0.012);

    return b.build();
  }

  windscreen(b, JET_DETAILED, -0.47, -0.452);
  cabinWindows(b, JET_DETAILED, -0.37, 0.22, 0.014, 0.0065, [8, 17]);

  b.use(WING);
  sweptWings(
    b,
    JET_WING_Y,
    [-0.1, 0.12],
    0.475,
    [0.13, 0.2],
    [0.016, 0.006],
    JET_WING_RISE
  );

  // Sharklets, up from the tips.
  for (const side of [-1, 1]) {
    const x = side * 0.475;
    const y = JET_WING_Y + JET_WING_RISE + 0.003;
    b.use(TAIL).slab(
      [
        [x, y, 0.13],
        [x + side * 0.004, y + 0.035, 0.185],
        [x + side * 0.004, y + 0.035, 0.205],
        [x, y, 0.2],
      ],
      [0.003, 0, 0]
    );
  }

  b.sides = 16;

  for (const x of [-0.17, 0.17]) {
    const wingY = JET_WING_Y + (0.17 / 0.475) * JET_WING_RISE;
    b.use(NACELLE).tube(
      [
        [-0.135, 0.024, -0.07],
        [-0.13, 0.027, -0.07],
        [-0.08, 0.028, -0.07],
        [-0.02, 0.025, -0.068],
        [0.02, 0.016, -0.065],
      ],
      x
    );
    // Fan face, and the exhaust cone.
    b.use(DARK).tube(
      [
        [-0.1355, 0.021, -0.07],
        [-0.134, 0.021, -0.07],
      ],
      x
    );
    b.use(STRUT).tube(
      [
        [0.02, 0.01, -0.065],
        [0.04, 0.003, -0.065],
      ],
      x
    );
    // Pylon up to the wing.
    b.use(BODY).slab(
      [
        [x - 0.002, -0.046, -0.1],
        [x - 0.002, wingY - 0.002, -0.03],
        [x - 0.002, wingY - 0.002, 0.04],
        [x - 0.002, -0.046, 0.025],
      ],
      [0.004, 0, 0]
    );
  }

  b.use(BODY);
  sweptWings(b, 0.012, [0.36, 0.48], 0.17, [0.45, 0.5], [0.009, 0.005], 0.012);
  fin(b, 0.03, [0.28, 0.48], 0.17, [0.43, 0.5], 0.012);

  if (gear) {
    b.sides = 10;
    const ground = -RIDE_HEIGHT.jet;
    leg(b, ground, [0, -0.045, -0.4], 0.008, 0.006, 0.0025);

    for (const side of [-1, 1]) {
      const x = side * 0.075;
      const top = JET_WING_Y + (0.075 / 0.475) * JET_WING_RISE;
      leg(b, ground, [x, top, 0.05], 0.01, 0.007, 0.003);
    }
  }

  return b.build();
}

const PROP: Ring[] = [
  [-0.5, 0.008, -0.004],
  [-0.46, 0.035, 0],
  [-0.38, 0.05, 0],
  [0.2, 0.05, 0],
  [0.42, 0.022, 0.03],
  [0.5, 0.008, 0.04],
];

const PROP_DETAILED: Ring[] = [
  [-0.5, 0.008, -0.004],
  [-0.49, 0.022, -0.002],
  [-0.475, 0.033, 0],
  [-0.455, 0.042, 0],
  [-0.43, 0.048, 0],
  [-0.38, 0.05, 0],
  [0.2, 0.05, 0],
  [0.28, 0.042, 0.01],
  [0.36, 0.032, 0.02],
  [0.43, 0.02, 0.032],
  [0.5, 0.008, 0.04],
];

/** Turboprop or light aircraft: high straight wing, T-tail. */
export function createPropGeometry(detailed = false, { gear }: Detail = {}) {
  const b = new ModelBuilder();
  b.sides = detailed ? 16 : 8;
  b.use(BODY).tube(detailed ? PROP_DETAILED : PROP);

  if (detailed) {
    windscreen(b, PROP_DETAILED, -0.462, -0.44);
    cabinWindows(b, PROP_DETAILED, -0.34, 0.16, 0.03, 0.012, [6, 18]);
    b.use(WING);
    sweptWings(b, 0.045, [-0.13, 0.0], 0.55, [-0.1, -0.03], [0.018, 0.01]);
  } else {
    wings(b, 0.045, [-0.13, 0.0], 0.55, [-0.1, -0.03], 0.014);
  }

  for (const x of [-0.17, 0.17]) {
    b.use(detailed ? NACELLE : BODY).tube(
      detailed
        ? [
            [-0.25, 0.012, 0.025],
            [-0.245, 0.022, 0.027],
            [-0.22, 0.028, 0.03],
            [-0.1, 0.028, 0.032],
            [0.0, 0.022, 0.035],
            [0.06, 0.01, 0.035],
          ]
        : [
            [-0.25, 0.012, 0.025],
            [-0.22, 0.026, 0.03],
            [0.0, 0.022, 0.035],
          ],
      x
    );

    if (!detailed) continue;
    b.use(STRUT).tube(
      [
        [-0.29, 0.002, 0.025],
        [-0.275, 0.008, 0.025],
        [-0.252, 0.012, 0.025],
      ],
      x
    );
  }

  fin(b, 0.035, [0.28, 0.48], 0.19, [0.41, 0.5], 0.012);
  b.use(TAIL);
  wings(b, 0.22, [0.41, 0.5], 0.18, [0.45, 0.5], 0.008);

  if (detailed && gear) {
    b.sides = 10;
    const ground = -RIDE_HEIGHT.prop;
    leg(b, ground, [0, -0.045, -0.42], 0.012, 0.007, 0.003);

    for (const x of [-0.17, 0.17])
      leg(b, ground, [x, 0.01, -0.06], 0.012, 0.008, 0.004);
  }

  return b.build();
}

const HELICOPTER: Ring[] = [
  [-0.45, 0.02, -0.02],
  [-0.4, 0.09, 0],
  [-0.3, 0.12, 0.01],
  [0.0, 0.11, 0.02],
  [0.1, 0.04, 0.05],
  [0.46, 0.018, 0.06],
  [0.5, 0.01, 0.065],
];

const HELICOPTER_DETAILED: Ring[] = [
  [-0.45, 0.02, -0.02],
  [-0.435, 0.055, -0.012],
  [-0.4, 0.09, 0],
  [-0.35, 0.11, 0.006],
  [-0.3, 0.12, 0.01],
  [-0.15, 0.122, 0.015],
  [0.0, 0.11, 0.02],
  [0.06, 0.07, 0.035],
  [0.1, 0.04, 0.05],
  [0.3, 0.026, 0.056],
  [0.46, 0.018, 0.06],
  [0.5, 0.01, 0.065],
];

/** Helicopter: cabin pod, tail boom and fin; its rotors are apart. */
export function createHelicopterGeometry(detailed = false) {
  const b = new ModelBuilder();
  b.sides = detailed ? 16 : 8;
  b.use(BODY).tube(detailed ? HELICOPTER_DETAILED : HELICOPTER);
  fin(b, 0.04, [0.4, 0.5], 0.12, [0.45, 0.5], 0.012);

  if (!detailed) return b.build();

  // A bubble of glass in front, and windows down the cabin's sides.
  b.use(GLASS);

  for (const [a0, a1] of [
    [-40, 20],
    [20, 70],
    [70, 110],
    [110, 160],
    [160, 220],
  ]) {
    patch(b, HELICOPTER_DETAILED, -0.445, -0.33, a0, a1);
  }

  b.use(GLASS, WINDOW_GLOW);
  patch(b, HELICOPTER_DETAILED, -0.3, -0.13, -10, 40);
  patch(b, HELICOPTER_DETAILED, -0.3, -0.13, 140, 190);

  b.use(TAIL);
  wings(b, 0.06, [0.36, 0.4], 0.06, [0.37, 0.4], 0.006);

  // Mast up to the main rotor.
  b.use(STRUT).cylinder([0, 0.12, -0.15], [0, 0.158, -0.15], 0.012);

  // Skids, turned up in front, on cross tubes.
  b.sides = 8;
  b.use(STRUT);
  const skidY = -RIDE_HEIGHT.helicopter + 0.006;

  for (const side of [-1, 1]) {
    const x = side * 0.09;
    b.cylinder([x, skidY, -0.3], [x, skidY, 0.12], 0.006);
    b.cylinder([x, skidY, -0.3], [x, skidY + 0.03, -0.36], 0.006);

    for (const z of [-0.22, 0.05]) {
      b.cylinder([x, skidY, z], [side * 0.04, -0.09, z], 0.006);
    }
  }

  return b.build();
}

/** Which way a rotor's shaft runs, in the aircraft. */
export type Axis = "x" | "y" | "z";

/**
 * Blades that turn, built apart from the airframe: round the z axis at the
 * origin, then stood at each hub with their shaft along `axis`.
 */
export interface Rotor {
  hubs: Vec[];
  axis: Axis;
  blades: number;
  /** From `inner` out to `radius`, `width` either side of each blade's line. */
  inner: number;
  radius: number;
  width: number;
  /**
   * Turns a second at speed: anticlockwise looking back down the shaft from
   * its far end, clockwise if negative.
   */
  rate: number;
  /** Turns on the plain model too: big enough to see from afar. */
  far?: boolean;
}

/**
 * Each shape's rotors. Props turn clockwise seen from behind, near 1000 rpm;
 * the main rotor clockwise seen from above, as Airbus's do, near 390 rpm.
 */
export const ROTORS: Record<Shape, Rotor[]> = {
  jet: [],
  prop: [
    {
      hubs: [
        [-0.17, 0.025, -0.268],
        [0.17, 0.025, -0.268],
      ],
      axis: "z",
      blades: 4,
      inner: 0.008,
      radius: 0.078,
      width: 0.004,
      rate: -17,
    },
  ],
  helicopter: [
    {
      hubs: [[0, 0.155, -0.15]],
      axis: "y",
      blades: 4,
      inner: 0.02,
      radius: 0.45,
      width: 0.014,
      rate: -6.5,
      far: true,
    },
    {
      hubs: [[0.008, 0.13, 0.47]],
      axis: "x",
      blades: 2,
      inner: 0,
      radius: 0.08,
      width: 0.005,
      rate: 33,
    },
  ],
};

/** A rotor's blades, about its hub: plain ones are pale, to read from afar. */
export function createRotorGeometry(
  { blades: count, inner, radius, width }: Rotor,
  detailed = false
) {
  const b = new ModelBuilder().use(detailed ? BLADE : BODY);
  blades(b, [0, 0, 0], count, detailed ? inner : 0, radius, width);

  return b.build();
}
