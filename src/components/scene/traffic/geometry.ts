import { Box3, BufferAttribute, BufferGeometry, Vector3 } from "three/webgpu";
import type { Carriageway, Roads } from "./roads";

// The highways' surfaces, low poly, in chunks: each carriageway's lanes as
// a strip a little above the ground, with shoulders sunk into it, and decks
// over bridges, on piers where there's room under them and walled in at
// their abutments. Nothing's laid through tunnels: those have their own
// floors (see tunnels/). Lane markings are drawn by the material from
// `mark`.

/** Parts of the road and vehicles, for their `part` attribute. */
export const ASPHALT = 0;
const CONCRETE = 1;
export const BODY = 3;
export const GLASS = 4;
const DARK = 5;

/** A truck's box, paler than its cab. */
export const BOX = 6;

/** Sealed beyond the outer lanes, m: open road and town. */
const SHOULDER = 1.2;
const TOWN_SHOULDER = 0.4;

/** Shoulders slope down into the ground over this, m across and down. */
const SKIRT = 1.2;

/** A bridge deck's depth and parapets' height, m. */
const DECK = 1.4;
const PARAPET = 0.9;

/**
 * Further above the ground than its skirts reach, m, the road's on a
 * structure, whether or not the map calls it a bridge: the bare earth dips
 * at an abutment, and the road doesn't.
 */
const LIFTED = SKIRT;

/**
 * A deck this near the ground, m, is walled in down to it: its abutments.
 * Higher, it stands on piers this far apart, m along, each this share of
 * the carriageway across and this long, sunk this far into the ground.
 */
const ABUTMENT = 4;
const PIER_SPACING = 32;
const PIER_ACROSS = 0.6;
const PIER_ALONG = 1.6;
const SUNK = 2;

/** Road built in square chunks this wide, m, each on its own. */
const CHUNK = 1500;

type Point = [number, number, number];

/**
 * A square of road: its world bounds, and its geometry when wanted, the
 * road on the ground apart from the decks, which cast shadows. Either's
 * null where the square has none.
 */
export interface RoadChunk {
  box: Box3;
  build(): { ground: BufferGeometry | null; decks: BufferGeometry | null };
}

interface Segment {
  road: Carriageway;
  i: number;
}

class Builder {
  position: number[] = [];
  part: number[] = [];
  mark: number[] = [];

  triangle(part: number, mark: number[][], ...points: Point[]) {
    points.forEach((p, k) => {
      this.position.push(...p);
      this.part.push(part);
      this.mark.push(...(mark[k] ?? [0, 0, 0, 0]));
    });
  }

  quad(
    part: number,
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    marks: number[][] = []
  ) {
    this.triangle(part, [marks[0], marks[1], marks[2]], a, b, c);
    this.triangle(part, [marks[0], marks[2], marks[3]], a, c, d);
  }

  geometry() {
    if (!this.position.length) return null;

    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(this.position), 3)
    );
    geometry.setAttribute(
      "part",
      new BufferAttribute(new Float32Array(this.part), 1)
    );
    geometry.setAttribute(
      "mark",
      new BufferAttribute(new Float32Array(this.mark), 4)
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    return geometry;
  }
}

/** Across this carriageway's surface at point i: its edges, m from the line. */
function edges(road: Carriageway, i: number, twoWay: number) {
  const kerb = road.kerbAt(i);
  const lanes = road.lanes[i] * road.laneWidth[i];
  const shoulder = road.laneWidth[i] > 3.4 ? SHOULDER : TOWN_SHOULDER;
  const shared = (road.flags[i] & twoWay) !== 0;

  return {
    kerb,
    left: kerb - shoulder,
    right: kerb + lanes + (shared ? 0 : shoulder),
    shared,
  };
}

const at = (
  road: Carriageway,
  i: number,
  lateral: number,
  up: number
): Point => [
  road.x[i] + road.rightX[i] * lateral,
  road.y[i] + up,
  road.z[i] + road.rightZ[i] * lateral,
];

/** How far down a deck's sides go at point i, m: to the ground, near it. */
const sideDepth = (road: Carriageway, i: number) =>
  road.clear[i] < ABUTMENT ? Math.max(DECK, road.clear[i] + SUNK) : DECK;

/**
 * Piers under the deck from point i to the next, wherever one's due along
 * the carriageway and the deck's clear of its abutments.
 */
