import { loft, type Ring, type Vec } from "./loft";
import type { Form } from "./model";

// A tūī, a wingspan of 1 across x, facing +z: a slim dark bird with a
// fine curved bill, broad round wings and a long tail, the two white tufts
// at its throat, the white patch on each wing, and the pale lace at the
// sides of its neck. In greys, like the rest of the scene. Shaped by eye;
// 30 cm long, and its span, which nobody seems to publish, guessed at.

/** eBird's name for it. */
const SPECIES = "Tui";

/** Tūī drawn at once at most: beyond these, they're drawn as other birds. */
export const TUI_MOST = 512;

/** The tūī's wingspan, m: a guess, from a blackbird's and its own length. */
export const TUI_SPAN = 0.44;

/** Out from the middle to where the wings hinge, of the span. */
const SHOULDER = 0.07;

// Its greys, 0 black to 1 white: black with a sheen, browner on the back.
const BILL = 0.02;
const HEAD = 0.035;
const LACE = 0.22;
const BACK = 0.07;
const BODY = 0.04;
const BELLY = 0.05;
const TUFT = 0.92;
const COVERTS = 0.06;
const PATCH = 0.75;
const FLIGHT = 0.035;
const LINING = 0.1;
const UNDER_FLIGHT = 0.065;
const TAIL = 0.03;
const UNDER_TAIL = 0.05;

const all = (tone: number): [number, number, number] => [tone, tone, tone];

const RINGS: Ring[] = [
  // The bill, curved down to its tip.
  { z: 0.36, y: -0.004, wide: 0, up: 0, down: 0, coat: all(BILL) },
  { z: 0.335, y: 0.004, wide: 0.005, up: 0.005, down: 0.004, coat: all(BILL) },
  { z: 0.3, y: 0.012, wide: 0.012, up: 0.012, down: 0.01, coat: all(HEAD) },
  { z: 0.275, y: 0.016, wide: 0.032, up: 0.032, down: 0.028, coat: all(HEAD) },
  // The lace at the sides of its neck.
  {
    z: 0.235,
    y: 0.014,
    wide: 0.038,
    up: 0.034,
    down: 0.034,
    coat: [HEAD, LACE, HEAD],
  },
  {
    z: 0.195,
    y: 0.008,
    wide: 0.044,
    up: 0.036,
    down: 0.044,
    coat: [BACK, BODY, BODY],
  },
  {
    z: 0.14,
    y: 0.002,
    wide: 0.064,
    up: 0.05,
    down: 0.064,
    coat: [BACK, BACK, BODY],
  },
  {
    z: 0.06,
    y: 0,
    wide: 0.076,
    up: 0.056,
    down: 0.076,
    coat: [BACK, BACK, BELLY],
  },
  {
    z: -0.02,
    y: 0,
    wide: 0.07,
    up: 0.05,
    down: 0.066,
    coat: [BACK, BODY, BELLY],
  },
  {
    z: -0.08,
    y: 0.004,
    wide: 0.05,
    up: 0.034,
    down: 0.044,
    coat: all(BODY),
  },
  { z: -0.125, y: 0.01, wide: 0.028, up: 0.016, down: 0.018, coat: all(TAIL) },
  { z: -0.14, y: 0.012, wide: 0, up: 0, down: 0 },
];

/** A wing's lines, shoulder to tip: the wrist's the third of each. */
const LEADING: Vec[] = [
  [SHOULDER, 0.03, 0.13],
  [0.16, 0.032, 0.15],
  [0.25, 0.03, 0.15],
  [0.36, 0.024, 0.115],
  [0.45, 0.018, 0.05],
];

/** Between the lesser coverts and the greater: the white patch is behind it. */
const PATCH_LINE: Vec[] = [
  [SHOULDER, 0.031, 0.095],
  [0.16, 0.033, 0.112],
  [0.25, 0.031, 0.112],
  [0.36, 0.025, 0.083],
  [0.447, 0.019, 0.026],
];

const COVERT_LINE: Vec[] = [
  [SHOULDER, 0.032, 0.07],
  [0.16, 0.034, 0.085],
  [0.25, 0.032, 0.085],
  [0.36, 0.026, 0.06],
  [0.445, 0.019, 0.01],
];

const TRAILING: Vec[] = [
  [SHOULDER, 0.028, -0.05],
  [0.16, 0.028, -0.065],
  [0.24, 0.026, -0.075],
  [0.35, 0.022, -0.08],
  [0.44, 0.018, -0.07],
];

const TAIL_Y = 0.008;

/** Whether a flock of `species` (eBird's English name) is tūī. */
export const isTui = (species: string) => species === SPECIES;

/** The tūī's shape, for createFlight. */
export function tuiForm(): Form {
  return loft({
    shoulder: SHOULDER,
    rings: RINGS,
    wing: {
      lines: [LEADING, PATCH_LINE, COVERT_LINE, TRAILING],
      tip: [0.5, 0.016, -0.02],
      wrist: 2,
      above: [
        { arm: COVERTS, hand: COVERTS },
        // The white patch, on the greater coverts in from the wrist.
        { arm: [COVERTS, PATCH], hand: COVERTS },
        { arm: FLIGHT, hand: FLIGHT },
      ],
      below: [
        { arm: LINING, hand: LINING },
        { arm: LINING, hand: LINING },
        { arm: UNDER_FLIGHT, hand: UNDER_FLIGHT },
      ],
    },
    tail: {
      root: [0, 0.012, -0.11],
      end: [
        [0.03, 0.012, -0.11],
        [0.075, TAIL_Y, -0.27],
        [0.05, TAIL_Y, -0.31],
        [0, TAIL_Y, -0.32],
        [-0.05, TAIL_Y, -0.31],
        [-0.075, TAIL_Y, -0.27],
        [-0.03, 0.012, -0.11],
      ],
      band: 0.7,
      above: TAIL,
      under: UNDER_TAIL,
      tip: UNDER_TAIL,
    },
    // The poi: two white tufts under its throat.
    extras({ ball }) {
      for (const side of [1, -1]) {
        ball([side * 0.014, -0.036, 0.222], [0.014, 0.017, 0.015], TUFT);
      }
    },
  });
}
