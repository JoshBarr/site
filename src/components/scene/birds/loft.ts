import { BufferGeometry, Float32BufferAttribute } from "three/webgpu";
import type { Form } from "./model";

// A bird built from a few tables, as ./model.ts flies it (a wingspan of 1
// across x, facing +z): its body a row of rings from the bill to the tail
// with a skin between them, each wing a sheet seen from above and another
// from below, cut into rows of feathers along it, and its tail a fan. In
// greys, a triangle at a time. What a kind has that nothing else does (a
// tūī's tufts, a heron's legs) it adds itself.

export type Vec = [number, number, number];

const BODY = 0;
const WING = 1;

/** A grey, 0 black to 1 white: one for every piece, or one for each along. */
type Tones = number | number[];

/**
 * A ring of the body: where along it, its middle's height, half its
 * width, how far it reaches up and down from the middle, and the greys on
 * from it to the next: over the top, at the shoulders either side of it,
 * and from there down and under.
 */
export interface Ring {
  z: number;
  y: number;
  wide: number;
  up: number;
  down: number;
  coat?: [top: Tones, shoulder: Tones, below: Tones];
}

/** A row of a wing's feathers: its greys in to the wrist, and out from it. */
interface Row {
  arm: Tones;
  hand: Tones;
}

interface Plan {
  /** Out from the middle to where the wings hinge, of the span. */
  shoulder: number;
  /** Round the body: 12, unless given. */
  sides?: number;
  /** Bill to tail; a ring of no width is a point. */
  rings: Ring[];
  wing: {
    /**
     * The right wing's lines, from its leading edge back to its trailing
     * edge, each from the shoulder out; as many points in each.
     */
    lines: Vec[][];
    tip: Vec;
    /** Which point of each line is the wrist: the hand's from there out. */
    wrist: number;
    /** Its rows of feathers, front to back: one fewer than its lines. */
    above: Row[];
    below: Row[];
  };
  tail: {
    root: Vec;
    /** Round its end, right to left. */
    end: Vec[];
    /** Its end's band begins this far along it. */
    band: number;
    /** Above; below, short of the band; and the band below. */
    above: Tones;
    under: Tones;
    tip: Tones;
    /** The band above, where it's not as the rest of the tail is. */
    edge?: Tones;
  };
  /** Whatever else it has. */
  extras?: (kit: Kit) => void;
}

/** What a plan's extras are made with. */
interface Kit {
  /** A lump, as wide, high and long as `radius` either way from `centre`. */
  ball(centre: Vec, radius: Vec, tone: number): void;
  /** A four-sided rod from one point to another, shut at both ends. */
  rod(from: Vec, to: Vec, radius: number, tone: number): void;
}

const pick = (tones: Tones, i: number) =>
  Array.isArray(tones)
    ? tones[Math.min(Math.max(i, 0), tones.length - 1)]
    : tones;

const minus = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const cross = (u: Vec, v: Vec): Vec => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

