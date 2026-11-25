import { loft, type Ring, type Vec } from "./loft";
import type { Form } from "./model";

// A tākapu, the Australasian gannet, a wingspan of 1 across x, facing +z:
// a cigar of a body, pointed at both ends, between long narrow pointed
// wings; white, its head buff, the wings' trailing edges and tips black,
// and the middle of its tail. In greys, like the rest of the scene. Shaped
// by eye; about 89 cm long and 1.8 m across the wings.

/** eBird's name for it. */
const SPECIES = "Australasian Gannet";

/** Tākapu drawn at once at most: beyond these, they're drawn as other birds. */
export const GANNET_MOST = 128;

/** Out from the middle to where the wings hinge, of the span. */
const SHOULDER = 0.045;

// Its greys, 0 black to 1 white.
const WHITE = 0.9;
const BUFF = 0.55;
const BILL = 0.5;
const BLACK = 0.04;
const LINING = 0.8;
const UNDER_BLACK = 0.07;

const all = (tone: number): [number, number, number] => [tone, tone, tone];

const RINGS: Ring[] = [
  { z: 0.275, y: 0.004, wide: 0, up: 0, down: 0, coat: all(BILL) },
  { z: 0.25, y: 0.006, wide: 0.006, up: 0.006, down: 0.005, coat: all(BILL) },
  { z: 0.215, y: 0.008, wide: 0.012, up: 0.013, down: 0.01, coat: all(BUFF) },
  {
    z: 0.196,
    y: 0.01,
    wide: 0.02,
    up: 0.022,
    down: 0.018,
    coat: [BUFF, BUFF, WHITE],
  },
  {
    z: 0.168,
    y: 0.008,
    wide: 0.023,
    up: 0.024,
    down: 0.022,
    coat: [BUFF, WHITE, WHITE],
  },
  { z: 0.14, y: 0.006, wide: 0.026, up: 0.027, down: 0.028, coat: all(WHITE) },
  { z: 0.09, y: 0.002, wide: 0.04, up: 0.038, down: 0.045, coat: all(WHITE) },
  { z: 0.02, y: 0, wide: 0.046, up: 0.042, down: 0.052, coat: all(WHITE) },
  { z: -0.05, y: 0, wide: 0.042, up: 0.036, down: 0.046, coat: all(WHITE) },
  { z: -0.11, y: 0.004, wide: 0.03, up: 0.024, down: 0.03, coat: all(WHITE) },
  { z: -0.15, y: 0.008, wide: 0.016, up: 0.012, down: 0.014, coat: all(WHITE) },
  { z: -0.165, y: 0.01, wide: 0, up: 0, down: 0 },
];

/** A wing's lines, shoulder to tip: the wrist's the third of each. */
const LEADING: Vec[] = [
  [SHOULDER, 0.022, 0.085],
  [0.15, 0.026, 0.1],
  [0.26, 0.024, 0.1],
  [0.38, 0.018, 0.06],
  [0.46, 0.014, 0.015],
];

const COVERT_LINE: Vec[] = [
  [SHOULDER, 0.024, 0.04],
  [0.15, 0.028, 0.05],
  [0.26, 0.026, 0.05],
  [0.38, 0.02, 0.02],
  [0.46, 0.015, -0.012],
];

const TRAILING: Vec[] = [
  [SHOULDER, 0.02, -0.03],
  [0.15, 0.02, -0.035],
  [0.255, 0.019, -0.035],
  [0.37, 0.017, -0.035],
  [0.455, 0.014, -0.035],
];

const TAIL_Y = 0.008;

/** Whether a flock of `species` (eBird's English name) is tākapu. */
export const isGannet = (species: string) => species === SPECIES;

/** The tākapu's shape, for createFlight. */
export function gannetForm(): Form {
  return loft({
    shoulder: SHOULDER,
    rings: RINGS,
    wing: {
      lines: [LEADING, COVERT_LINE, TRAILING],
      tip: [0.5, 0.012, -0.035],
      wrist: 2,
      // White in front as far as the wrist; the flight feathers black,
      // and the hand with them.
      above: [
        { arm: WHITE, hand: [WHITE, BLACK] },
        { arm: BLACK, hand: BLACK },
      ],
      below: [
        { arm: LINING, hand: [LINING, UNDER_BLACK] },
        { arm: UNDER_BLACK, hand: UNDER_BLACK },
      ],
    },
    tail: {
      root: [0, 0.01, -0.14],
      end: [
        [0.014, 0.01, -0.14],
        [0.032, TAIL_Y, -0.195],
        [0.014, TAIL_Y, -0.222],
        [0, TAIL_Y, -0.23],
        [-0.014, TAIL_Y, -0.222],
        [-0.032, TAIL_Y, -0.195],
        [-0.014, 0.01, -0.14],
      ],
      band: 0.6,
      // Its middle feathers black, the outer white.
      above: [WHITE, WHITE, BLACK, BLACK, WHITE, WHITE],
      under: [LINING, LINING, UNDER_BLACK, UNDER_BLACK, LINING, LINING],
      tip: [LINING, LINING, UNDER_BLACK, UNDER_BLACK, LINING, LINING],
    },
  });
}
