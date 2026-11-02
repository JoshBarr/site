import { ModelBuilder, Vec, WINDOW_GLOW } from "../models/builder";

// A detailed bus, for the few close enough to see: a low-floor single-decker
// in metres, x across (+x the kerb side, where the doors are, driving on the
// left), y up from the road, z along, the front toward +z.

export interface BusSize {
  length: number;
  width: number;
  height: number;
  tint: number;
}

const GLASS = 0x1c2124;
const DARK = 0x2e2e2e;
const TYRE = 0x1e1e1e;
const ROOF_KIT = 0xa8a8a8;

/** Destination signs: amber, lit with the windows. */
const SIGN_GLOW = 0xffa531;

const WHEEL_RADIUS = 0.5;
const FLOOR = 0.32;

export function createBusGeometry({
  length: L,
  width,
  height: H,
  tint,
}: BusSize) {
  const b = new ModelBuilder();
  b.sides = 12;
  const half = width / 2;

  const section: [number, number][] = [
    [-half + 0.03, FLOOR],
    [half - 0.03, FLOOR],
    [half, FLOOR + 0.13],
    [half, H - 0.3],
    [half - 0.07, H - 0.1],
    [half - 0.25, H],
    [-half + 0.25, H],
    [-half + 0.07, H - 0.1],
    [-half, H - 0.3],
    [-half, FLOOR + 0.13],
  ];

  const at = (z: number, shrink = 1) =>
    section.map(([x, y]): Vec => [x * shrink, FLOOR + (y - FLOOR) * shrink, z]);

  // Rounded off at both ends.
  b.use(tint).loft([
    at(-L / 2, 0.95),
    at(-L / 2 + 0.25),
    at(L / 2 - 0.3),
    at(L / 2, 0.94),
  ]);

  const front = L / 2 + 0.01;
  const rear = -L / 2 - 0.01;
  const inside: Vec = [0, H / 2, 0];

  const pane = (x0: number, x1: number, y0: number, y1: number, z: number) =>
    b.quad(inside, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);

  // Windscreen and destination sign; the back window and engine grille.
  b.use(GLASS, WINDOW_GLOW);
  pane(-half * 0.88, half * 0.88, 1.0, H - 0.5, front);
  pane(-half * 0.7, half * 0.7, 2.0, H - 0.45, rear);
  b.use(0x141414, SIGN_GLOW);
  pane(-half * 0.7, half * 0.7, H - 0.43, H - 0.18, front);
  b.use(DARK);
  b.box([-half * 0.95, FLOOR, L / 2 - 0.1], [half * 0.95, 0.62, L / 2 + 0.06]);
  pane(-half * 0.7, half * 0.7, 0.7, 1.4, rear);

  // Side windows, the doors on the kerb side, and the driver's.
  const frontWheel = L / 2 - 2.75;
  const rearWheel = -L / 2 + 3.4;

  const doors: [number, number][] = [
    [L / 2 - 2.15, L / 2 - 0.95],
    [rearWheel + 0.9, rearWheel + 2.2],
  ];

  b.use(GLASS, WINDOW_GLOW);

  for (const sign of [-1, 1]) {
    const x = sign * (half + 0.015);

    const side = (z0: number, z1: number, y0: number, y1: number) =>
      b.quad(inside, [x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]);

    for (let z = -L / 2 + 0.6; z + 1.35 <= L / 2 - 0.7; z += 1.5) {
      const z1 = z + 1.35;

      if (sign > 0 && doors.some(([a, c]) => z1 > a - 0.1 && z < c + 0.1)) {
        continue;
      }

      side(z, z1, 1.25, H - 0.45);
    }

    if (sign > 0) {
      for (const [a, c] of doors) {
        side(a, (a + c) / 2 - 0.03, FLOOR + 0.1, H - 0.45);
        side((a + c) / 2 + 0.03, c, FLOOR + 0.1, H - 0.45);
      }
    }
  }

  // Wheels, dual at the back.
  b.use(TYRE);

  for (const [z, inner] of [
    [frontWheel, half - 0.28],
    [rearWheel, half - 0.5],
  ]) {
    for (const sign of [-1, 1]) {
      b.cylinder(
        [sign * inner, WHEEL_RADIUS, z],
        [sign * (half + 0.01), WHEEL_RADIUS, z],
        WHEEL_RADIUS
      );
    }
  }

  // Air conditioning on the roof, and mirrors.
  b.use(ROOF_KIT).prism(
    [
      [-0.85, H - 0.02],
      [0.85, H - 0.02],
      [0.75, H + 0.25],
      [-0.75, H + 0.25],
    ],
    -1.8,
    2.2
  );
  b.use(DARK);

  for (const sign of [-1, 1]) {
    const x = sign * half;
    b.box(
      [Math.min(x, x + sign * 0.25), 2.3, L / 2 - 0.2],
      [Math.max(x, x + sign * 0.25), 2.75, L / 2 - 0.1]
    );
  }

  return b.build();
}