function buildPiers(b: Builder, road: Carriageway, i: number) {
  const j = i + 1;
  const length = road.s[j] - road.s[i];

  for (
    let s = Math.ceil(road.s[i] / PIER_SPACING) * PIER_SPACING;
    s < road.s[j];
    s += PIER_SPACING
  ) {
    const t = (s - road.s[i]) / length;
    const mix = (a: Float32Array) => a[i] + (a[j] - a[i]) * t;
    const clear = mix(road.clear);

    if (clear < ABUTMENT) continue;

    const width = road.lanes[i] * road.laneWidth[i];
    const middle = road.kerbAt(i) + width / 2;
    const across = (width * PIER_ACROSS) / 2;
    const along = PIER_ALONG / 2;
    // Along the road, and to its right.
    const ax = (road.x[j] - road.x[i]) / length;
    const az = (road.z[j] - road.z[i]) / length;
    const rx = mix(road.rightX);
    const rz = mix(road.rightZ);
    const x = mix(road.x) + rx * middle;
    const y = mix(road.y);
    const z = mix(road.z) + rz * middle;

    const corner = (r: number, a: number, up: number): Point => [
      x + rx * r * across + ax * a * along,
      y + up,
      z + rz * r * across + az * a * along,
    ];

    const top = -DECK;
    const bottom = -clear - SUNK;

    const ring: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];

    ring.forEach(([r0, a0], k) => {
      const [r1, a1] = ring[(k + 1) % ring.length];

      b.quad(
        CONCRETE,
        corner(r0, a0, bottom),
        corner(r1, a1, bottom),
        corner(r1, a1, top),
        corner(r0, a0, top)
      );
    });
  }
}

function buildSegment(
  ground: Builder,
  decks: Builder,
  roads: Roads,
  { road, i }: Segment
) {
  const { bridge, twoWay } = roads.flags;
  const j = i + 1;

  const structure =
    (road.flags[i] & bridge) !== 0 ||
    road.clear[i] > LIFTED ||
    road.clear[j] > LIFTED;

  const b = structure ? decks : ground;
  const ei = edges(road, i, twoWay);
  const ej = edges(road, j, twoWay);
  const w = road.laneWidth[i];

  // Across in lanes from the kerb edge, along, lanes, two-way.
  const markAt = (k: number, lateral: number, kerb: number) => [
    (lateral - kerb) / w,
    road.s[k],
    road.lanes[i],
    ei.shared ? 1 : 0,
  ];

  const strip = (
    part: number,
    li: number,
    ui: number,
    lj: number,
    uj: number,
    li2: number,
    ui2: number,
    lj2: number,
    uj2: number
  ) =>
    b.quad(
      part,
      at(road, i, li, ui),
      at(road, j, lj, uj),
      at(road, j, lj2, uj2),
      at(road, i, li2, ui2),
      [
        markAt(i, li, ei.kerb),
        markAt(j, lj, ej.kerb),
        markAt(j, lj2, ej.kerb),
        markAt(i, li2, ei.kerb),
      ]
    );

  // The surface.
  strip(ASPHALT, ei.left, 0, ej.left, 0, ei.right, 0, ej.right, 0);

  if (structure) {
    // Parapets on the outer edges, the deck's sides and underneath.
    const sides: [number, number][] = [[ei.left, ej.left]];

    if (!ei.shared) sides.push([ei.right, ej.right]);

    const di = -sideDepth(road, i);
    const dj = -sideDepth(road, j);

    for (const [a, c] of sides) {
      strip(CONCRETE, a, 0, c, 0, a, PARAPET, c, PARAPET);
      strip(CONCRETE, a, di, c, dj, a, 0, c, 0);
    }

    buildPiers(b, road, i);

    strip(
      CONCRETE,
      ei.left,
      -DECK,
      ej.left,
      -DECK,
      ei.right,
      -DECK,
      ej.right,
      -DECK
    );
  } else {
    // Shoulders sloping down into the ground, so the road sits in it.
    strip(
      CONCRETE,
      ei.left - SKIRT,
      -SKIRT,
      ej.left - SKIRT,
      -SKIRT,
      ei.left,
      0,
      ej.left,
      0
    );

    if (!ei.shared) {
      strip(
        CONCRETE,
        ei.right,
        0,
        ej.right,
        0,
        ei.right + SKIRT,
        -SKIRT,
        ej.right + SKIRT,
        -SKIRT
      );
    }
  }
}

