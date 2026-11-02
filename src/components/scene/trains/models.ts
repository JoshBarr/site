import { ModelBuilder, Vec, WINDOW_GLOW } from "../models/builder";

// Detailed cars, for the few close enough to see: in metres, x across, y up
// from the railhead, z along, the front toward +z. Built to each car's own
// size; the shapes are near enough, not from the stock's drawings.

export interface CarSize {
  length: number;
  width: number;
  height: number;
  tint: number;
}

const GLASS = 0x1c2124;
const UNDERFRAME = 0x2e2e2e;
const BOGIE = 0x3a3a3a;
const WHEEL = 0x262626;
const ROOF_KIT = 0x8a8a8a;
const GANGWAY = 0x2a2a2a;

/** Wheel radius, m. */
const WHEEL_RADIUS = 0.43;

/** Half the gauge, to the wheels' faces: 3 ft 6 in. */
const HALF_GAUGE = 0.53;

/**
 * A car's body in section, x and y, from its floor to its roof: slab sided
 * with a rounded roof.
 */
function section(half: number, floor: number, top: number): [number, number][] {
  const eaves = top - 0.85;

  return [
    [-half + 0.05, floor],
    [half - 0.05, floor],
    [half, floor + 0.25],
    [half, eaves],
    [half - 0.07, eaves + 0.4],
    [half - 0.32, top - 0.13],
    [half * 0.45, top],
    [-half * 0.45, top],
    [-half + 0.32, top - 0.13],
    [-half + 0.07, eaves + 0.4],
    [-half, eaves],
    [-half, floor + 0.25],
  ];
}

/** The same in z, `shrink` narrower and lower about its floor's middle. */
function at(
  outline: [number, number][],
  z: number,
  shrink = 1,
  floor = 0
): Vec[] {
  return outline.map(([x, y]): Vec => [
    x * shrink,
    floor + (y - floor) * shrink,
    z,
  ]);
}

/** A bogie under the car at `z`, with `axles` wheelsets. */
function bogie(b: ModelBuilder, z: number, axles: number, half: number) {
  const spacing = 2.1;
  const reach = ((axles - 1) * spacing) / 2;
  b.use(BOGIE).box(
    [-half, 0.3, z - reach - 0.6],
    [half, 0.85, z + reach + 0.6]
  );
  b.use(WHEEL);

  for (let i = 0; i < axles; i++) {
    const w = z - reach + i * spacing;

    for (const sign of [-1, 1]) {
      b.cylinder(
        [sign * (HALF_GAUGE - 0.05), WHEEL_RADIUS, w],
        [sign * (HALF_GAUGE + 0.08), WHEEL_RADIUS, w],
        WHEEL_RADIUS
      );
    }
  }
}

/** Panes along a car's sides, between `from` and `to`, skipping `gaps`. */
function sideWindows(
  b: ModelBuilder,
  half: number,
  [y0, y1]: [number, number],
  from: number,
  to: number,
  pitch: number,
  gaps: [number, number][] = []
) {
  b.use(GLASS, WINDOW_GLOW);
  const width = pitch - 0.2;

  for (let z = from; z + width <= to; z += pitch) {
    if (gaps.some(([a, c]) => z + width > a && z < c)) continue;

    for (const sign of [-1, 1]) {
      const x = sign * (half + 0.02);
      b.quad(
        [0, (y0 + y1) / 2, z],
        [x, y0, z],
        [x, y0, z + width],
        [x, y1, z + width],
        [x, y1, z]
      );
    }
  }
}

/** Doors on both sides, centred at each z: glazed, plug-fitting. */
function doors(
  b: ModelBuilder,
  half: number,
  centres: number[],
  width: number,
  [floor, top]: [number, number],
  color: number
) {
  for (const z of centres) {
    for (const sign of [-1, 1]) {
      const x = sign * half;
      b.use(color).box(
        [Math.min(x, x + sign * 0.03), floor, z - width / 2],
        [Math.max(x, x + sign * 0.03), top, z + width / 2]
      );
      b.use(GLASS, WINDOW_GLOW);
      const glass = sign * (half + 0.035);

      for (const [a, c] of [
        [z - width / 2 + 0.12, z - 0.06],
        [z + 0.06, z + width / 2 - 0.12],
      ]) {
        b.quad(
          [0, top - 0.8, z],
          [glass, top - 1.2, a],
          [glass, top - 1.2, c],
          [glass, top - 0.2, c],
          [glass, top - 0.2, a]
        );
      }
    }
  }
}

