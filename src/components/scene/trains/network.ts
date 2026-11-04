import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";

// The railway as a graph, from public/rail/network.json (built by
// scripts/trains/build_rail.mjs): where trains can be put and how they get
// from one fix to the next.

export const RAIL_URL = process.env.NEXT_PUBLIC_RAIL_URL ?? "/rail";

/** Railhead above the track bed (the smoothed ground), m. */
export const RAIL_TOP = 0.65;

export interface NetworkFile {
  flags: { tunnel: number; bridge: number; model: number };
  nodes: number[];
  ways: number[][];
  platforms: { ground: number; ring: [number, number][] }[];
}

/** A point on a track: along `edge`, `t` of the way from its start. */
export interface Snap {
  edge: number;
  t: number;
  x: number;
  y: number;
  z: number;
}

export type Point = [number, number, number];

/** A place a fix might be on the tracks, and how unlikely: lower's better. */
export interface Candidate {
  snap: Snap;
  score: number;
}

/** Grid cell for finding tracks near a point, m. */
const CELL = 64;

/**
 * How strongly a fix is drawn to the left-hand track of a double line, m
 * per m to the left, up to LEFT_REACH: trains keep left in New Zealand,
 * and fixes are only good to a few metres.
 */
const LEFT_BIAS = 1;
const LEFT_REACH = 2.5;

/** Added to a track's score when it runs across the way the train's going. */
const ACROSS = 25;

/**
 * Sharpest change of direction allowed from one piece of track to the
 * next, as a cosine: through a turnout, but not back down the other leg.
 */
const TURN = 0.5;

class Heap {
  private items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, value: number) {
    const items = this.items;
    items.push([cost, value]);
    let i = items.length - 1;

    while (i > 0) {
      const parent = (i - 1) >> 1;

      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;

    if (items.length) {
      items[0] = last;
      let i = 0;

      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;

        if (l < items.length && items[l][0] < items[m][0]) m = l;

        if (r < items.length && items[r][0] < items[m][0]) m = r;

        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }

    return top;
  }
}

export class RailNetwork {
  readonly flags: NetworkFile["flags"];
  /** World x, y (track bed, after the terrain's vertical scale), z. */
  readonly points: Float32Array;
  readonly ways: { flags: number; points: number[] }[];
  /** Outlines in world x/z, and the top of the ground under them. */
  readonly platforms: { ground: number; ring: [number, number][] }[];

  private start: Int32Array;
  /** Which way each edge is part of. */
  private wayOf: Int32Array;
  private end: Int32Array;
  private length: Float32Array;
  private edgesAt: number[][];
  private grid = new Map<string, number[]>();

  constructor(file: NetworkFile, index: TileIndex) {
    const { manifest } = index;
    const scale = verticalScale.value;
    this.flags = file.flags;
    const count = file.nodes.length / 3;
    this.points = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const [x, z] = nztmToWorld(
        manifest,
        file.nodes[i * 3],
        file.nodes[i * 3 + 1]
      );

      this.points.set([x, file.nodes[i * 3 + 2] * scale, z], i * 3);
    }

    this.ways = file.ways.map(([flags, ...points]) => ({ flags, points }));
    this.platforms = file.platforms.map(({ ground, ring }) => ({
      ground: ground * scale,
      ring: ring.map(([e, n]) => nztmToWorld(manifest, e, n)),
    }));

    const edges = this.ways.flatMap(({ points }) =>
      points.slice(1).map((b, k) => [points[k], b])
    );

