import { Color, DoubleSide, Mesh, ShapeUtils, Vector2 } from "three/webgpu";
import { castsNearShadow } from "../landmarks/nearShadow";
import { createModelMaterial } from "../models/lod";
import { ModelBuilder, Vec, WINDOW_GLOW } from "../models/builder";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import type { CarWay } from "./line";

// The top terminus at Kelburn, which the cars stand in at the top: its
// outline from OpenStreetMap (way 643265133; WCC's model of it was one
// block with the line below, and is left out of the buildings). Glass all
// round above a solid base, so a car's seen inside, and an opening where
// the track comes in at the downhill end. It follows the grade, as the
// track does. Heights are guessed, but for the roof's: the lidar has it
// ~6.5 m up, which is high enough to see in under it.

/** The outline, NZTM. */
const OUTLINE: [number, number][] = [
  [1748012.3, 5428058.8],
  [1748012.6, 5428056.9],
  [1748013.5, 5428052.5],
  [1748013.8, 5428051.2],
  [1748020.8, 5428052.5],
  [1748021.2, 5428050.6],
  [1748026.9, 5428051.6],
  [1748031.3, 5428052.5],
  [1748030.9, 5428054.5],
  [1748039.5, 5428056.1],
  [1748042.1, 5428056.6],
  [1748042.2, 5428056.9],
  [1748041.6, 5428060.4],
  [1748040.9, 5428063.6],
  [1748039.9, 5428068.9],
  [1748026.9, 5428064.2],
  [1748026.9, 5428064.8],
  [1748025.2, 5428064.5],
  [1748023.9, 5428064.2],
  [1748023.9, 5428063.1],
];

// Heights above the track bed beside each point, m.
const BASE_TOP = 0.9;
const GLASS_TOP = 5.7;
const EAVES = 6.2;
const ROOF_TOP = 6.5;

/** Walls go this far below the bed, into the hillside, m. */
const FOOTING = 10;

/** Where the track comes in: this close to it, m, and this high. */
const DOOR_HALF_WIDTH = 2;
const DOOR_HEIGHT = 4;

/** m. */
const WALL = 0.25;
const MULLION = 0.12;
const MULLION_SPACING = 2.5;

/** Walls are classed (glass or door) in steps this long, m. */
const STEP = 0.25;

/**
 * Barely there, and pale: under the roof the car's in shade, and dark
 * glass over that hides it.
 */
const GLASS_OPACITY = 0.15;

const CONCRETE = 0x8a8a8a;
const FRAME = 0x5a5a5a;
const ROOF = 0x9a9a9a;
const GLASS = 0xb4b4b4;
const NIGHT_GLOW = new Color(WINDOW_GLOW).multiplyScalar(0.4).getHex();

type Point = [x: number, z: number];

/** The nearest point of `way` (world x/z) to (x, z): its distance and bed. */
function nearest(way: CarWay, x: number, z: number) {
  let best = { distance: Infinity, bed: 0 };

  for (let k = 1; k < way.points.length; k++) {
    const a = way.points[k - 1];
    const b = way.points[k];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const along = ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1);
    const u = Math.min(Math.max(along, 0), 1);
    const distance = Math.hypot(x - a.x - u * dx, z - a.z - u * dz);

    if (distance < best.distance) {
      best = { distance, bed: a.y + (b.y - a.y) * u };
    }
  }

  return best;
}

function inside(ring: Point[], [x, z]: Point) {
  let within = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];

    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      within = !within;
    }
  }

  return within;
}

/**
 * The terminus on the cable car's line, `way` (either car's: they share
 * the track at the top). Two meshes: the building, and its glass.
 */
