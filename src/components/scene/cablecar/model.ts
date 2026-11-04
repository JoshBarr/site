import { ModelBuilder, Vec, WINDOW_GLOW } from "../models/builder";

// A cable car, in metres: x across, y up from the railhead (square to the
// rails), z along them, +z downhill toward Lambton Quay. The body's floor
// and roof run with the grade and its ends stand upright, a parallelogram
// from the side. Sizes are near enough, not from the cars' drawings.

export const CAR = { length: 10.5, width: 2.5 };

/**
 * The grade the ends are upright on: about 1 in 5, the line's average. Up
 * the body's height, they lean uphill (-z) this much per metre.
 */
const LEAN = 0.2;

/** The cars' red, as grey: the scene keeps its colour for data. */
const BODY = 0x515151;
const ROOF = 0x9a9a9a;
const GLASS = 0x1c2124;
const UNDERFRAME = 0x2b2b2b;
const WHEEL = 0x262626;

const HALF = CAR.width / 2;
const END = CAR.length / 2;

/** (x, y) at the end `z` (its middle, at the railhead), leaned upright. */
const upright = ([x, y]: [number, number], z: number): Vec => [
  x,
  y,
  z - y * LEAN,
];

/** An outline across the car run from end to end, its ends upright. */
function body(b: ModelBuilder, outline: [number, number][], end = END) {
  b.loft([-end, end].map((z) => outline.map((p) => upright(p, z))));
}

/** A band of the body from `y0` to `y1`, `inset` in from its sides. */
const band = (y0: number, y1: number, inset = 0): [number, number][] => [
  [-HALF + inset, y0],
  [HALF - inset, y0],
  [HALF - inset, y1],
  [-HALF + inset, y1],
];

export function createCableCarGeometry() {
  const b = new ModelBuilder();
  b.sides = 10;

  // Running gear: an axle box and wheels at each end, under the frame.
  for (const z of [-END + 1.6, END - 1.6]) {
    b.use(UNDERFRAME).box([-0.6, 0.25, z - 0.7], [0.6, 0.7, z + 0.7]);
    b.use(WHEEL);

    for (const side of [-1, 1]) {
      b.cylinder([side * 0.45, 0.35, z], [side * 0.58, 0.35, z], 0.35);
    }
  }

  b.use(UNDERFRAME);
  body(b, band(0.6, 0.9, 0.12), END - 0.2);

  b.use(BODY);
  body(b, band(0.9, 1.75));

  // Windows all round, and the pillars between them on the sides.
  b.use(GLASS, WINDOW_GLOW);
  body(b, band(1.75, 2.7, 0.02));
  b.use(BODY);

  for (let z = -END; z <= END + 0.01; z += CAR.length / 7) {
    const w = 0.09;

    for (const side of [-1, 1]) {
      const x = side * HALF;

      b.slab(
        [
          upright([x, 1.75], z - w),
          upright([x, 1.75], z + w),
          upright([x, 2.7], z + w),
          upright([x, 2.7], z - w),
        ],
        [-side * 0.06, 0, 0]
      );
    }
  }

  body(b, band(2.7, 3.0));

  // A shallow roof, chamfered at the eaves.
  b.use(ROOF);
  body(b, [
    [-HALF, 3.0],
    [HALF, 3.0],
    [HALF - 0.25, 3.25],
    [-HALF + 0.25, 3.25],
  ]);

  return b.build();
}
