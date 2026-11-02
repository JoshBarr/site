import { Box3, BufferAttribute, BufferGeometry, Vector3 } from "three/webgpu";
import type { Carriageway, Roads } from "./roads";

// The highways' surfaces, low poly, in chunks: each carriageway's lanes as
// a strip a little above the ground, with shoulders sunk into it and decks
// over bridges, and a headwall with a dark mouth where it goes into a
// tunnel. Lane markings are drawn by the material from `mark`.

/** Parts of the road and vehicles, for their `part` attribute. */
export const ASPHALT = 0;
export const CONCRETE = 1;
export const MOUTH = 2;
export const BODY = 3;
export const GLASS = 4;
export const DARK = 5;
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
/** A tunnel mouth's height, and its headwall's, above the road, m. */
const MOUTH_HEIGHT = 5.5;
const HEADWALL = 8;
/** Headwalls stand out this far either side of the road, and down. */
const WING = 2;
const FOOTING = 2;

/** Road built in square chunks this wide, m, each on its own. */
const CHUNK = 1500;

type Point = [number, number, number];

/** A square of road: its world bounds, and its geometry when wanted. */
export interface RoadChunk {
  box: Box3;
  build(): BufferGeometry;
}

interface Segment {
  road: Carriageway;
  i: number;
}

interface Portal {
  road: Carriageway;
  /** The point at the tunnel's mouth. */
  i: number;
  /** Which way out of the tunnel it faces: 1 back along, -1 on along. */
  facing: number;
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

function buildSegment(b: Builder, roads: Roads, { road, i }: Segment) {
  const { bridge, twoWay } = roads.flags;
  const j = i + 1;
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

  if (road.flags[i] & bridge) {
    // Parapets on the outer edges, the deck's sides and underneath.
    const sides: [number, number][] = [[ei.left, ej.left]];
    if (!ei.shared) sides.push([ei.right, ej.right]);
    for (const [a, c] of sides) {
      strip(CONCRETE, a, 0, c, 0, a, PARAPET, c, PARAPET);
      strip(CONCRETE, a, -DECK, c, -DECK, a, 0, c, 0);
    }
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

function buildPortal(b: Builder, roads: Roads, { road, i, facing }: Portal) {
  const e = edges(road, i, roads.flags.twoWay);
  const outer = e.left - WING;
  const inner = e.shared ? e.right : e.right + WING;
  // Pushed out of the tunnel a little, so it stands in front of the mouth.
  const k = Math.min(Math.max(i, 0), road.count - 1);
  const tx =
    road.x[Math.min(k + 1, road.count - 1)] - road.x[Math.max(k - 1, 0)];
  const tz =
    road.z[Math.min(k + 1, road.count - 1)] - road.z[Math.max(k - 1, 0)];
  const l = Math.hypot(tx, tz) || 1;
  const ox = (tx / l) * facing * 0.5;
  const oz = (tz / l) * facing * 0.5;
  const p = (lateral: number, up: number): Point => {
    const [x, y, z] = at(road, i, lateral, up);
    return [x + ox, y, z + oz];
  };
  const wall = (part: number, a: number, c: number, lo: number, hi: number) =>
    b.quad(part, p(a, lo), p(c, lo), p(c, hi), p(a, hi));

  wall(MOUTH, e.left, e.right, -0.2, MOUTH_HEIGHT);
  wall(CONCRETE, outer, e.left, -FOOTING, HEADWALL);
  if (!e.shared) wall(CONCRETE, e.right, inner, -FOOTING, HEADWALL);
  wall(CONCRETE, e.left, e.right, MOUTH_HEIGHT, HEADWALL);
  // Its top.
  const back = (lateral: number): Point => {
    const [x, y, z] = p(lateral, HEADWALL);
    return [x - ox * 2, y, z - oz * 2];
  };
  b.quad(
    CONCRETE,
    p(outer, HEADWALL),
    p(inner, HEADWALL),
    back(inner),
    back(outer)
  );
}

/** Every carriageway's surface and tunnel mouths, in chunks. */
export function createRoadChunks(roads: Roads): RoadChunk[] {
  const { tunnel } = roads.flags;
  const cells = new Map<
    string,
    { box: Box3; segments: Segment[]; portals: Portal[] }
  >();
  const cellAt = (x: number, z: number) => {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { box: new Box3(), segments: [], portals: [] };
      cells.set(key, cell);
    }
    return cell;
  };
  const corner = new Vector3();
  const grow = (cell: { box: Box3 }, road: Carriageway, i: number) => {
    const r = 20;
    cell.box.expandByPoint(
      corner.set(road.x[i] - r, road.y[i] - FOOTING - 2, road.z[i] - r)
    );
    cell.box.expandByPoint(
      corner.set(road.x[i] + r, road.y[i] + HEADWALL, road.z[i] + r)
    );
  };

  for (const road of roads.carriageways) {
    for (let i = 0; i < road.count - 1; i++) {
      const inTunnel = (road.flags[i] & tunnel) !== 0;
      const before = i > 0 && (road.flags[i - 1] & tunnel) !== 0;
      // Mouths: where it goes in, and comes out.
      if (inTunnel && !before && i > 0) {
        const cell = cellAt(road.x[i], road.z[i]);
        cell.portals.push({ road, i, facing: -1 });
        grow(cell, road, i);
      }
      if (!inTunnel && before) {
        const cell = cellAt(road.x[i], road.z[i]);
        cell.portals.push({ road, i, facing: 1 });
        grow(cell, road, i);
      }
      if (inTunnel) continue;
      const cell = cellAt(
        (road.x[i] + road.x[i + 1]) / 2,
        (road.z[i] + road.z[i + 1]) / 2
      );
      cell.segments.push({ road, i });
      grow(cell, road, i);
      grow(cell, road, i + 1);
    }
  }

  return [...cells.values()].map(({ box, segments, portals }) => ({
    box,
    build: () => {
      const b = new Builder();
      for (const segment of segments) buildSegment(b, roads, segment);
      for (const portal of portals) buildPortal(b, roads, portal);
      return b.geometry();
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
  return b.geometry();
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
  return b.geometry();
}
