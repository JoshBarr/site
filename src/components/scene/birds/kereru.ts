import { loft, type Ring, type Vec } from "./loft";
import type { Form } from "./model";

// A kererū, the New Zealand pigeon, a wingspan of 1 across x, facing +z:
// a small head on a deep round body, broad wings and a broad tail, dark
// about the head, breast and back and white below, the line between them
// straight across the breast. In greys, like the rest of the scene. Shaped
// and toned by eye from photos, and from the field guides' sizes (51 cm
// long, 75 cm across the wings).

/** eBird's name for it. */
const SPECIES = "New Zealand Pigeon";

/** Kererū drawn at once at most: beyond these, they're drawn as other birds. */
export const KERERU_MOST = 256;

/** Out from the middle to where the wings hinge, of the span. */
const SHOULDER = 0.085;

// Its greys, 0 black to 1 white: each as bright as the feathers there are
// in the photos.
const HEAD = 0.106;
const NAPE = 0.082;
const MANTLE = 0.088;
const BACK = 0.106;
const RUMP = 0.16;
const WHITE = 0.9;
const BILL = 0.15;
const BILL_TIP = 0.35;
const COVERTS = 0.088;
const SECONDARIES = 0.127;
const HAND = 0.092;
const PRIMARIES = 0.056;
const LINING = 0.4;
const UNDER_FLIGHT = 0.2;
const TAIL = 0.021;
const UNDER_TAIL = 0.048;
const TAIL_TIP = 0.27;

/**
 * The body's rings, bill to tail: where along it, its middle's height,
 * half its width, how far it reaches up and down from the middle, and the
 * greys on from it to the next: over the top, at the shoulders either
 * side of it, and from there down and under.
 */
const RINGS: Ring[] = [
  { z: 0.335, y: 0.012, wide: 0, up: 0, down: 0, coat: all(BILL_TIP) },
  { z: 0.318, y: 0.015, wide: 0.006, up: 0.006, down: 0.005, coat: all(BILL) },
  { z: 0.302, y: 0.018, wide: 0.011, up: 0.011, down: 0.01, coat: all(HEAD) },
  { z: 0.29, y: 0.022, wide: 0.028, up: 0.028, down: 0.026, coat: all(HEAD) },
  { z: 0.262, y: 0.026, wide: 0.038, up: 0.038, down: 0.034, coat: all(HEAD) },
  {
    z: 0.228,
    y: 0.022,
    wide: 0.037,
    up: 0.034,
    down: 0.036,
    coat: [NAPE, HEAD, HEAD],
  },
  {
    z: 0.19,
    y: 0.012,
    wide: 0.058,
    up: 0.046,
    down: 0.06,
    coat: [MANTLE, HEAD, HEAD],
  },
  {
    z: 0.14,
    y: 0.002,
    wide: 0.088,
    up: 0.062,
    down: 0.098,
    coat: [MANTLE, MANTLE, HEAD],
  },
  // The line across the breast: white from here back, up to the wings.
  {
    z: 0.085,
    y: 0,
    wide: 0.104,
    up: 0.074,
    down: 0.122,
    coat: [MANTLE, MANTLE, WHITE],
  },
  {
    z: 0.02,
    y: 0,
    wide: 0.11,
    up: 0.078,
    down: 0.13,
    coat: [BACK, BACK, WHITE],
  },
  {
    z: -0.06,
    y: 0,
    wide: 0.104,
    up: 0.072,
    down: 0.122,
    coat: [BACK, BACK, WHITE],
  },
  {
    z: -0.13,
    y: 0.004,
    wide: 0.08,
    up: 0.056,
    down: 0.088,
    coat: [RUMP, RUMP, WHITE],
  },
  {
    z: -0.19,
    y: 0.01,
    wide: 0.05,
    up: 0.034,
    down: 0.044,
    coat: [RUMP, RUMP, WHITE],
  },
  { z: -0.235, y: 0.012, wide: 0.034, up: 0.014, down: 0.016, coat: all(TAIL) },
  { z: -0.25, y: 0.012, wide: 0, up: 0, down: 0 },
];

function all(tone: number): [number, number, number] {
  return [tone, tone, tone];
}

/**
 * A wing's edges, shoulder to tip, the right one's: its leading edge, the
 * line its coverts end at, and its trailing edge. The wrist's the third of
 * each.
 */
const LEADING: Vec[] = [
  [SHOULDER, 0.045, 0.1],
  [0.16, 0.048, 0.125],
  [0.26, 0.046, 0.12],
  [0.38, 0.036, 0.075],
  [0.47, 0.028, 0.015],
];

const COVERT_LINE: Vec[] = [
  [SHOULDER, 0.047, 0.035],
  [0.16, 0.05, 0.05],
  [0.26, 0.048, 0.045],
  [0.38, 0.038, 0.01],
  [0.46, 0.029, -0.03],
];

const TRAILING: Vec[] = [
  [SHOULDER, 0.043, -0.085],
  [0.16, 0.042, -0.105],
  [0.25, 0.04, -0.11],
  [0.36, 0.034, -0.105],
  [0.455, 0.028, -0.085],
];

const WING_TIP: Vec = [0.5, 0.026, -0.04];

/** From here out, the hand: the primaries and their coverts. */
const WRIST = 2;

/** The tail's root, and round its end, right to left. */
const TAIL_ROOT: Vec = [0, 0.014, -0.21];

const TAIL_END: Vec[] = [
  [0.036, 0.014, -0.21],
  [0.1, 0.006, -0.35],
  [0.06, 0.006, -0.383],
  [0, 0.006, -0.392],
  [-0.06, 0.006, -0.383],
  [-0.1, 0.006, -0.35],
  [-0.036, 0.014, -0.21],
];

/** Under the tail, pale from this far along it. */
const TAIL_BAND = 0.72;

/** Whether a flock of `species` (eBird's English name) is kererū. */
export const isKereru = (species: string) => species === SPECIES;

/** The kererū's shape, for createFlight. */
export function kereruForm(): Form {
  return loft({
    shoulder: SHOULDER,
    rings: RINGS,
    wing: {
      lines: [LEADING, COVERT_LINE, TRAILING],
      tip: WING_TIP,
      wrist: WRIST,
      above: [
        { arm: COVERTS, hand: HAND },
        { arm: SECONDARIES, hand: PRIMARIES },
      ],
      below: [
        { arm: LINING, hand: LINING },
        { arm: UNDER_FLIGHT, hand: UNDER_FLIGHT },
      ],
    },
    tail: {
      root: TAIL_ROOT,
      end: TAIL_END,
      band: TAIL_BAND,
      above: TAIL,
      under: UNDER_TAIL,
      tip: TAIL_TIP,
    },
  });
}