    this.wayOf = Int32Array.from(
      this.ways.flatMap(({ points }, w) => points.slice(1).map(() => w))
    );
    this.start = Int32Array.from(edges, ([a]) => a);
    this.end = Int32Array.from(edges, ([, b]) => b);
    this.length = Float32Array.from(edges, ([a, b]) =>
      Math.hypot(...this.delta(a, b))
    );
    this.edgesAt = Array.from({ length: count }, () => []);
    edges.forEach(([a, b], e) => {
      this.edgesAt[a].push(e);
      this.edgesAt[b].push(e);
      const [ax, , az] = this.point(a);
      const [bx, , bz] = this.point(b);

      for (
        let i = Math.floor(Math.min(ax, bx) / CELL);
        i <= Math.floor(Math.max(ax, bx) / CELL);
        i++
      ) {
        for (
          let j = Math.floor(Math.min(az, bz) / CELL);
          j <= Math.floor(Math.max(az, bz) / CELL);
          j++
        ) {
          const key = `${i},${j}`;

          if (!this.grid.has(key)) this.grid.set(key, []);
          this.grid.get(key)!.push(e);
        }
      }
    });
  }

  point(i: number): Point {
    const p = this.points;

    return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  }

  /** x/z from point a to b. */
  private delta(a: number, b: number): [number, number] {
    const p = this.points;

    return [p[b * 3] - p[a * 3], p[b * 3 + 2] - p[a * 3 + 2]];
  }

  private at(edge: number, t: number): Snap {
    const a = this.point(this.start[edge]);
    const b = this.point(this.end[edge]);

    return {
      edge,
      t,
      x: a[0] + (b[0] - a[0]) * t,
      y: a[1] + (b[1] - a[1]) * t,
      z: a[2] + (b[2] - a[2]) * t,
    };
  }

  /**
   * The tracks a fix at world x/z could be on, within `reach` m, best
   * first, at most one place on each way. Nearer is better, as is the
   * left-hand track of a pair and one running the way the train's going,
   * given `heading` (world x/z, unit), if it's known.
   */
  candidates(
    x: number,
    z: number,
    heading: [number, number] | null,
    reach = 40
  ): Candidate[] {
    const best = new Map<number, Candidate>();
    const seen = new Set<number>();
    const i0 = Math.floor((x - reach) / CELL);
    const j0 = Math.floor((z - reach) / CELL);

    for (let i = i0; i <= Math.floor((x + reach) / CELL); i++) {
      for (let j = j0; j <= Math.floor((z + reach) / CELL); j++) {
        for (const e of this.grid.get(`${i},${j}`) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          const [dx, dz] = this.delta(this.start[e], this.end[e]);
          const [ax, , az] = this.point(this.start[e]);
          const length = this.length[e] || 1e-6;

          const t = Math.min(
            Math.max(((x - ax) * dx + (z - az) * dz) / (length * length), 0),
            1
          );

          const px = ax + dx * t - x;
          const pz = az + dz * t - z;
          const distance = Math.hypot(px, pz);

          if (distance > reach) continue;
          let score = distance;

          if (heading) {
            const along = Math.abs(dx * heading[0] + dz * heading[1]) / length;

            if (along < 0.7) score += ACROSS;
            // Left of the heading in world x/z (z is south).
            const left = px * heading[1] - pz * heading[0];
            score -=
              LEFT_BIAS * Math.min(Math.max(left, -LEFT_REACH), LEFT_REACH);
          }

          const way = this.wayOf[e];

          if (score < (best.get(way)?.score ?? Infinity)) {
            best.set(way, { snap: this.at(e, t), score });
          }
        }
      }
    }

    return [...best.values()].sort((a, b) => a.score - b.score);
  }

  /**
   * The way along the tracks from one point to another, no longer than
   * `limit` m, turning only as trains can: its points, or null if there's
   * no such way.
   */
  route(from: Snap, to: Snap, limit: number): Point[] | null {
    const ends = (s: Snap): Point => [s.x, s.y, s.z];

    if (from.edge === to.edge) return [ends(from), ends(to)];

    // States: arrived at the end of edge e going forward (2e), or at its
    // start going backward (2e + 1).
    const cost = new Map<number, number>();
    const previous = new Map<number, number>();
    const open = new Heap();

    const reach = (state: number, c: number, from: number) => {
      if (c >= (cost.get(state) ?? Infinity) || c > limit) return;
      cost.set(state, c);
      previous.set(state, from);
      open.push(c, state);
    };

    const length = this.length[from.edge];
    reach(from.edge * 2, (1 - from.t) * length, -1);
    reach(from.edge * 2 + 1, from.t * length, -1);

    let best = Infinity;
    let finish = -1;

    while (open.size) {
      const [c, state] = open.pop();

      if (c > (cost.get(state) ?? Infinity)) continue;

      if (c >= best) break;
      const e = state >> 1;
      const backward = state & 1;
      const node = backward ? this.start[e] : this.end[e];
      const other = backward ? this.end[e] : this.start[e];
      const [ix, iz] = this.delta(other, node);
      const inLength = this.length[e] || 1e-6;

      for (const f of this.edgesAt[node]) {
        if (f === e) continue;
        const forward = this.start[f] === node;

        const [ox, oz] = forward
          ? this.delta(node, this.end[f])
          : this.delta(node, this.start[f]);

        const outLength = this.length[f] || 1e-6;

        if ((ix * ox + iz * oz) / (inLength * outLength) < TURN) continue;

        if (f === to.edge) {
          const total = c + (forward ? to.t : 1 - to.t) * outLength;

          if (total < best) {
            best = total;
            finish = state;
          }

          continue;
        }

        reach(f * 2 + (forward ? 0 : 1), c + outLength, state);
      }
    }

    if (finish < 0) return null;

    const nodes: Point[] = [];

    for (let s = finish; s >= 0; s = previous.get(s)!) {
      nodes.push(this.point(s & 1 ? this.start[s >> 1] : this.end[s >> 1]));
    }

    return [ends(from), ...nodes.reverse(), ends(to)];
  }

  /**
   * Points `distance` m on from a point on the tracks, setting off toward
   * `heading` (world x/z) and keeping as straight as the tracks allow, or
   * as far as they go.
   */
  extend(from: Snap, heading: [number, number], distance: number): Point[] {
    const points: Point[] = [[from.x, from.y, from.z]];
    let e = from.edge;
    const [dx, dz] = this.delta(this.start[e], this.end[e]);
    let forward = dx * heading[0] + dz * heading[1] >= 0;
    let left = (forward ? 1 - from.t : from.t) * this.length[e];
    let travelled = 0;

    for (;;) {
      const node = forward ? this.end[e] : this.start[e];

      if (travelled + left >= distance) {
        const t = forward
          ? 1 - (left - (distance - travelled)) / (this.length[e] || 1)
          : (left - (distance - travelled)) / (this.length[e] || 1);

        const at = this.at(e, Math.min(Math.max(t, 0), 1));
        points.push([at.x, at.y, at.z]);

        return points;
      }

      travelled += left;
      points.push(this.point(node));

      // Straightest way on.
      const other = forward ? this.start[e] : this.end[e];
      const [ix, iz] = this.delta(other, node);
      let next = -1;
      let straightest = TURN;

      for (const f of this.edgesAt[node]) {
        if (f === e) continue;
        const out = this.start[f] === node;

        const [ox, oz] = out
          ? this.delta(node, this.end[f])
          : this.delta(node, this.start[f]);

        const cosine =
          (ix * ox + iz * oz) /
          ((this.length[e] || 1e-6) * (this.length[f] || 1e-6));

        if (cosine > straightest) {
          straightest = cosine;
          next = f;
          forward = out;
        }
      }

      if (next < 0) return points;
      e = next;
      left = this.length[e];
    }
  }
}

export async function loadRailNetwork(index: TileIndex) {
  const response = await fetch(`${RAIL_URL}/network.json`);

  if (!response.ok) throw new Error(`rail network: HTTP ${response.status}`);

  return new RailNetwork(await response.json(), index);
}
