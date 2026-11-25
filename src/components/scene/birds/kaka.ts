import { BufferGeometry, Float32BufferAttribute } from "three/webgpu";
import type { Form } from "./model";

// A kākā in flight, a wingspan of 1 across x, facing +z, as ./model.ts
// flies it: a stout body and a big head, the heavy hooked bill, broad wings
// with the outer primaries spread like fingers, and a short fanned tail.
// Painted a triangle at a time, above and below, in greys like the rest of
// the scene: dark over the back and wings, the pale crown, the lighter
// cheek, and under the wing the paler coverts and barred flight feathers.
// Shape and tones are from photographs; its proportions from a bird 0.42 m
// long, across a span taken off a photograph as twice that (nobody seems
// to publish one).

type Vec = [number, number, number];

/** eBird's name for it. */
const SPECIES = "New Zealand Kaka";

/** Kākā drawn at once at most: beyond these, they're drawn as other birds. */
export const KAKA_MOST = 256;

/** Out from the middle to the shoulder, of the span: the wings' hinge. */
const SHOULDER = 0.05;

const BODY = 0;
const WING = 1;

/** The kākā's wingspan, m. */
export const KAKA_SPAN = 0.85;

/**
 * Its wingbeats a second: a guess, the smaller parrots' six slowed as its
 * wings are longer than theirs.
 */
export const KAKA_BEAT = 4;

// Its greys, 0 black to 1 white: each as bright as the feathers there are
// in the photographs. Those under the wings and tail are paler than the
// feathers are: the scene lights what faces down by little but the sky, and
// in life they're lit through, and from the ground.
const CROWN = 0.56;
const FOREHEAD = 0.44;
const NAPE = 0.14;
const CHEEK = 0.32;
const FACE = 0.18;
const THROAT = 0.11;
const BACK = 0.1;
const BACK_DARK = 0.07;
const FLANK = 0.1;
const BREAST = 0.13;
const BELLY = 0.095;
const RUMP = 0.086;
const COVERT = 0.113;
const COVERT_DARK = 0.094;
const FLIGHT = 0.058;
const FLIGHT_DARK = 0.049;
const LINING = 0.23;
const BAR_PALE = 0.45;
const BAR_DARK = 0.19;
const TAIL = 0.071;
const TAIL_DARK = 0.053;
const TAIL_TIP = 0.18;
const TAIL_UNDER = 0.17;
const BILL = 0.19;
const BILL_DARK = 0.085;
const EYE = 0.006;

const mix = (a: Vec, b: Vec, t: number): Vec => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const normalOf = (a: Vec, b: Vec, c: Vec): Vec => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];

  return [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
};

/** Which way a sheet's triangle faces: seen from above, or from below. */
type Face = 1 | -1;

/**
 * The model's triangles, as they're painted: each seen from its face only
 * (model.ts draws a painted bird's front faces), so a wing is a sheet
 * facing up and another facing down.
 */
class Painter {
  /** Three numbers a corner, three corners a triangle. */
  positions: number[] = [];
  /** A corner's part: BODY, or WING (swung about the shoulder). */
  parts: number[] = [];
  /** A corner's grey, 0 black to 1 white. */
  paints: number[] = [];

  private push(part: number, tone: number, corners: Vec[]) {
    for (const p of corners) {
      this.positions.push(p[0], p[1], p[2]);
      this.parts.push(part);
      this.paints.push(tone);
    }
  }

  /** A triangle of a solid, facing away from `inside`. */
  solid(inside: Vec, tone: number, a: Vec, b: Vec, c: Vec) {
    const n = normalOf(a, b, c);

    const out =
      n[0] * ((a[0] + b[0] + c[0]) / 3 - inside[0]) +
      n[1] * ((a[1] + b[1] + c[1]) / 3 - inside[1]) +
      n[2] * ((a[2] + b[2] + c[2]) / 3 - inside[2]);

    this.push(BODY, tone, out < 0 ? [a, c, b] : [a, b, c]);
  }

