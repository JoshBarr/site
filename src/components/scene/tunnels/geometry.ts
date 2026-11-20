import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  Vector3,
} from "three/webgpu";
import type { Point } from "../trains/network";
import { RAIL_TOP } from "../trains/network";
import type { Bore } from "./bores";

// The tunnels' insides and their portals, low poly. A bore's lining is its
// floor (the road with its lanes, or a track on its ballast), its walls and
// an arched roof with lamps along it, all facing inward: seen from outside,
// through the ground, the near side isn't in the way. A portal is a
// concrete headwall round a dark mouth, with a hood running back from it
// into the hill.

/** What a vertex of a lining is, for its `part` attribute. */
const LINING = 0;
export const ROAD = 1;
export const LAMP = 2;

/** Steps across the arch. */
const ARCH = 8;

/** Where across each arch's step falls, 0..1: closer together at the sides. */
const ACROSS = Array.from(
  { length: ARCH + 1 },
  (_, k) => (1 - Math.cos((Math.PI * k) / ARCH)) / 2
);

/**
 * The arch rises this much of the way across, at most this much of the
 * bore's height: the rest of the way up is wall.
 */
const RISE_ACROSS = 0.45;
const RISE_UP = 0.4;

const CONCRETE = new Color(0x7a7a7a);
const SOFFIT = new Color(0x505050);
const ASPHALT = new Color(0x464646);
const INVERT = new Color(0x525252);

/** The track, as it's laid outside (trains/geometry.ts). */
const BALLAST = new Color(0x7e7e7e);
const SLEEPERS = new Color(0x5e5e5e);
const RAIL_HEAD = new Color(0xb4b4b4);
const BALLAST_TOP = RAIL_TOP - 0.2;
const BALLAST_HALF_TOP = 1.4;
const BALLAST_HALF_TOE = 2.1;
const SLEEPER_HALF = 1.05;
const HALF_GAUGE = 0.535;
const RAIL_HALF = 0.06;

/** Lamps: this far apart along a bore, m, each this long and wide. */
export const LAMP_EVERY = 15;
const LAMP_LENGTH = 1.6;
const LAMP_WIDTH = 0.4;
const LAMP_TONE = new Color(1, 0.96, 0.88);

/** Which steps of the arch the two rows of lamps hang from. */
const LAMP_ROWS = [2, ARCH - 2];

/** A portal's headwall: above the crown, out past the walls, and down, m. */
const LINTEL = 1.3;
const WING = 2;
const FOOTING = 2;

/** It stands this far out from the end of the bore, m. */
const PROUD = 0.5;

/**
 * And its hood runs this far back, m, or this much of a short tunnel: over
 * what's driven in, till the hill is.
 */
const HOOD = 14;
const HOOD_SHARE = 0.3;

const MOUTH = new Color(0.004, 0.004, 0.004);
const HOOD_TOP = new Color(0x6c6c6c);

/** Portals are grouped in squares this wide, m, each drawn on its own. */
const CHUNK = 1500;

class Builder {
  position: number[] = [];
  color: number[] = [];
  /** Linings: across in lanes, along in m, lanes, 0. Portals: glow, 0, 0, 0. */
  mark: number[] = [];
  part: number[] = [];

  /**
   * A quad facing `toward`, whichever way round its corners are given.
   * `marks`, one for each corner.
   */
  quad(
    tone: Color,
    toward: Point,
    [a, b, c, d]: [Point, Point, Point, Point],
    part = LINING,
    marks: number[][] = []
  ) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];

    const facing =
      (uy * vz - uz * vy) * (toward[0] - a[0]) +
      (uz * vx - ux * vz) * (toward[1] - a[1]) +
      (ux * vy - uy * vx) * (toward[2] - a[2]);

    const order = facing >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    const corners = [a, b, c, d];

    for (const k of order) {
      this.position.push(...corners[k]);
      this.color.push(tone.r, tone.g, tone.b);
      this.mark.push(...(marks[k] ?? [0, 0, 0, 0]));
      this.part.push(part);
    }
  }

  geometry() {
    const geometry = new BufferGeometry();

    const set = (name: string, values: number[], size: number) =>
      geometry.setAttribute(
        name,
        new BufferAttribute(new Float32Array(values), size)
      );

    set("position", this.position, 3);
    set("color", this.color, 3);
    set("mark", this.mark, 4);
    set("part", this.part, 1);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    return geometry;
  }
}

