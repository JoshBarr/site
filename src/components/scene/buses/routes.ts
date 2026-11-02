import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import type { Point } from "../trains/network";

// Metlink's bus routes, from public/buses/routes.json (built by
// scripts/buses/build_routes.mjs): the roads each route's trips drive, as
// polylines a bus can be put on and run along, without a road network.

export const BUSES_URL = process.env.NEXT_PUBLIC_BUSES_URL ?? "/buses";

interface RoutesFile {
  chains: number[][];
  shapes: number[][];
  routes: Record<string, { name: string; directions: number[][] }>;
}

/** Grid cell for finding a shape's segments near a point, m. */
const CELL = 50;

/** A way a route's trips go: world points, and the distance along at each. */
export interface Shape {
  points: Point[];
  s: number[];
}

/** A place a point could be on a shape. */
export interface Projection {
  /** Distance along the shape. */
  s: number;
  /** From the point, m, across the ground. */
  distance: number;
  /** Unit world x/z the shape runs, there. */
  along: [number, number];
}

/** A shape with its segments in a grid, for finding where points are on it. */
export class IndexedShape implements Shape {
  readonly points: Point[];
  readonly s: number[];
  private grid = new Map<string, number[]>();

  constructor(points: Point[]) {
    this.points = points;
    this.s = [0];
    for (let i = 1; i < points.length; i++) {
      const [ax, ay, az] = points[i - 1];
      const [bx, by, bz] = points[i];
      this.s.push(this.s[i - 1] + Math.hypot(bx - ax, by - ay, bz - az));
      for (
        let gx = Math.floor(Math.min(ax, bx) / CELL);
        gx <= Math.floor(Math.max(ax, bx) / CELL);
        gx++
      ) {
        for (
          let gz = Math.floor(Math.min(az, bz) / CELL);
          gz <= Math.floor(Math.max(az, bz) / CELL);
          gz++
        ) {
          const key = `${gx},${gz}`;
          if (!this.grid.has(key)) this.grid.set(key, []);
          this.grid.get(key)!.push(i - 1);
        }
      }
    }
  }

  get length() {
    return this.s[this.s.length - 1];
  }

  /**
   * Where a point could be on the shape, within `radius` across the ground:
   * the nearest place on each pass the shape makes by it, nearest first.
   */
  near(x: number, z: number, radius: number): Projection[] {
    const found: Projection[] = [];
    const seen = new Set<number>();
    for (
      let gx = Math.floor((x - radius) / CELL);
      gx <= Math.floor((x + radius) / CELL);
      gx++
    ) {
      for (
        let gz = Math.floor((z - radius) / CELL);
        gz <= Math.floor((z + radius) / CELL);
        gz++
      ) {
        for (const i of this.grid.get(`${gx},${gz}`) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const [ax, , az] = this.points[i];
          const [bx, , bz] = this.points[i + 1];
          const dx = bx - ax;
          const dz = bz - az;
          const length = Math.hypot(dx, dz);
          if (length < 1e-6) continue;
          const t = Math.min(
            Math.max(((x - ax) * dx + (z - az) * dz) / length ** 2, 0),
            1
          );
          const distance = Math.hypot(x - ax - dx * t, z - az - dz * t);
          if (distance > radius) continue;
          found.push({
            s: this.s[i] + (this.s[i + 1] - this.s[i]) * t,
            distance,
            along: [dx / length, dz / length],
          });
        }
      }
    }

    // Neighbouring segments find the same place: keep the nearest of each
    // run along the shape.
    found.sort((a, b) => a.s - b.s);
    const passes: Projection[] = [];
    for (const p of found) {
      const last = passes[passes.length - 1];
      if (last && p.s - last.s < radius * 2) {
        if (p.distance < last.distance) passes[passes.length - 1] = p;
      } else passes.push(p);
    }
    return passes.sort((a, b) => a.distance - b.distance);
  }
}

export class BusRoutes {
  private chains: Point[][];
  private encoded: number[][];
  private shapes = new Map<number, IndexedShape>();
  private routes: RoutesFile["routes"];

  constructor(file: RoutesFile, index: TileIndex) {
    const { manifest } = index;
    const scale = verticalScale.value;
    let previous = [0, 0, 0];
    this.chains = file.chains.map((deltas) => {
      const points: Point[] = [];
      let last = previous;
      for (let k = 0; k < deltas.length; k += 3) {
        const q = [
          last[0] + deltas[k],
          last[1] + deltas[k + 1],
          last[2] + deltas[k + 2],
        ];
        if (k === 0) previous = q;
        last = q;
        const [x, z] = nztmToWorld(manifest, q[0] / 10, q[1] / 10);
        points.push([x, (q[2] / 10) * scale, z]);
      }
      return points;
    });
    this.encoded = file.shapes;
    this.routes = file.routes;
  }

  /** A shape, put together from its chains the first time it's wanted. */
  private shape(i: number) {
    let shape = this.shapes.get(i);
    if (!shape) {
      const points: Point[] = [];
      let ref = 0;
      for (const delta of this.encoded[i]) {
        ref += delta;
        const chain = this.chains[Math.abs(ref) - 1];
        const along = ref > 0 ? chain : [...chain].reverse();
        points.push(...(points.length ? along.slice(1) : along));
      }
      shape = new IndexedShape(points);
      this.shapes.set(i, shape);
    }
    return shape;
  }

  /** What a route's called on the front of the bus. */
  nameOf(route: string) {
    return this.routes[route]?.name ?? route;
  }

  /** The ways a route's trips go in a direction, or none if it's unknown. */
  shapesFor(route: string, direction: number): IndexedShape[] {
    const shapes = this.routes[route]?.directions[direction ? 1 : 0] ?? [];
    return shapes.map((i) => this.shape(i));
  }
}

export async function loadBusRoutes(index: TileIndex) {
  const response = await fetch(`${BUSES_URL}/routes.json`);
  if (!response.ok) throw new Error(`bus routes: ${response.status}`);
  return new BusRoutes((await response.json()) as RoutesFile, index);
}
