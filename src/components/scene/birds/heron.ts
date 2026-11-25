import { loft, type Ring, type Vec } from "./loft";
import type { Form } from "./model";

// A matuku moana, the white-faced heron, a wingspan of 1 across x, facing
// +z, as it flies: its neck drawn back in a bulge under a long bill, broad
// arched wings, a short tail and its long legs trailing out behind;
// blue-grey, its face white and its flight feathers dark. In greys, like
// the rest of the scene. Shaped by eye; about 67 cm long and 1.06 m across
// the wings.

/** eBird's name for it. */
const SPECIES = "White-faced Heron";

/** Herons drawn at once at most: beyond these, they're drawn as other birds. */
export const HERON_MOST = 64;

/** The heron's wingspan, m. */
export const HERON_SPAN = 1.06;

/**
 * Its wingbeats a second: a guess, slow and deep as a heron's are, where
 * the waders it's counted with beat six.
 */
export const HERON_BEAT = 2.8;

/** Out from the middle to where the wings hinge, of the span. */
const SHOULDER = 0.05;

// Its greys, 0 black to 1 white.
const BILL = 0.06;
const WHITE = 0.85;
const GREY = 0.3;
const NECK = 0.26;
const BELLY = 0.38;
const COVERTS = 0.3;
const FLIGHT = 0.1;
const HAND = 0.2;
const PRIMARIES = 0.08;
const LINING = 0.4;
const UNDER_FLIGHT = 0.15;
const TAIL = 0.12;
const LEGS = 0.4;

const all = (tone: number): [number, number, number] => [tone, tone, tone];

const RINGS: Ring[] = [
  { z: 0.33, y: 0.012, wide: 0, up: 0, down: 0, coat: all(BILL) },
  { z: 0.3, y: 0.014, wide: 0.006, up: 0.006, down: 0.005, coat: all(BILL) },
  { z: 0.252, y: 0.018, wide: 0.013, up: 0.013, down: 0.011, coat: all(WHITE) },
  // The white face, the crown grey behind it.
  {
    z: 0.236,
    y: 0.02,
    wide: 0.022,
    up: 0.024,
    down: 0.02,
    coat: [GREY, WHITE, WHITE],
  },
  {
    z: 0.21,
    y: 0.016,
    wide: 0.024,
    up: 0.024,
    down: 0.026,
    coat: [GREY, GREY, NECK],
  },
  // The neck, folded back: a bulge hung under the shoulders.
  {
    z: 0.185,
    y: 0.004,
    wide: 0.026,
    up: 0.024,
    down: 0.062,
    coat: [GREY, GREY, NECK],
  },
  {
    z: 0.15,
    y: 0,
    wide: 0.034,
    up: 0.03,
    down: 0.08,
    coat: [GREY, GREY, NECK],
  },
  {
    z: 0.1,
    y: 0,
    wide: 0.046,
    up: 0.04,
    down: 0.06,
    coat: [GREY, GREY, BELLY],
  },
  {
    z: 0.03,
    y: 0,
    wide: 0.055,
    up: 0.044,
    down: 0.056,
    coat: [GREY, GREY, BELLY],
  },
  {
    z: -0.04,
    y: 0,
    wide: 0.05,
    up: 0.038,
    down: 0.048,
    coat: [GREY, GREY, BELLY],
  },
  {
    z: -0.1,
    y: 0.004,
    wide: 0.036,
    up: 0.026,
    down: 0.032,
    coat: [GREY, GREY, BELLY],
  },
  { z: -0.15, y: 0.008, wide: 0.018, up: 0.012, down: 0.014, coat: all(TAIL) },
  { z: -0.165, y: 0.01, wide: 0, up: 0, down: 0 },
];

/** A wing's lines, shoulder to tip: the wrist's the third of each. */
const LEADING: Vec[] = [
  [SHOULDER, 0.03, 0.13],
  [0.15, 0.036, 0.155],
  [0.26, 0.034, 0.155],
  [0.38, 0.026, 0.115],
  [0.46, 0.02, 0.05],
];

const COVERT_LINE: Vec[] = [
  [SHOULDER, 0.032, 0.06],
  [0.15, 0.038, 0.08],
  [0.26, 0.036, 0.08],
  [0.38, 0.028, 0.05],
  [0.455, 0.021, 0.005],
];

const TRAILING: Vec[] = [
  [SHOULDER, 0.028, -0.07],
  [0.15, 0.03, -0.085],
  [0.25, 0.028, -0.095],
  [0.36, 0.024, -0.095],
  [0.445, 0.019, -0.075],
];

const TAIL_Y = 0.008;

/** Whether a flock of `species` (eBird's English name) is these herons. */
export const isHeron = (species: string) => species === SPECIES;

/** The heron's shape, for createFlight. */
export function heronForm(): Form {
  return loft({
    shoulder: SHOULDER,
    rings: RINGS,
    wing: {
      lines: [LEADING, COVERT_LINE, TRAILING],
      tip: [0.5, 0.016, -0.03],
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
      root: [0, 0.01, -0.14],
      end: [
        [0.02, 0.01, -0.14],
        [0.045, TAIL_Y, -0.185],
        [0.02, TAIL_Y, -0.2],
        [0, TAIL_Y, -0.203],
        [-0.02, TAIL_Y, -0.2],
        [-0.045, TAIL_Y, -0.185],
        [-0.02, 0.01, -0.14],
      ],
      band: 0.7,
      above: TAIL,
      under: TAIL,
      tip: TAIL,
    },
    // Its legs, held together straight out behind, the feet past the tail.
    extras({ rod, ball }) {
      for (const side of [1, -1]) {
        rod(
          [side * 0.016, -0.024, -0.09],
          [side * 0.014, -0.012, -0.33],
          0.006,
          LEGS
        );
        ball([side * 0.014, -0.012, -0.345], [0.008, 0.005, 0.026], LEGS);
      }
    },
  });
}