  /** A triangle of a sheet (a wing, the tail), seen from `face`. */
  sheet(part: number, face: Face, tone: number, a: Vec, b: Vec, c: Vec) {
    const up = normalOf(a, b, c)[1] * face > 0;

    this.push(part, tone, up ? [a, b, c] : [a, c, b]);
  }

  /** A four-cornered piece of a sheet, its corners in order round it. */
  panel(
    part: number,
    face: Face,
    tone: number,
    a: Vec,
    b: Vec,
    c: Vec,
    d: Vec
  ) {
    this.sheet(part, face, tone, a, b, c);
    this.sheet(part, face, tone, a, c, d);
  }
}

/** Corners round the body at a station along it. */
const SIDES = 8;

/**
 * The body and head, nose to tail: at each station (z), half its width,
 * and its top and bottom.
 */
const STATIONS: [z: number, half: number, top: number, bottom: number][] = [
  [0.214, 0.02, 0.036, -0.008],
  [0.192, 0.037, 0.054, -0.02],
  [0.156, 0.043, 0.058, -0.028],
  [0.122, 0.04, 0.046, -0.034],
  [0.07, 0.058, 0.05, -0.054],
  [0, 0.06, 0.046, -0.062],
  [-0.07, 0.044, 0.03, -0.046],
  [-0.125, 0.024, 0.012, -0.016],
];

/**
 * Each stretch between stations, painted round from the top: the top, the
 * shoulder of it, the flank, and underneath.
 */
const COATS: [top: number, upper: number, flank: number, under: number][] = [
  [FOREHEAD, FOREHEAD, FACE, THROAT],
  [CROWN, CROWN, FACE, THROAT],
  [NAPE, NAPE, CHEEK, THROAT],
  [BACK, BACK_DARK, FLANK, BREAST],
  [BACK_DARK, BACK, FLANK, BREAST],
  [BACK, BACK_DARK, BELLY, BELLY],
  [RUMP, RUMP, BELLY, BELLY],
];

function ring([z, half, top, bottom]: (typeof STATIONS)[number]): Vec[] {
  const middle = (top + bottom) / 2;
  const height = (top - bottom) / 2;

  return Array.from({ length: SIDES }, (_, k): Vec => {
    // From beside the top, round by the left (+x): the last face is the top.
    const angle = ((k + 0.5) / SIDES) * Math.PI * 2;

    return [Math.sin(angle) * half, middle + Math.cos(angle) * height, z];
  });
}

function body(paint: Painter) {
  const rings = STATIONS.map(ring);

  for (let s = 0; s < rings.length - 1; s++) {
    const [z0, , top0, bottom0] = STATIONS[s];
    const [z1, , top1, bottom1] = STATIONS[s + 1];

    const inside: Vec = [
      0,
      (top0 + bottom0 + top1 + bottom1) / 4,
      (z0 + z1) / 2,
    ];

    const [top, upper, flank, under] = COATS[s];
    const coats = [upper, flank, under, under, under, flank, upper, top];

    for (let k = 0; k < SIDES; k++) {
      const next = (k + 1) % SIDES;
      const a = rings[s][k];
      const b = rings[s][next];
      const c = rings[s + 1][next];
      const d = rings[s + 1][k];

      paint.solid(inside, coats[k], a, b, c);
      paint.solid(inside, coats[k], a, c, d);
    }
  }

  // Closed at the tail; and at the face, behind the bill.
  const last = rings[rings.length - 1];
  const end: Vec = [0, 0, STATIONS[STATIONS.length - 1][0] - 0.015];

  for (let k = 0; k < SIDES; k++) {
    paint.solid([0, 0, -0.1], BELLY, last[k], last[(k + 1) % SIDES], end);
  }

  const face = rings[0];
  const front: Vec = [0, 0.012, STATIONS[0][0] + 0.004];

  for (let k = 0; k < SIDES; k++) {
    paint.solid([0, 0.01, 0.2], FACE, face[k], face[(k + 1) % SIDES], front);
  }

  // The eyes, just proud of the head.
  for (const side of [1, -1]) {
    const x = side * 0.0368;
    const inside: Vec = [0, 0.018, 0.186];

    paint.solid(
      inside,
      EYE,
      [x, 0.026, 0.186],
      [x, 0.015, 0.193],
      [x, 0.015, 0.179]
    );
  }
}

