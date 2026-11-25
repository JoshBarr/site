import { loft, type Ring, type Vec } from "./loft";
import type { Form } from "./model";

// A rock pigeon, the town's, a wingspan of 1 across x, facing +z: a small
// head on a deep breast, pointed wings swept back from the wrist, and a
// square tail; grey, its head and neck darker, two black bars across each
// wing, a white rump, a dark band at the end of its tail, and pale under
// the wing. In greys, like the rest of the scene. Shaped by eye; about
// 32 cm long and 66 cm across the wings.

/** eBird's name for it, without the "(Feral Pigeon)" a flock's name drops. */
const SPECIES = "Rock Pigeon";

/** Drawn at once at most: beyond these, they're drawn as other birds. */
export const ROCK_PIGEON_MOST = 256;

/** The rock pigeon's wingspan, m: a kererū's is wider. */
export const ROCK_PIGEON_SPAN = 0.66;

/** Out from the middle to where the wings hinge, of the span. */
const SHOULDER = 0.07;

// Its greys, 0 black to 1 white.
const BILL = 0.05;
const HEAD = 0.13;
const NECK = 0.1;
const BREAST = 0.2;
const BACK = 0.34;
const BELLY = 0.3;
const RUMP = 0.85;
const WING = 0.42;
const BAR = 0.05;
const TRAIL = 0.3;
const LINING = 0.7;
const TAIL = 0.24;
const TAIL_BAND = 0.06;

const all = (tone: number): [number, number, number] => [tone, tone, tone];

const RINGS: Ring[] = [
  { z: 0.256, y: 0.012, wide: 0, up: 0, down: 0, coat: all(BILL) },
  { z: 0.24, y: 0.014, wide: 0.006, up: 0.005, down: 0.005, coat: all(BILL) },
  { z: 0.224, y: 0.016, wide: 0.012, up: 0.013, down: 0.011, coat: all(HEAD) },
  { z: 0.206, y: 0.018, wide: 0.026, up: 0.027, down: 0.024, coat: all(HEAD) },
  { z: 0.178, y: 0.016, wide: 0.03, up: 0.03, down: 0.028, coat: all(NECK) },
  {
    z: 0.15,
    y: 0.008,
    wide: 0.038,
    up: 0.034,
    down: 0.042,
    coat: [NECK, NECK, BREAST],
  },
  {
    z: 0.1,
    y: 0.002,
    wide: 0.064,
    up: 0.05,
    down: 0.068,
    coat: [BACK, BACK, BREAST],
  },
  {
    z: 0.03,
    y: 0,
    wide: 0.076,
    up: 0.056,
    down: 0.078,
    coat: [BACK, BACK, BELLY],
  },
  {
    z: -0.04,
    y: 0,
    wide: 0.07,
    up: 0.05,
    down: 0.066,
    // The white rump.
    coat: [RUMP, BACK, BELLY],
  },
  {
    z: -0.1,
    y: 0.004,
    wide: 0.05,
    up: 0.034,
    down: 0.044,
    coat: [TAIL, TAIL, BELLY],
  },
  { z: -0.14, y: 0.01, wide: 0.03, up: 0.018, down: 0.02, coat: all(TAIL) },
  { z: -0.155, y: 0.012, wide: 0, up: 0, down: 0 },
];

/** A wing's stations, shoulder to tip: how far out, and how high. */
const OUT = [SHOULDER, 0.16, 0.25, 0.37, 0.46];
const HIGH = [0.028, 0.03, 0.028, 0.022, 0.018];

/**
 * Its lines, leading edge to trailing, by how far forward each is at each
 * station: between them the coverts, a bar, the secondaries, the other
 * bar, and the trailing edge. The wrist's the third station.
 */
const LINES: Vec[][] = [
  [0.12, 0.14, 0.135, 0.085, 0.03],
  [0.04, 0.05, 0.045, 0.02, -0.005],
  [0.015, 0.022, 0.018, 0, -0.015],
  [-0.01, -0.006, -0.01, -0.02, -0.027],
  [-0.035, -0.034, -0.038, -0.042, -0.04],
  [-0.06, -0.068, -0.072, -0.065, -0.05],
].map((forward) => forward.map((z, i): Vec => [OUT[i], HIGH[i], z]));

const TAIL_Y = 0.008;

/** Whether a flock of `species` (eBird's English name) is rock pigeons. */
export const isRockPigeon = (species: string) => species === SPECIES;

/** The rock pigeon's shape, for createFlight. */
export function rockPigeonForm(): Form {
  return loft({
    shoulder: SHOULDER,
    rings: RINGS,
    wing: {
      lines: LINES,
      tip: [0.5, 0.016, -0.03],
      wrist: 2,
      // The bars cross the wing in to the wrist; the hand darkens to its tip.
      above: [
        { arm: WING, hand: 0.36 },
        { arm: BAR, hand: 0.22 },
        { arm: WING, hand: 0.17 },
        { arm: BAR, hand: 0.13 },
        { arm: TRAIL, hand: 0.1 },
      ],
      below: [
        { arm: LINING, hand: LINING },
        { arm: LINING, hand: 0.45 },
        { arm: 0.5, hand: 0.3 },
        { arm: 0.4, hand: 0.24 },
        { arm: 0.3, hand: 0.18 },
      ],
    },
    tail: {
      root: [0, 0.012, -0.12],
      end: [
        [0.03, 0.012, -0.12],
        [0.068, TAIL_Y, -0.205],
        [0.05, TAIL_Y, -0.23],
        [0, TAIL_Y, -0.236],
        [-0.05, TAIL_Y, -0.23],
        [-0.068, TAIL_Y, -0.205],
        [-0.03, 0.012, -0.12],
      ],
      band: 0.72,
      above: TAIL,
      under: TAIL,
      tip: TAIL_BAND,
      edge: TAIL_BAND,
    },
  });
}
