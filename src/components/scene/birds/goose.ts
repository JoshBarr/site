import { loft, type Ring, type Vec } from "./loft";
import type { Form } from "./model";

// A Canada goose, a wingspan of 1 across x, facing +z: a heavy body behind
// a long neck held straight out, long broad wings and a short tail; its
// head and neck black with the white strap under the chin, its breast
// pale, and a white band across the root of its black tail. In greys, like
// the rest of the scene. Shaped by eye; about 95 cm long and 1.65 m across
// the wings, as the big ones here are.

/** eBird's name for it. */
const SPECIES = "Canada Goose";

/** Geese drawn at once at most: beyond these, they're drawn as other birds. */
export const GOOSE_MOST = 256;

/** The goose's wingspan, m. */
export const GOOSE_SPAN = 1.65;

/**
 * Its wingbeats a second: a guess, slower than a duck's five as its wings
 * are longer.
 */
export const GOOSE_BEAT = 3.5;

/** Out from the middle to where the wings hinge, of the span. */
const SHOULDER = 0.06;

// Its greys, 0 black to 1 white.
const BLACK = 0.03;
const WHITE = 0.85;
const BREAST = 0.5;
const BACK = 0.12;
const FLANK = 0.22;
const BELLY = 0.42;
const COVERTS = 0.13;
const FLIGHT = 0.045;
const HAND = 0.1;
const PRIMARIES = 0.035;
const LINING = 0.2;
const UNDER_FLIGHT = 0.1;

const all = (tone: number): [number, number, number] => [tone, tone, tone];

const RINGS: Ring[] = [
  { z: 0.345, y: 0.002, wide: 0, up: 0, down: 0, coat: all(BLACK) },
  { z: 0.328, y: 0.004, wide: 0.007, up: 0.006, down: 0.005, coat: all(BLACK) },
  { z: 0.303, y: 0.008, wide: 0.011, up: 0.012, down: 0.008, coat: all(BLACK) },
  { z: 0.288, y: 0.01, wide: 0.017, up: 0.02, down: 0.016, coat: all(BLACK) },
  // The strap: white under the chin and up the cheeks.
  {
    z: 0.274,
    y: 0.01,
    wide: 0.018,
    up: 0.02,
    down: 0.017,
    coat: [BLACK, WHITE, WHITE],
  },
  { z: 0.256, y: 0.008, wide: 0.016, up: 0.016, down: 0.016, coat: all(BLACK) },
  { z: 0.17, y: 0.004, wide: 0.016, up: 0.016, down: 0.017, coat: all(BLACK) },
  // Where the black neck ends, sharply, at the breast.
  {
    z: 0.142,
    y: 0.002,
    wide: 0.028,
    up: 0.026,
    down: 0.03,
    coat: [BACK, BREAST, BREAST],
  },
  {
    z: 0.095,
    y: 0,
    wide: 0.054,
    up: 0.044,
    down: 0.058,
    coat: [BACK, BACK, [FLANK, BREAST]],
  },
  {
    z: 0.02,
    y: 0,
    wide: 0.068,
    up: 0.052,
    down: 0.07,
    coat: [BACK, BACK, [FLANK, BELLY]],
  },
  {
    z: -0.05,
    y: 0,
    wide: 0.066,
    up: 0.048,
    down: 0.066,
    coat: [BACK, BACK, [FLANK, WHITE]],
  },
  {
    z: -0.11,
    y: 0.004,
    wide: 0.05,
    up: 0.034,
    down: 0.048,
    coat: [BLACK, BLACK, WHITE],
  },
  // The white band across the root of the tail.
  { z: -0.155, y: 0.01, wide: 0.032, up: 0.02, down: 0.026, coat: all(WHITE) },
  { z: -0.182, y: 0.012, wide: 0.018, up: 0.01, down: 0.012, coat: all(BLACK) },
  { z: -0.195, y: 0.012, wide: 0, up: 0, down: 0 },
];

/** A wing's lines, shoulder to tip: the wrist's the third of each. */
const LEADING: Vec[] = [
  [SHOULDER, 0.03, 0.12],
  [0.16, 0.034, 0.135],
  [0.27, 0.032, 0.13],
  [0.39, 0.024, 0.09],
  [0.47, 0.018, 0.035],
];

const COVERT_LINE: Vec[] = [
  [SHOULDER, 0.032, 0.05],
  [0.16, 0.036, 0.06],
  [0.27, 0.034, 0.058],
  [0.39, 0.026, 0.035],
  [0.465, 0.019, -0.005],
];

const TRAILING: Vec[] = [
  [SHOULDER, 0.028, -0.06],
  [0.16, 0.028, -0.07],
  [0.26, 0.026, -0.075],
  [0.37, 0.022, -0.075],
  [0.455, 0.018, -0.055],
];

const TAIL_Y = 0.01;

/** Whether a flock of `species` (eBird's English name) is Canada geese. */
export const isGoose = (species: string) => species === SPECIES;

/** The goose's shape, for createFlight. */
export function gooseForm(): Form {
  return loft({
    shoulder: SHOULDER,
    rings: RINGS,
    wing: {
      lines: [LEADING, COVERT_LINE, TRAILING],
      tip: [0.5, 0.016, -0.02],
      wrist: 2,
      above: [
        { arm: COVERTS, hand: HAND },
        { arm: FLIGHT, hand: PRIMARIES },
      ],
      below: [
        { arm: LINING, hand: LINING },
        { arm: UNDER_FLIGHT, hand: UNDER_FLIGHT },
      ],
    },
    tail: {
      root: [0, 0.012, -0.17],
      end: [
        [0.022, 0.012, -0.17],
        [0.042, TAIL_Y, -0.22],
        [0.022, TAIL_Y, -0.236],
        [0, TAIL_Y, -0.24],
        [-0.022, TAIL_Y, -0.236],
        [-0.042, TAIL_Y, -0.22],
        [-0.022, 0.012, -0.17],
      ],
      band: 0.55,
      above: BLACK,
      // White under its root, the black tail beyond.
      under: WHITE,
      tip: BLACK,
    },
  });
}