/** The bill: the upper mandible hooked down over a short lower one. */
function bill(paint: Painter) {
  const inside: Vec = [0, 0.008, 0.22];
  const brow: Vec = [0, 0.04, 0.208];
  const bend: Vec = [0, 0.032, 0.238];
  const tip: Vec = [0, -0.026, 0.246];
  const gape = (side: number): Vec => [side * 0.018, 0.002, 0.208];
  const edge = (side: number): Vec => [side * 0.01, -0.004, 0.234];

  for (const side of [1, -1]) {
    paint.solid(inside, BILL, brow, bend, gape(side));
    paint.solid(inside, BILL, bend, edge(side), gape(side));
    paint.solid(inside, BILL_DARK, bend, tip, edge(side));
  }

  paint.solid(inside, BILL_DARK, gape(1), edge(1), gape(-1));
  paint.solid(inside, BILL_DARK, edge(1), edge(-1), gape(-1));
  paint.solid(inside, BILL_DARK, edge(1), tip, edge(-1));

  // The lower mandible, tucked under the hook.
  const under: Vec = [0, -0.024, 0.21];
  const point: Vec = [0, -0.016, 0.228];
  const jaw = (side: number): Vec => [side * 0.014, -0.004, 0.208];
  const within: Vec = [0, -0.01, 0.214];

  for (const side of [1, -1]) {
    paint.solid(within, BILL, jaw(side), point, under);
  }

  paint.solid(within, BILL, jaw(1), jaw(-1), point);
}

/** The tail: a fan of feathers from under the rump, pale at their tips. */
function tail(paint: Painter) {
  const y = 0.004;
  const root = -0.1;

  // The fan's end, from one side round to the other.
  const ends: Vec[] = [
    [0.076, y, -0.236],
    [0.054, y, -0.258],
    [0.028, y, -0.269],
    [0, y, -0.272],
    [-0.028, y, -0.269],
    [-0.054, y, -0.258],
    [-0.076, y, -0.236],
  ];

  const feathers = ends.length - 1;

  for (let f = 0; f < feathers; f++) {
    const a: Vec = [0.024 - (0.048 * f) / feathers, y, root];
    const b: Vec = [0.024 - (0.048 * (f + 1)) / feathers, y, root];
    const c = ends[f + 1];
    const d = ends[f];
    // Each feather's last fifth, its pale tip.
    const band = 0.8;
    const e = mix(b, c, band);
    const g = mix(a, d, band);

    paint.panel(BODY, 1, f % 2 ? TAIL : TAIL_DARK, a, b, e, g);
    paint.panel(BODY, 1, TAIL_TIP, g, e, c, d);
    paint.panel(BODY, -1, TAIL_UNDER, a, b, e, g);
    paint.panel(BODY, -1, TAIL_TIP, g, e, c, d);
  }
}

/** Out from the middle to the wrist, of the span: the hand's beyond it. */
const WRIST = 0.26;

/**
 * The inner wing, shoulder to wrist: at each station out along it (x), its
 * leading edge, where the coverts end and the flight feathers begin, and
 * its trailing edge (z). The first is in at the body, inside the hinge:
 * from it to the next stays still, and the wing swings from there.
 */
const ARM: [x: number, lead: number, coverts: number, trail: number][] = [
  [0.028, 0.085, 0.015, -0.082],
  [SHOULDER, 0.098, 0.022, -0.09],
  [0.12, 0.116, 0.036, -0.106],
  [0.19, 0.129, 0.05, -0.116],
  [WRIST, 0.135, 0.06, -0.121],
];

/** A wing's height across its chord: up from the leading edge, then down. */
const CAMBER = { lead: 0.008, coverts: 0.018, trail: 0.006 };

/**
 * The outer wing's leading edge, from the wrist round toward the tip, and
 * the line its primaries grow from (x, z).
 */