const mixed = (a: Color, b: Color, t: number) => a.clone().lerp(b, t);

const lerp = (a: Point, b: Point, t: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** A bore cut across at one of its points. */
interface Section {
  /** A place `lateral` m right of the line and `up` from the floor. */
  at(lateral: number, up: number): Point;
  left: number;
  right: number;
  /** Where the walls stop and the arch springs from, above the floor. */
  spring: number;
  /** The arch from the left to the right, and how far up it each step is. */
  arch: Point[];
  up: number[];
  /** Somewhere inside, for its faces to look toward, and far overhead. */
  inside: Point;
  above: Point;
}

/**
 * `bore` cut across at point `i`. A side open to another bore has no wall,
 * and the arch rises over it to its crown, to meet the other's.
 */
function section(bore: Bore, i: number): Section {
  const [x, y, z] = bore.points[i];
  const [ax, az] = bore.across[i];
  const left = bore.left[i];
  const right = bore.right[i];
  const width = left + right;
  const openLeft = bore.openLeft[i];
  const openRight = bore.openRight[i];

  // A side shared, this is half of a tunnel twice as wide.
  const tunnel = openLeft || openRight ? width * 2 : width;
  const rise = Math.min(tunnel * RISE_ACROSS, bore.height * RISE_UP);
  const spring = bore.height - rise;

  const at = (lateral: number, up: number): Point => [
    x + ax * lateral,
    y + up,
    z + az * lateral,
  ];

  const up = ACROSS.map((u) => {
    if (openLeft && openRight) return 1;

    const off = openLeft ? u : openRight ? 1 - u : 2 * u - 1;

    return Math.sqrt(Math.max(1 - off * off, 0));
  });

  return {
    at,
    left,
    right,
    spring,
    arch: ACROSS.map((u, k) => at(-left + width * u, spring + rise * up[k])),
    up,
    inside: at((right - left) / 2, bore.height / 2),
    above: at(0, 1000),
  };
}

/** A track laid from one section to the next, on its ballast. */
function layTrack(b: Builder, from: Section, to: Section) {
  const above = from.above;

  const strip = (tone: Color, o0: number, u0: number, o1: number, u1: number) =>
    b.quad(tone, above, [
      from.at(o0, u0),
      to.at(o0, u0),
      to.at(o1, u1),
      from.at(o1, u1),
    ]);

  strip(BALLAST, -BALLAST_HALF_TOE, 0, -BALLAST_HALF_TOP, BALLAST_TOP);
  strip(BALLAST, BALLAST_HALF_TOP, BALLAST_TOP, BALLAST_HALF_TOE, 0);
  strip(BALLAST, -BALLAST_HALF_TOP, BALLAST_TOP, -SLEEPER_HALF, BALLAST_TOP);
  strip(BALLAST, SLEEPER_HALF, BALLAST_TOP, BALLAST_HALF_TOP, BALLAST_TOP);
  strip(SLEEPERS, -SLEEPER_HALF, BALLAST_TOP, SLEEPER_HALF, BALLAST_TOP);

  for (const side of [-1, 1]) {
    const c = side * HALF_GAUGE;
    strip(RAIL_HEAD, c - RAIL_HALF, RAIL_TOP, c + RAIL_HALF, RAIL_TOP);
  }
}

/** Lamps along the arch between two sections, `s0` and `s1` m along. */
function hangLamps(
  b: Builder,
  bore: Bore,
  from: Section,
  to: Section,
  s0: number,
  s1: number,
  i: number
) {
  const length = s1 - s0;

  if (length < 1e-3) return;
  const first = Math.ceil((s0 - LAMP_EVERY / 2) / LAMP_EVERY);

  for (let n = first; ; n++) {
    const s = LAMP_EVERY / 2 + n * LAMP_EVERY;

    if (s >= s1) break;

    if (s < s0) continue;
    const t = (s - s0) / length;
    const half = LAMP_LENGTH / 2 / length;

    for (const row of LAMP_ROWS) {
      // Only on a side with a wall: over the middle of a shared tunnel
      // there'd be a row down the join.
      const onLeft = row < ARCH / 2;

      if (onLeft ? bore.openLeft[i] : bore.openRight[i]) continue;

      const corners = [t - half, t + half].flatMap((u): Point[] => {
        const centre = lerp(from.arch[row], to.arch[row], u);
        const next = lerp(from.arch[row + 1], to.arch[row + 1], u);
        const last = lerp(from.arch[row - 1], to.arch[row - 1], u);
        const inside = lerp(from.inside, to.inside, u);

        const along = Math.hypot(
          next[0] - last[0],
          next[1] - last[1],
          next[2] - last[2]
        );

        const k = LAMP_WIDTH / 2 / (along || 1);

        // Just off the lining, toward the middle.
        const hung = lerp(centre, inside, 0.04);

        return [
          [
            hung[0] + (last[0] - next[0]) * k,
            hung[1] + (last[1] - next[1]) * k,
            hung[2] + (last[2] - next[2]) * k,
          ],
          [
            hung[0] + (next[0] - last[0]) * k,
            hung[1] + (next[1] - last[1]) * k,
            hung[2] + (next[2] - last[2]) * k,
          ],
        ];
      });

      b.quad(
        LAMP_TONE,
        lerp(from.inside, to.inside, t),
        [corners[0], corners[1], corners[3], corners[2]],
        LAMP
      );
    }
  }
}

/**
 * The insides of `bores` as one geometry: `color` is each face's own, and
 * `part` what it is, with `mark` where on the road a ROAD's is (see
 * roadColor) and, in y, how far along its bore anything is.
 */
export function createLinings(bores: Bore[]) {
  const b = new Builder();

  for (const bore of bores) {
    const sections = bore.points.map((_, i) => section(bore, i));

    const shoulder =
      (bore.left[0] + bore.right[0] - bore.lanes * bore.lane) / 2;

    for (let i = 0; i < sections.length - 1; i++) {
      const from = sections[i];
      const to = sections[i + 1];
      const s0 = bore.along[i];
      const s1 = bore.along[i + 1];
      const inside = from.inside;

      const along = [
        [0, s0, 0, 0],
        [0, s1, 0, 0],
      ];

      const lined = (tone: Color, corners: [Point, Point, Point, Point]) =>
        b.quad(tone, inside, corners, LINING, [
          along[0],
          along[1],
          along[1],
          along[0],
        ]);

      // The floor.
      const floor: [Point, Point, Point, Point] = [
        from.at(-from.left, 0),
        to.at(-to.left, 0),
        to.at(to.right, 0),
        from.at(from.right, 0),
      ];

      if (bore.kind === "road" && bore.lanes > 0) {
        const lanes = (section: Section, lateral: number) =>
          (lateral + section.left - shoulder) / bore.lane;

        b.quad(ASPHALT, inside, floor, ROAD, [
          [lanes(from, -from.left), s0, bore.lanes, 0],
          [lanes(to, -to.left), s1, bore.lanes, 0],
          [lanes(to, to.right), s1, bore.lanes, 0],
          [lanes(from, from.right), s0, bore.lanes, 0],
        ]);
      } else {
        lined(bore.kind === "road" ? ASPHALT : INVERT, floor);
      }

      if (bore.kind === "rail") layTrack(b, from, to);

      // The walls, where there's no bore alongside.
      if (!(bore.openLeft[i] && bore.openLeft[i + 1])) {
        lined(CONCRETE, [
          from.at(-from.left, 0),
          to.at(-to.left, 0),
          to.at(-to.left, to.spring),
          from.at(-from.left, from.spring),
        ]);
      }

      if (!(bore.openRight[i] && bore.openRight[i + 1])) {
        lined(CONCRETE, [
          from.at(from.right, 0),
          to.at(to.right, 0),
          to.at(to.right, to.spring),
          from.at(from.right, from.spring),
        ]);
      }

      // The arch, darker toward its crown.
      for (let k = 0; k < ARCH; k++) {
        lined(mixed(CONCRETE, SOFFIT, (from.up[k] + from.up[k + 1]) / 2), [
          from.arch[k],
          to.arch[k],
          to.arch[k + 1],
          from.arch[k + 1],
        ]);
      }

      hangLamps(b, bore, from, to, s0, s1, i);
    }
  }

  return b.geometry();
}

/** A square of portals: its world bounds, and its geometry. */
export interface PortalChunk {
  box: Box3;
  geometry: BufferGeometry;
}

/** A headwall, mouth and hood on the end of `bore` at point `i`. */
function buildPortal(b: Builder, bore: Bore, i: number, box: Box3) {
  const end = section(bore, i);
  const last = bore.points.length - 1;
  const [x, , z] = bore.points[i];
  const [nx, , nz] = bore.points[i === 0 ? 1 : last - 1];
  const length = Math.hypot(x - nx, z - nz) || 1;
  // Out of the tunnel, along the ground.
  const out: [number, number] = [(x - nx) / length, (z - nz) / length];

  /** A place on the headwall's face, or `back` m behind it. */
  const at = (lateral: number, up: number, back = 0): Point => {
    const [px, py, pz] = end.at(lateral, up);

    return [px + out[0] * (PROUD - back), py, pz + out[1] * (PROUD - back)];
  };

  const top = bore.height + LINTEL;
  const hood = Math.min(HOOD, bore.along[last] * HOOD_SHARE);
  const openLeft = bore.openLeft[i];
  const openRight = bore.openRight[i];
  const outer = -end.left - (openLeft ? 0 : WING);
  const inner = end.right + (openRight ? 0 : WING);
  const outside = at(0, bore.height / 2, -1000);
  const above = end.above;
  const width = end.left + end.right;

  const face = (tone: Color, corners: [Point, Point, Point, Point], glow = 0) =>
    b.quad(tone, outside, corners, LINING, [
      [glow, 0, 0, 0],
      [glow, 0, 0, 0],
      [glow, 0, 0, 0],
      [glow, 0, 0, 0],
    ]);

  // The mouth under the arch, and the headwall over it.
  for (let k = 0; k < ARCH; k++) {
    const l0 = -end.left + width * ACROSS[k];
    const l1 = -end.left + width * ACROSS[k + 1];
    const u0 = end.arch[k][1] - bore.points[i][1];
    const u1 = end.arch[k + 1][1] - bore.points[i][1];

    face(MOUTH, [at(l0, -0.2), at(l1, -0.2), at(l1, u1), at(l0, u0)], 1);
    face(CONCRETE, [at(l0, u0), at(l1, u1), at(l1, top), at(l0, top)]);
  }

  // Its wings, and the hood's sides running back from them.
  for (const [open, edge, wing] of [
    [openLeft, -end.left, outer],
    [openRight, end.right, inner],
  ] as const) {
    if (open) continue;
    face(CONCRETE, [
      at(wing, -FOOTING),
      at(edge, -FOOTING),
      at(edge, top),
      at(wing, top),
    ]);
    b.quad(CONCRETE, at(wing * 1000, 0), [
      at(wing, -FOOTING),
      at(wing, -FOOTING, hood),
      at(wing, top, hood),
      at(wing, top),
    ]);
  }

  // The hood's top.
  b.quad(HOOD_TOP, above, [
    at(outer, top),
    at(inner, top),
    at(inner, top, hood),
    at(outer, top, hood),
  ]);

  for (const lateral of [outer, inner]) {
    for (const back of [0, hood]) {
      box.expandByPoint(corner.set(...at(lateral, -FOOTING, back)));
      box.expandByPoint(corner.set(...at(lateral, top, back)));
    }
  }
}

const corner = new Vector3();

/**
 * The portals of `bores`, in squares: `color` each face's own, and `mark`'s
 * x 1 on the mouths.
 */
export function createPortals(bores: Bore[]): PortalChunk[] {
  const cells = new Map<string, { b: Builder; box: Box3 }>();

  for (const bore of bores) {
    const last = bore.points.length - 1;

    for (const [end, i] of [
      [0, 0],
      [1, last],
    ] as const) {
      if (!bore.portals[end] || last < 1) continue;
      const [x, , z] = bore.points[i];
      const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
      let cell = cells.get(key);

      if (!cell) cells.set(key, (cell = { b: new Builder(), box: new Box3() }));
      buildPortal(cell.b, bore, i, cell.box);
    }
  }

  return [...cells.values()].map(({ b, box }) => ({
    box,
    geometry: b.geometry(),
  }));
}