export function createTerminal(index: TileIndex, way: CarWay) {
  const ring = OUTLINE.map(([e, n]) => nztmToWorld(index.manifest, e, n));
  const bed = ([x, z]: Point) => nearest(way, x, z).bed;
  const solid = new ModelBuilder();
  const glass = new ModelBuilder();
  // Lit dimly, so the car's own windows show through at night.
  glass.use(GLASS, NIGHT_GLOW);

  /** A wall from `p` to `q`, between heights above the bed there. */
  const wall = (
    b: ModelBuilder,
    p: Point,
    q: Point,
    from: number,
    to: number,
    inward: Point
  ) => {
    const [bp, bq] = [bed(p), bed(q)];

    b.slab(
      [
        [p[0], bp + from, p[1]],
        [q[0], bq + from, q[1]],
        [q[0], bq + to, q[1]],
        [p[0], bp + to, p[1]],
      ],
      [inward[0] * WALL, 0, inward[1] * WALL]
    );
  };

  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);

    if (length < 1e-3) return;

    const ux = (b[0] - a[0]) / length;
    const uz = (b[1] - a[1]) / length;
    const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let inward: Point = [-uz, ux];

    if (
      !inside(ring, [middle[0] + inward[0] * 0.1, middle[1] + inward[1] * 0.1])
    ) {
      inward = [uz, -ux];
    }

    const at = (s: number): Point => [a[0] + ux * s, a[1] + uz * s];
    const steps = Math.max(Math.ceil(length / STEP), 1);

    const door = (k: number) => {
      const [x, z] = at(((k + 0.5) / steps) * length);

      return nearest(way, x, z).distance < DOOR_HALF_WIDTH;
    };

    // Runs of glass and of doorway along the edge.
    for (let k = 0; k < steps;) {
      const open = door(k);
      let end = k + 1;

      while (end < steps && door(end) === open) end++;
      const p = at((k / steps) * length);
      const q = at((end / steps) * length);
      k = end;

      solid.use(CONCRETE);
      wall(solid, p, q, -FOOTING, open ? 0 : BASE_TOP, inward);
      solid.use(FRAME);

      if (open) {
        wall(solid, p, q, DOOR_HEIGHT, ROOF_TOP, inward);
        continue;
      }

      wall(glass, p, q, BASE_TOP, GLASS_TOP, inward);
      wall(solid, p, q, GLASS_TOP, ROOF_TOP, inward);
      const run = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const mullions = Math.max(Math.round(run / MULLION_SPACING), 1);

      const along = (d: number): Point => [
        p[0] + ((q[0] - p[0]) * d) / run,
        p[1] + ((q[1] - p[1]) * d) / run,
      ];

      for (let m = 0; m <= mullions; m++) {
        const s = (m / mullions) * run;
        const from = Math.max(s - MULLION / 2, 0);
        const to = Math.min(s + MULLION / 2, run);
        wall(solid, along(from), along(to), BASE_TOP, GLASS_TOP, inward);
      }
    }
  });

  // The roof, following the grade.
  solid.use(ROOF);
  const outline = ring.map(([x, z]) => new Vector2(x, z));

  for (const [i, j, k] of ShapeUtils.triangulateShape(outline, [])) {
    const corners = [ring[i], ring[j], ring[k]];

    for (const [height, side] of [
      [ROOF_TOP, -1],
      [EAVES, 1],
    ]) {
      const [p, q, r] = corners.map((c): Vec => [c[0], bed(c) + height, c[1]]);

      const centre: Vec = [
        (p[0] + q[0] + r[0]) / 3,
        (p[1] + q[1] + r[1]) / 3 + side,
        (p[2] + q[2] + r[2]) / 3,
      ];

      solid.triangle(centre, p, q, r);
    }
  }

  const building = createModelMaterial({ roughness: 0.8 });
  const panes = createModelMaterial({ roughness: 0.1 });
  panes.material.transparent = true;
  panes.material.opacity = GLASS_OPACITY;
  panes.material.depthWrite = false;
  // Its far side's seen through its near.
  panes.material.side = DoubleSide;

  const body = new Mesh(solid.build(), building.material);
  castsNearShadow(body);
  const windows = new Mesh(glass.build(), panes.material);

  return {
    body,
    windows,
    /** Lights its windows, 0 by day to 1 at night. */
    light(lit: number) {
      building.lit.value = panes.lit.value = lit;
    },
    dispose() {
      body.geometry.dispose();
      windows.geometry.dispose();
      building.material.dispose();
      panes.material.dispose();
    },
  };
}