const HAND_LEAD: [number, number][] = [
  [WRIST, 0.135],
  [0.34, 0.129],
  [0.405, 0.108],
  [0.447, 0.08],
];

const HAND_ROOT: [number, number][] = [
  [WRIST, 0.06],
  [0.325, 0.064],
  [0.385, 0.068],
  [0.43, 0.07],
];

/**
 * The primaries' tips, from the innermost (next the secondaries) to the
 * outermost (the leading edge): x, z, and how wide the feather is there,
 * of the way to its neighbours. The inner ones lie edge to edge; the outer
 * are spread, with slots between.
 */
const PRIMARIES: [x: number, z: number, width: number][] = [
  [0.296, -0.126, 1],
  [0.345, -0.13, 1],
  [0.394, -0.124, 1],
  [0.436, -0.106, 0.72],
  [0.467, -0.076, 0.62],
  [0.487, -0.036, 0.56],
  [0.4915, 0.012, 0.52],
];

/** Along a line of points, `t` of the way from its first to its last. */
function along(line: [number, number][], t: number): [number, number] {
  const at = Math.min(Math.max(t, 0), 1) * (line.length - 1);
  const i = Math.min(Math.floor(at), line.length - 2);
  const f = at - i;

  return [
    line[i][0] + (line[i + 1][0] - line[i][0]) * f,
    line[i][1] + (line[i + 1][1] - line[i][1]) * f,
  ];
}