/**
 * A Matangi car: a cab at the front (+z), a gangway at the back. The FP
 * car of each pair has the pantograph.
 */
export function createMatangiGeometry(car: CarSize, pantograph: boolean) {
  const b = new ModelBuilder();
  b.sides = 10;
  const { length: L, width: W, height: H } = car;
  const half = W / 2;
  const floor = 1.0;
  const body = section(half, floor, H);
  const nose = 1.1;

  b.use(car.tint).loft([
    at(body, -L / 2),
    at(body, L / 2 - nose),
    at(body, L / 2 - 0.35, 0.97, floor),
    at(body, L / 2, 0.9, floor),
  ]);

  // The cab's face, mostly glass, and its side windows.
  const face = L / 2 + 0.02;
  b.use(0x1a1d20).box(
    [-half * 0.82, 1.55, face - 0.03],
    [half * 0.82, 3.25, face]
  );
  b.use(GLASS).box([-half * 0.72, 2.15, face], [half * 0.72, 3.1, face + 0.02]);
  b.use(GLASS);

  for (const sign of [-1, 1]) {
    const x = sign * (half + 0.02);
    const [z0, z1] = [L / 2 - 2.2, L / 2 - 1.3];
    b.quad(
      [0, 2.5, L / 2 - 1.7],
      [x, 2.0, z0],
      [x, 2.0, z1],
      [x, 2.9, z1],
      [x, 2.9, z0]
    );
  }

  // Coupler and skirt.
  b.use(UNDERFRAME).box([-0.9, 0.55, L / 2 - 0.4], [0.9, 1.05, L / 2 + 0.15]);

  const doorsAt = [-L / 4, L / 4 - 0.8];
  const doorWidth = 1.5;
  sideWindows(
    b,
    half,
    [1.9, 2.85],
    -L / 2 + 0.9,
    L / 2 - 2.6,
    1.7,
    doorsAt.map((z): [number, number] => [
      z - doorWidth / 2 - 0.15,
      z + doorWidth / 2 + 0.15,
    ])
  );
  doors(b, half, doorsAt, doorWidth, [1.05, 3.0], 0xa8a8a8);

  b.use(GANGWAY).box([-0.55, 1.05, -L / 2 - 0.35], [0.55, 3.05, -L / 2]);
  b.use(UNDERFRAME).box(
    [-half + 0.15, 0.6, -L / 2 + 3.9],
    [half - 0.15, floor, L / 2 - 3.9]
  );

  for (const z of [-L / 2 + 2.9, L / 2 - 2.9]) bogie(b, z, 2, 1.05);

  // Roof: air conditioning, and on the FP car the pantograph.
  b.use(ROOF_KIT);
  b.box([-0.75, H - 0.05, -L / 2 + 2.5], [0.75, H + 0.3, -L / 2 + 5.5]);
  b.box([-0.75, H - 0.05, L / 2 - 6], [0.75, H + 0.3, L / 2 - 3]);

  if (pantograph) {
    const z = -L / 2 + 7.5;
    b.use(0x5a5a5a).box([-0.5, H - 0.02, z - 0.7], [0.5, H + 0.15, z + 0.7]);
    b.sides = 6;
    const knee: Vec = [0, H + 0.75, z - 1.2];
    const head: Vec = [0, H + 1.3, z - 0.1];
    b.cylinder([0, H + 0.15, z + 0.5], knee, 0.04);
    b.cylinder(knee, head, 0.035);
    b.cylinder([-0.85, head[1], head[2]], [0.85, head[1], head[2]], 0.04);
  }

  return b.build();
}

