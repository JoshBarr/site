import { BufferGeometry, Float32BufferAttribute } from "three/webgpu";
import type { Form } from "./model";

// A kererū, the New Zealand pigeon, a wingspan of 1 across x, facing +z:
// a small head on a deep round body, broad wings and a broad tail, dark
// about the head, breast and back and white below, the line between them
// straight across the breast. In greys, like the rest of the scene. Shaped
// and toned by eye from photos, and from the field guides' sizes (51 cm
// long, 75 cm across the wings).

type Vec = [number, number, number];

/** eBird's name for it. */
const SPECIES = "New Zealand Pigeon";

/** Kererū drawn at once at most: beyond these, they're drawn as other birds. */
export const KERERU_MOST = 256;

const BODY = 0;
const WING = 1;

/** Out from the middle to where the wings hinge, of the span. */
const SHOULDER = 0.085;

/** Round the body. */
const SIDES = 12;

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
const RINGS: {
  z: number;
  y: number;
  wide: number;
  up: number;
  down: number;
  coat?: [top: number, shoulder: number, below: number];
}[] = [
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

function createKereruGeometry() {
  const positions: number[] = [];
  const parts: number[] = [];
  const paints: number[] = [];

  /** A triangle of `part`, painted `tone`, wound to face the way `out` does. */
  const triangle = (
    part: number,
    tone: number,
    out: Vec,
    a: Vec,
    b: Vec,
    c: Vec
  ) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];

    const facing =
      (u[1] * v[2] - u[2] * v[1]) * out[0] +
      (u[2] * v[0] - u[0] * v[2]) * out[1] +
      (u[0] * v[1] - u[1] * v[0]) * out[2];

    for (const p of facing < 0 ? [a, c, b] : [a, b, c]) {
      positions.push(p[0], p[1], p[2]);
      parts.push(part);
      paints.push(tone);
    }
  };

  // The body, ring to ring: each ring's points from the top, down the
  // right side, under, and back up the left.
  const round = RINGS.map((ring) =>
    Array.from({ length: SIDES }, (_, k): Vec => {
      const angle = (k / SIDES) * Math.PI * 2;
      const rise = Math.cos(angle);

      return [
        ring.wide * Math.sin(angle),
        ring.y + rise * (rise > 0 ? ring.up : ring.down),
        ring.z,
      ];
    })
  );

  for (let i = 0; i < RINGS.length - 1; i++) {
    const { coat } = RINGS[i];

    const middle: Vec = [
      0,
      (RINGS[i].y + RINGS[i + 1].y) / 2,
      (RINGS[i].z + RINGS[i + 1].z) / 2,
    ];

    for (let k = 0; k < SIDES; k++) {
      // The same on the left as the right: the top two faces, the next
      // two down, and the rest.
      const band = Math.min(k, SIDES - 1 - k, 2);
      const tone = coat?.[band] ?? TAIL;
      const a = round[i][k];
      const b = round[i][(k + 1) % SIDES];
      const c = round[i + 1][(k + 1) % SIDES];
      const d = round[i + 1][k];

      const out: Vec = [
        (a[0] + b[0] + c[0] + d[0]) / 4 - middle[0],
        (a[1] + b[1] + c[1] + d[1]) / 4 - middle[1],
        (a[2] + b[2] + c[2] + d[2]) / 4 - middle[2],
      ];

      // A ring of no width is a point: one triangle to it, not two.
      if (RINGS[i].wide > 0) triangle(BODY, tone, out, a, b, c);

      if (RINGS[i + 1].wide > 0) triangle(BODY, tone, out, a, c, d);
    }
  }

  // The wings, each a sheet seen from above and another from below.
  const up: Vec = [0, 1, 0];
  const down: Vec = [0, -1, 0];

  for (const side of [1, -1]) {
    const on = (p: Vec): Vec => [p[0] * side, p[1], p[2]];
    const lead = LEADING.map(on);
    const line = COVERT_LINE.map(on);
    const trail = TRAILING.map(on);
    const tip = on(WING_TIP);
    const last = lead.length - 1;

    for (const [out, coverts, flight, hand, primaries] of [
      [up, COVERTS, SECONDARIES, HAND, PRIMARIES],
      [down, LINING, UNDER_FLIGHT, LINING, UNDER_FLIGHT],
    ] as const) {
      for (let i = 0; i < last; i++) {
        const front = i < WRIST ? coverts : hand;
        const back = i < WRIST ? flight : primaries;

        triangle(WING, front, out, lead[i], lead[i + 1], line[i + 1]);
        triangle(WING, front, out, lead[i], line[i + 1], line[i]);
        triangle(WING, back, out, line[i], line[i + 1], trail[i + 1]);
        triangle(WING, back, out, line[i], trail[i + 1], trail[i]);
      }

      triangle(WING, hand, out, lead[last], tip, line[last]);
      triangle(WING, primaries, out, line[last], tip, trail[last]);
    }
  }

  // The tail, fanned: dark above; below, dark to a pale band at its end.
  const along = (p: Vec): Vec => [
    TAIL_ROOT[0] + (p[0] - TAIL_ROOT[0]) * TAIL_BAND,
    TAIL_ROOT[1] + (p[1] - TAIL_ROOT[1]) * TAIL_BAND,
    TAIL_ROOT[2] + (p[2] - TAIL_ROOT[2]) * TAIL_BAND,
  ];

  for (let i = 0; i < TAIL_END.length - 1; i++) {
    const a = TAIL_END[i];
    const b = TAIL_END[i + 1];

    triangle(BODY, TAIL, up, TAIL_ROOT, a, b);
    triangle(BODY, UNDER_TAIL, down, TAIL_ROOT, along(a), along(b));
    triangle(BODY, TAIL_TIP, down, along(a), a, b);
    triangle(BODY, TAIL_TIP, down, along(a), b, along(b));
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("part", new Float32BufferAttribute(parts, 1));
  geometry.setAttribute("paint", new Float32BufferAttribute(paints, 1));
  geometry.computeVertexNormals();

  return geometry;
}

/** Whether a flock of `species` (eBird's English name) is kererū. */
export const isKereru = (species: string) => species === SPECIES;

/** The kererū's shape, for createFlight. */
export function kereruForm(): Form {
  return {
    geometry: createKereruGeometry(),
    shoulder: SHOULDER,
    wrist: LEADING[WRIST][0],
    painted: true,
  };
}