/** The bird a plan describes, for createFlight. */
export function loft(plan: Plan): Form {
  const positions: number[] = [];
  const parts: number[] = [];
  const paints: number[] = [];
  const sides = plan.sides ?? 12;

  /** A triangle of `part`, painted `tone`, wound to face the way `out` does. */
  const triangle = (
    part: number,
    tone: number,
    out: Vec,
    a: Vec,
    b: Vec,
    c: Vec
  ) => {
    const n = cross(minus(b, a), minus(c, a));
    const facing = n[0] * out[0] + n[1] * out[1] + n[2] * out[2];

    for (const p of facing < 0 ? [a, c, b] : [a, b, c]) {
      positions.push(p[0], p[1], p[2]);
      parts.push(part);
      paints.push(tone);
    }
  };

  /** A triangle of a solid, facing away from a point `inside` it. */
  const outward = (tone: number, inside: Vec, a: Vec, b: Vec, c: Vec) =>
    triangle(
      BODY,
      tone,
      [
        (a[0] + b[0] + c[0]) / 3 - inside[0],
        (a[1] + b[1] + c[1]) / 3 - inside[1],
        (a[2] + b[2] + c[2]) / 3 - inside[2],
      ],
      a,
      b,
      c
    );

  // The body, ring to ring: each ring's points from the top, down the
  // right side, under, and back up the left.
  const { rings } = plan;

  const round = rings.map((ring) =>
    Array.from({ length: sides }, (_, k): Vec => {
      const angle = (k / sides) * Math.PI * 2;
      const rise = Math.cos(angle);

      return [
        ring.wide * Math.sin(angle),
        ring.y + rise * (rise > 0 ? ring.up : ring.down),
        ring.z,
      ];
    })
  );

  for (let i = 0; i < rings.length - 1; i++) {
    const { coat } = rings[i];

    const middle: Vec = [
      0,
      (rings[i].y + rings[i + 1].y) / 2,
      (rings[i].z + rings[i + 1].z) / 2,
    ];

    for (let k = 0; k < sides; k++) {
      // The same on the left as the right: the top two faces, the next
      // two down, and the rest, counted down from the shoulders.
      const down = Math.min(k, sides - 1 - k);
      const tone = coat ? pick(coat[Math.min(down, 2)], down - 2) : 0;
      const a = round[i][k];
      const b = round[i][(k + 1) % sides];
      const c = round[i + 1][(k + 1) % sides];
      const d = round[i + 1][k];

      const out: Vec = [
        (a[0] + b[0] + c[0] + d[0]) / 4 - middle[0],
        (a[1] + b[1] + c[1] + d[1]) / 4 - middle[1],
        (a[2] + b[2] + c[2] + d[2]) / 4 - middle[2],
      ];

      // A ring of no width is a point: one triangle to it, not two.
      if (rings[i].wide > 0) triangle(BODY, tone, out, a, b, c);

      if (rings[i + 1].wide > 0) triangle(BODY, tone, out, a, c, d);
    }
  }

  // The wings, each a sheet seen from above and another from below.
  const up: Vec = [0, 1, 0];
  const down: Vec = [0, -1, 0];
  const { wing } = plan;

  for (const side of [1, -1]) {
    const on = (p: Vec): Vec => [p[0] * side, p[1], p[2]];
    const lines = wing.lines.map((line) => line.map(on));
    const tip = on(wing.tip);
    const last = lines[0].length - 1;

    for (const [out, rows] of [
      [up, wing.above],
      [down, wing.below],
    ] as const) {
      rows.forEach((row, r) => {
        const front = lines[r];
        const back = lines[r + 1];

        for (let i = 0; i < last; i++) {
          const tone =
            i < wing.wrist ? pick(row.arm, i) : pick(row.hand, i - wing.wrist);

          triangle(WING, tone, out, front[i], front[i + 1], back[i + 1]);
          triangle(WING, tone, out, front[i], back[i + 1], back[i]);
        }

        triangle(
          WING,
          pick(row.hand, last - wing.wrist),
          out,
          front[last],
          tip,
          back[last]
        );
      });
    }
  }

  // The tail, fanned: above; and below, to a band at its end.
  const { tail } = plan;

  const along = (p: Vec): Vec => [
    tail.root[0] + (p[0] - tail.root[0]) * tail.band,
    tail.root[1] + (p[1] - tail.root[1]) * tail.band,
    tail.root[2] + (p[2] - tail.root[2]) * tail.band,
  ];

  for (let i = 0; i < tail.end.length - 1; i++) {
    const a = tail.end[i];
    const b = tail.end[i + 1];

    if (tail.edge === undefined) {
      triangle(BODY, pick(tail.above, i), up, tail.root, a, b);
    } else {
      triangle(BODY, pick(tail.above, i), up, tail.root, along(a), along(b));
      triangle(BODY, pick(tail.edge, i), up, along(a), a, b);
      triangle(BODY, pick(tail.edge, i), up, along(a), b, along(b));
    }

    triangle(BODY, pick(tail.under, i), down, tail.root, along(a), along(b));
    triangle(BODY, pick(tail.tip, i), down, along(a), a, b);
    triangle(BODY, pick(tail.tip, i), down, along(a), b, along(b));
  }

  plan.extras?.({
    ball(centre, radius, tone) {
      const ends = [0, 1, 2].flatMap((axis) =>
        [1, -1].map((way): Vec => {
          const p: Vec = [...centre];

          p[axis] += radius[axis] * way;

          return p;
        })
      );

      // An octahedron: each corner along x, with one along y and one along z.
      for (const x of [ends[0], ends[1]]) {
        for (const y of [ends[2], ends[3]]) {
          for (const z of [ends[4], ends[5]]) outward(tone, centre, x, y, z);
        }
      }
    },

    rod(from, to, radius, tone) {
      const axis = minus(to, from);
      // Across it: level, and square to that.
      const level = cross(axis, Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : up);
      const span = Math.hypot(...level) || 1;
      const a: Vec = [level[0] / span, level[1] / span, level[2] / span];
      const other = cross(axis, a);
      const reach = Math.hypot(...other) || 1;
      const b: Vec = [other[0] / reach, other[1] / reach, other[2] / reach];

      const corners = (at: Vec) =>
        [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ].map(([u, v]): Vec => [
          at[0] + (a[0] * u + b[0] * v) * radius,
          at[1] + (a[1] * u + b[1] * v) * radius,
          at[2] + (a[2] * u + b[2] * v) * radius,
        ]);

      const near = corners(from);
      const far = corners(to);

      const inside: Vec = [
        (from[0] + to[0]) / 2,
        (from[1] + to[1]) / 2,
        (from[2] + to[2]) / 2,
      ];

      for (let k = 0; k < 4; k++) {
        const n = (k + 1) % 4;
        outward(tone, inside, near[k], near[n], far[n]);
        outward(tone, inside, near[k], far[n], far[k]);
      }

      for (const end of [near, far]) {
        outward(tone, inside, end[0], end[1], end[2]);
        outward(tone, inside, end[0], end[2], end[3]);
      }
    },
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("part", new Float32BufferAttribute(parts, 1));
  geometry.setAttribute("paint", new Float32BufferAttribute(paints, 1));
  geometry.computeVertexNormals();

  return {
    geometry,
    shoulder: plan.shoulder,
    wrist: wing.lines[0][wing.wrist][0],
    painted: true,
  };
}