/** Every carriageway's surface out of the tunnels, in chunks. */
export function createRoadChunks(roads: Roads): RoadChunk[] {
  const { tunnel } = roads.flags;

  const cells = new Map<string, { box: Box3; segments: Segment[] }>();

  const cellAt = (x: number, z: number) => {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let cell = cells.get(key);

    if (!cell) {
      cell = { box: new Box3(), segments: [] };
      cells.set(key, cell);
    }

    return cell;
  };

  const corner = new Vector3();

  const grow = (cell: { box: Box3 }, road: Carriageway, i: number) => {
    const r = 20;
    cell.box.expandByPoint(
      corner.set(
        road.x[i] - r,
        road.y[i] - Math.max(DECK, road.clear[i]) - SUNK,
        road.z[i] - r
      )
    );
    cell.box.expandByPoint(
      corner.set(road.x[i] + r, road.y[i] + PARAPET, road.z[i] + r)
    );
  };

  for (const road of roads.carriageways) {
    for (let i = 0; i < road.count - 1; i++) {
      if (road.flags[i] & tunnel) continue;

      const cell = cellAt(
        (road.x[i] + road.x[i + 1]) / 2,
        (road.z[i] + road.z[i + 1]) / 2
      );

      cell.segments.push({ road, i });
      grow(cell, road, i);
      grow(cell, road, i + 1);
    }
  }

  return [...cells.values()].map(({ box, segments }) => ({
    box,
    build: () => {
      const ground = new Builder();
      const decks = new Builder();

      for (const segment of segments) {
        buildSegment(ground, decks, roads, segment);
      }

      return { ground: ground.geometry(), decks: decks.geometry() };
    },
  }));
}

/**
 * A unit car, flat shaded: x across, y up from the road, z along (+z
 * forward), each -0.5..0.5 (y 0..1). A body, and a glasshouse on top with
 * a raked windscreen.
 */
export function createCarGeometry() {
  const b = new Builder();

  const box = (
    part: number,
    x: number,
    y0: number,
    y1: number,
    back: [number, number],
    front: [number, number],
    top = x
  ) => {
    // back/front: z at the bottom and top of each end.
    const [bb, bt] = back;
    const [fb, ft] = front;
    const p = (sx: number, y: number, z: number): Point => [sx, y, z];
    // Sides.
    b.quad(part, p(x, y0, fb), p(x, y0, bb), p(top, y1, bt), p(top, y1, ft));
    b.quad(
      part,
      p(-x, y0, bb),
      p(-x, y0, fb),
      p(-top, y1, ft),
      p(-top, y1, bt)
    );
    // Front and back.
    b.quad(part, p(-x, y0, fb), p(x, y0, fb), p(top, y1, ft), p(-top, y1, ft));
    b.quad(part, p(x, y0, bb), p(-x, y0, bb), p(-top, y1, bt), p(top, y1, bt));
    // Top and bottom.
    b.quad(
      part === GLASS ? BODY : part,
      p(top, y1, ft),
      p(top, y1, bt),
      p(-top, y1, bt),
      p(-top, y1, ft)
    );
    b.quad(DARK, p(-x, y0, fb), p(-x, y0, bb), p(x, y0, bb), p(x, y0, fb));
  };

  box(DARK, 0.42, 0, 0.14, [-0.4, -0.4], [0.4, 0.4]);
  box(BODY, 0.5, 0.14, 0.56, [-0.5, -0.5], [0.5, 0.48]);
  box(GLASS, 0.47, 0.56, 1, [-0.4, -0.3], [0.24, 0.08], 0.42);

  return b.geometry()!;
}

/** A unit truck, as the car: a cab, and a box behind it. */
export function createTruckGeometry() {
  const b = new Builder();

  const box = (
    part: number,
    x: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number
  ) => {
    const p = (sx: number, y: number, z: number): Point => [sx, y, z];
    b.quad(part, p(x, y0, z1), p(x, y0, z0), p(x, y1, z0), p(x, y1, z1));
    b.quad(part, p(-x, y0, z0), p(-x, y0, z1), p(-x, y1, z1), p(-x, y1, z0));
    b.quad(part, p(-x, y0, z1), p(x, y0, z1), p(x, y1, z1), p(-x, y1, z1));
    b.quad(part, p(x, y0, z0), p(-x, y0, z0), p(-x, y1, z0), p(x, y1, z0));
    b.quad(
      part === GLASS ? BODY : part,
      p(x, y1, z1),
      p(x, y1, z0),
      p(-x, y1, z0),
      p(-x, y1, z1)
    );
  };

  box(DARK, 0.45, 0, 0.12, -0.48, 0.48);
  box(BODY, 0.5, 0.12, 0.5, 0.33, 0.5);
  box(GLASS, 0.49, 0.5, 0.78, 0.36, 0.5);
  box(BOX, 0.5, 0.15, 1, -0.5, 0.31);

  return b.geometry()!;
}