/** One of the Wairarapa Connection's carriages: gangways both ends. */
export function createCarriageGeometry(car: CarSize) {
  const b = new ModelBuilder();
  b.sides = 10;
  const { length: L, width: W, height: H } = car;
  const half = W / 2;
  const floor = 1.05;
  const body = section(half, floor, H);
  b.use(car.tint).loft([at(body, -L / 2), at(body, L / 2)]);

  const doorsAt = [-L / 2 + 1.3, L / 2 - 1.3];
  sideWindows(b, half, [1.85, 2.75], -L / 2 + 2.3, L / 2 - 2.3, 2.1);
  doors(b, half, doorsAt, 0.9, [1.1, 2.95], 0x6e6e6e);

  b.use(GANGWAY);

  for (const sign of [-1, 1]) {
    const z = (sign * L) / 2;
    b.box(
      [-0.55, 1.1, Math.min(z, z + sign * 0.3)],
      [0.55, 3.0, Math.max(z, z + sign * 0.3)]
    );
  }

  b.use(UNDERFRAME).box(
    [-half + 0.2, 0.6, -L / 2 + 4],
    [half - 0.2, floor, L / 2 - 4]
  );

  for (const z of [-L / 2 + 3.2, L / 2 - 3.2]) bogie(b, z, 2, 1.05);

  return b.build();
}

/**
 * A diesel-electric hood unit: cab near the front, long hood behind, on
 * three-axle bogies.
 */
export function createLocomotiveGeometry(car: CarSize) {
  const b = new ModelBuilder();
  b.sides = 10;
  const { length: L, width: W, height: H } = car;
  const half = W / 2;
  const deck = 1.45;

  // The frame and its walkways, with the fuel tank slung below.
  b.use(car.tint).box([-half, 1.1, -L / 2 + 0.2], [half, deck, L / 2 - 0.2]);
  b.use(UNDERFRAME).box([-1, 0.45, -2.2], [1, 1.1, 2.2]);

  const hood: [number, number][] = [
    [-0.85, deck],
    [0.85, deck],
    [0.85, 3.15],
    [0.62, 3.38],
    [-0.62, 3.38],
    [-0.85, 3.15],
  ];

  const cabFront = L / 2 - 2.2;
  const cabBack = cabFront - 2.1;
  b.use(car.tint);
  b.prism(hood, -L / 2 + 0.6, cabBack);
  b.prism(
    [
      [-half + 0.1, deck],
      [half - 0.1, deck],
      [half - 0.1, H - 0.3],
      [half - 0.4, H],
      [-half + 0.4, H],
      [-half + 0.1, H - 0.3],
    ],
    cabBack,
    cabFront
  );
  b.prism(
    hood.map(([x, y]): [number, number] => [x, Math.min(y, 2.75)]),
    cabFront,
    L / 2 - 0.6
  );

  b.use(GLASS);
  b.box([-1.05, 2.55, cabFront], [1.05, 3.4, cabFront + 0.03]);

  for (const sign of [-1, 1]) {
    const x = sign * (half - 0.08);
    b.quad(
      [0, 3, cabFront - 1],
      [x, 2.55, cabBack + 0.3],
      [x, 2.55, cabFront - 0.3],
      [x, 3.35, cabFront - 0.3],
      [x, 3.35, cabBack + 0.3]
    );
  }

  // Exhaust on the hood, and handrails along the walkways.
  b.use(UNDERFRAME).box([-0.3, 3.3, -L / 2 + 5], [0.3, 3.6, -L / 2 + 6]);
  b.sides = 5;
  b.use(0xb0b0b0);

  for (const sign of [-1, 1]) {
    const x = sign * (half - 0.05);
    b.cylinder(
      [x, deck + 0.95, -L / 2 + 0.6],
      [x, deck + 0.95, cabBack],
      0.025
    );
    b.cylinder(
      [x, deck + 0.95, cabFront],
      [x, deck + 0.95, L / 2 - 0.4],
      0.025
    );
  }

  b.sides = 10;

  for (const z of [-L / 2 + 3.3, L / 2 - 3.3]) bogie(b, z, 3, 1.1);

  return b.build();
}