function wing(paint: Painter, side: number) {
  const at = (x: number, y: number, z: number): Vec => [side * x, y, z];

  // The arm: the coverts, then the secondaries. Above, a row of each;
  // below, the coverts and the secondaries barred.
  for (let s = 0; s < ARM.length - 1; s++) {
    const [x0, lead0, coverts0, trail0] = ARM[s];
    const [x1, lead1, coverts1, trail1] = ARM[s + 1];
    const odd = s % 2 === 1;

    // Points across the chord at either station, by how far back.
    const chord = (t: number, back: boolean): [Vec, Vec] => {
      const from = back ? [coverts0, coverts1] : [lead0, lead1];
      const to = back ? [trail0, trail1] : [coverts0, coverts1];

      const y = back
        ? CAMBER.coverts + (CAMBER.trail - CAMBER.coverts) * t
        : CAMBER.lead + (CAMBER.coverts - CAMBER.lead) * t;

      return [
        at(x0, y, from[0] + (to[0] - from[0]) * t),
        at(x1, y, from[1] + (to[1] - from[1]) * t),
      ];
    };

    const rows: [Face, number, number, boolean, number][] = [
      [1, 0, 1, false, odd ? COVERT : COVERT_DARK],
      [1, 0, 1, true, odd ? FLIGHT : FLIGHT_DARK],
      [-1, 0, 1, false, LINING],
      [-1, 0, 0.28, true, BAR_DARK],
      [-1, 0.28, 0.5, true, BAR_PALE],
      [-1, 0.5, 1, true, BAR_DARK],
    ];

    // In at the body, it's the body's: only what's out from the hinge
    // swings.
    const part = x0 < SHOULDER ? BODY : WING;

    for (const [face, from, to, back, tone] of rows) {
      const [a, b] = chord(from, back);
      const [d, c] = chord(to, back);

      paint.panel(part, face, tone, a, b, c, d);
    }
  }

  // The hand's coverts, between its leading edge and the primaries' roots.
  const pieces = HAND_LEAD.length - 1;

  for (let s = 0; s < pieces; s++) {
    const a = at(HAND_LEAD[s][0], CAMBER.lead, HAND_LEAD[s][1]);
    const b = at(HAND_LEAD[s + 1][0], CAMBER.lead, HAND_LEAD[s + 1][1]);
    const c = at(HAND_ROOT[s + 1][0], CAMBER.coverts, HAND_ROOT[s + 1][1]);
    const d = at(HAND_ROOT[s][0], CAMBER.coverts, HAND_ROOT[s][1]);

    paint.panel(WING, 1, s % 2 ? COVERT : COVERT_DARK, a, b, c, d);
    paint.panel(WING, -1, LINING, a, b, c, d);
  }

  // The primaries: each from its stretch of the root line out to its tip,
  // barred below, the outer ones curling up a little at their tips.
  const count = PRIMARIES.length;

  for (let f = 0; f < count; f++) {
    const [tipX, tipZ, width] = PRIMARIES[f];
    const from = along(HAND_ROOT, f / count);
    const to = along(HAND_ROOT, (f + 1) / count);
    const curl = 0.004 + (0.012 * f) / (count - 1);

    // Its edges at the tip: toward its neighbours' tips, all the way to
    // halfway for feathers lying edge to edge, less for the spread ones.
    // The innermost meets the secondaries; the outermost is as wide again
    // on its leading side.
    const toward = (other: number): [number, number] => [
      tipX + ((PRIMARIES[other][0] - tipX) * width) / 2,
      tipZ + ((PRIMARIES[other][1] - tipZ) * width) / 2,
    ];

    const wrist = ARM[ARM.length - 1];
    const inward = f > 0 ? toward(f - 1) : [wrist[0], wrist[3]];

    const outward =
      f < count - 1
        ? toward(f + 1)
        : [2 * tipX - inward[0], 2 * tipZ - inward[1]];

    const rootIn = at(from[0], CAMBER.coverts, from[1]);
    const rootOut = at(to[0], CAMBER.coverts, to[1]);
    const tipIn = at(inward[0], f > 0 ? curl : CAMBER.trail, inward[1]);
    const tipOut = at(outward[0], curl, outward[1]);

    // Rounded off, a little further along its shaft.
    const shaft = [tipX - (from[0] + to[0]) / 2, tipZ - (from[1] + to[1]) / 2];
    const length = Math.hypot(shaft[0], shaft[1]);
    const round = Math.hypot(outward[0] - inward[0], outward[1] - inward[1]);

    const point = at(
      (inward[0] + outward[0]) / 2 + (shaft[0] / length) * round * 0.45,
      curl + 0.001,
      (inward[1] + outward[1]) / 2 + (shaft[1] / length) * round * 0.45
    );

    const top = f % 2 ? FLIGHT : FLIGHT_DARK;

    paint.panel(WING, 1, top, rootIn, rootOut, tipOut, tipIn);
    paint.sheet(WING, 1, top, tipIn, tipOut, point);

    const bands = [BAR_DARK, BAR_PALE, BAR_DARK, BAR_PALE];
    const cuts = [0, 0.22, 0.4, 0.62, 0.78];

    for (let b = 0; b < bands.length; b++) {
      paint.panel(
        WING,
        -1,
        bands[b],
        mix(rootIn, tipIn, cuts[b]),
        mix(rootOut, tipOut, cuts[b]),
        mix(rootOut, tipOut, cuts[b + 1]),
        mix(rootIn, tipIn, cuts[b + 1])
      );
    }

    // Its dark end, and the rounding of it.
    const last = cuts[cuts.length - 1];

    paint.panel(
      WING,
      -1,
      BAR_DARK,
      mix(rootIn, tipIn, last),
      mix(rootOut, tipOut, last),
      tipOut,
      tipIn
    );
    paint.sheet(WING, -1, BAR_DARK, tipIn, tipOut, point);
  }
}

/** The kākā, as triangles. */
function createKaka() {
  const paint = new Painter();

  body(paint);
  bill(paint);
  tail(paint);
  wing(paint, 1);
  wing(paint, -1);

  return paint;
}

/** Whether a flock of `species` (eBird's English name) is kākā. */
export const isKaka = (species: string) => species === SPECIES;

/** The kākā's shape, for createFlight. */
export function kakaForm(): Form {
  const kaka = createKaka();
  const geometry = new BufferGeometry();

  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(kaka.positions, 3)
  );
  geometry.setAttribute("part", new Float32BufferAttribute(kaka.parts, 1));
  geometry.setAttribute("paint", new Float32BufferAttribute(kaka.paints, 1));
  geometry.computeVertexNormals();

  return { geometry, shoulder: SHOULDER, wrist: WRIST, painted: true };
}
