import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";

// State Highways 1 and 2 as one-way carriageways, from
// public/roads/roads.json (built by scripts/traffic/build_roads.mjs): where
// traffic can be put and run along, lane by lane, and where NZTA's speeds
// apply.

const ROADS_URL = process.env.NEXT_PUBLIC_ROADS_URL ?? "/roads";

/** Lanes, m: motorway and open road, and town streets at 50 or less. */
const LANE = 3.5;
const TOWN_LANE = 3.2;

/** The road's surface, above the smoothed ground it's laid on, m. */
const ROAD_TOP = 0.25;

interface CarriagewayFile {
  road: string;
  points: number[];
  spans: [number, number, number, number, number][];
  junctions: [number, number][];
  links: [number, number, number][];
  legs: [number, number, number][];
  into?: [string, number];
  from?: [string, number];
}

interface RoadsFile {
  flags: { tunnel: number; bridge: number; twoWay: number };
  junction: { joins: number; leaves: number };
  links: string[];
  legs: string[];
  carriageways: Record<string, CarriagewayFile>;
}

/** Where a carriageway meets another: its name, and how far along that. */
export interface Meeting {
  name: string;
  s: number;
}

/** Where on a carriageway: world x, y (the road's surface), z. */
export interface Place {
  x: number;
  y: number;
  z: number;
}

/**
 * One way along a highway: points in world space, and what the road's like
 * from each to the next.
 */
export class Carriageway {
  readonly name: string;
  readonly road: string;
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Distance along at each point, m. */
  readonly s: Float32Array;
  readonly length: number;
  /** World x/z to the right of the way it runs, at each point. */
  readonly rightX: Float32Array;
  readonly rightZ: Float32Array;
  /** From each point to the next: this way's lanes, and the road's. */
  readonly lanes: Uint8Array;
  readonly total: Uint8Array;
  readonly flags: Uint8Array;
  /** Speed limit, m/s. */
  readonly limit: Float32Array;
  readonly laneWidth: Float32Array;
  /** The most lanes it has anywhere. */
  readonly maxLanes: number;
  /** Where other roads meet it: how far along, and joins/leaves bits. */
  readonly junctions: { s: number; kind: number }[];
  /** NZTA's links and legs along it: from, to, and key. */
  readonly links: [number, number, string][];
  readonly legs: [number, number, string][];
  into?: Meeting;
  from?: Meeting;

  constructor(
    name: string,
    file: CarriagewayFile,
    roads: RoadsFile,
    index: TileIndex
  ) {
    const scale = verticalScale.value;
    this.name = name;
    this.road = file.road;
    const count = (this.count = file.points.length / 3);
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.z = new Float32Array(count);
    this.s = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const [x, z] = nztmToWorld(
        index.manifest,
        file.points[i * 3],
        file.points[i * 3 + 1]
      );

      this.x[i] = x;
      this.y[i] = file.points[i * 3 + 2] * scale + ROAD_TOP;
      this.z[i] = z;

      if (i > 0) {
        this.s[i] =
          this.s[i - 1] + Math.hypot(x - this.x[i - 1], z - this.z[i - 1]);
      }
    }

    this.length = this.s[count - 1];

    this.rightX = new Float32Array(count);
    this.rightZ = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const a = Math.max(i - 1, 0);
      const b = Math.min(i + 1, count - 1);
      const tx = this.x[b] - this.x[a];
      const tz = this.z[b] - this.z[a];
      const l = Math.hypot(tx, tz) || 1;
      this.rightX[i] = -tz / l;
      this.rightZ[i] = tx / l;
    }

    this.lanes = new Uint8Array(count);
    this.total = new Uint8Array(count);
    this.flags = new Uint8Array(count);
    this.limit = new Float32Array(count);
    this.laneWidth = new Float32Array(count);
    file.spans.forEach(([from, lanes, total, flags, maxspeed], k) => {
      const to = file.spans[k + 1]?.[0] ?? count;

      for (let i = from; i < to; i++) {
        this.lanes[i] = lanes;
        this.total[i] = total;
        this.flags[i] = flags;
        this.limit[i] = maxspeed / 3.6;
        this.laneWidth[i] = maxspeed > 50 ? LANE : TOWN_LANE;
      }
    });
    this.maxLanes = Math.max(...this.lanes);

    this.junctions = file.junctions.map(([s, kind]) => ({ s, kind }));
    this.links = file.links.map(([a, b, k]) => [a, b, roads.links[k]]);
    this.legs = file.legs.map(([a, b, k]) => [a, b, roads.legs[k]]);
  }

  /**
   * The point a segment starts at, for distance `s` along: searching on
   * from `hint` (the last answer, for something moving along), else from
   * scratch.
   */
  locate(s: number, hint = -1): number {
    const S = this.s;
    const last = this.count - 2;

    if (s <= 0) return 0;

    if (s >= this.length) return last;
    let i = hint;

    if (i < 0 || i > last || Math.abs(S[i] - s) > 200) {
      // Bisect.
      let lo = 0;
      let hi = last;

      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;

        if (S[mid] <= s) lo = mid;
        else hi = mid - 1;
      }

      return lo;
    }

    while (i < last && S[i + 1] <= s) i++;

    while (i > 0 && S[i] > s) i--;

    return i;
  }

  /**
   * Into `out`, the place `s` along and `lateral` to the right of the
   * road's line (OSM's centreline), m. Returns the segment, as a hint.
   */
  placeAt(s: number, lateral: number, out: Place, hint = -1): number {
    const i = this.locate(s, hint);
    const j = i + 1;
    const span = this.s[j] - this.s[i] || 1;
    const t = Math.min(Math.max((s - this.s[i]) / span, 0), 1);
    const rx = this.rightX[i] + (this.rightX[j] - this.rightX[i]) * t;
    const rz = this.rightZ[i] + (this.rightZ[j] - this.rightZ[i]) * t;
    out.x = this.x[i] + (this.x[j] - this.x[i]) * t + rx * lateral;
    out.y = this.y[i] + (this.y[j] - this.y[i]) * t;
    out.z = this.z[i] + (this.z[j] - this.z[i]) * t + rz * lateral;

    return i;
  }

  /** Across from the road's line to the kerb edge of this way's lanes, m. */
  kerbAt(i: number) {
    return (-this.total[i] * this.laneWidth[i]) / 2;
  }

  /** Across from the road's line to the middle of `lane` (0 at the kerb). */
  laneCentre(i: number, lane: number) {
    return this.kerbAt(i) + (lane + 0.5) * this.laneWidth[i];
  }
}

/** Squares for finding the road under a place, m. */
const CELL = 50;

/** Segments a carriageway has at most, for packing one's number with its own. */
const SEGMENTS = 1 << 20;

/** Pointing this nearly along a carriageway (cosine), something's going its way. */
const ITS_WAY = 0.8;

/** Up or down from the road's surface, m, something's still on it: not on a bridge over or under. */
const ON_SURFACE = 5;

/** Where on the roads something is: which carriageway, how far along, across. */
export interface OnRoad {
  carriageway: number;
  s: number;
  /** To the right of the road's line, m. */
  lateral: number;
  /** The segment, for its lanes. */
  i: number;
}

export class Roads {
  readonly flags: RoadsFile["flags"];
  readonly junction: RoadsFile["junction"];
  readonly carriageways: Carriageway[];
  /** Segments by the squares they cross, packed as carriageway and segment. */
  private grid: Map<number, number[]> | null = null;
  private readonly scratch: OnRoad = { carriageway: 0, s: 0, lateral: 0, i: 0 };

  constructor(file: RoadsFile, index: TileIndex) {
    this.flags = file.flags;
    this.junction = file.junction;
    this.carriageways = Object.entries(file.carriageways).map(
      ([name, c]) => new Carriageway(name, c, file, index)
    );
    const byName = new Map(this.carriageways.map((c) => [c.name, c]));

    for (const [name, c] of Object.entries(file.carriageways)) {
      const carriageway = byName.get(name)!;

      if (c.into && byName.has(c.into[0])) {
        carriageway.into = { name: c.into[0], s: c.into[1] };
      }

      if (c.from && byName.has(c.from[0])) {
        carriageway.from = { name: c.from[0], s: c.from[1] };
      }
    }
  }

  private cells() {
    if (this.grid) return this.grid;
    const grid = new Map<number, number[]>();

    this.carriageways.forEach((c, k) => {
      for (let i = 0; i < c.count - 1; i++) {
        const margin = (c.total[i] * c.laneWidth[i]) / 2 + 2;
        const x0 = Math.floor((Math.min(c.x[i], c.x[i + 1]) - margin) / CELL);
        const x1 = Math.floor((Math.max(c.x[i], c.x[i + 1]) + margin) / CELL);
        const z0 = Math.floor((Math.min(c.z[i], c.z[i + 1]) - margin) / CELL);
        const z1 = Math.floor((Math.max(c.z[i], c.z[i + 1]) + margin) / CELL);

        for (let cx = x0; cx <= x1; cx++) {
          for (let cz = z0; cz <= z1; cz++) {
            const key = cellKey(cx, cz);
            const cell = grid.get(key);

            if (cell) cell.push(k * SEGMENTS + i);
            else grid.set(key, [k * SEGMENTS + i]);
          }
        }
      }
    });

    return (this.grid = grid);
  }

  /**
   * The carriageway something at `x`, `y`, `z` heading `dx`, `dz` (a unit
   * vector) is in the lanes of, going its way, into `out`; false if none.
   */
  find(x: number, y: number, z: number, dx: number, dz: number, out: OnRoad) {
    const cell = this.cells().get(
      cellKey(Math.floor(x / CELL), Math.floor(z / CELL))
    );

    if (!cell) return false;
    let best = Infinity;

    for (const packed of cell) {
      const k = Math.floor(packed / SEGMENTS);
      const i = packed - k * SEGMENTS;
      const c = this.carriageways[k];
      const tx = c.x[i + 1] - c.x[i];
      const tz = c.z[i + 1] - c.z[i];
      const length = Math.hypot(tx, tz);

      if (length < 1e-3 || (dx * tx + dz * tz) / length < ITS_WAY) continue;
      const ex = x - c.x[i];
      const ez = z - c.z[i];
      const along = (ex * tx + ez * tz) / length;

      // Past either end, it's the next segment's.
      if (along < 0 || along > length) continue;
      const lateral = (ez * tx - ex * tz) / length;
      const t = along / length;
      const surface = c.y[i] + (c.y[i + 1] - c.y[i]) * t;

      if (Math.abs(y - surface) > ON_SURFACE) continue;
      const kerb = c.kerbAt(i);
      const width = c.lanes[i] * c.laneWidth[i];

      if (lateral < kerb - 1 || lateral > kerb + width + 1) continue;
      const off = Math.abs(lateral - kerb - width / 2);

      if (off < best) {
        best = off;
        out.carriageway = k;
        out.s = c.s[i] + along;
        out.lateral = lateral;
        out.i = i;
      }
    }

    return best < Infinity;
  }

  /**
   * How far right something at `x`, `y`, `z` heading `dx`, `dz` would go,
   * m, to be in the middle of the kerb lane; NaN off the highways.
   */
  toKerb(x: number, y: number, z: number, dx: number, dz: number) {
    const at = this.scratch;

    if (!this.find(x, y, z, dx, dz, at)) return NaN;

    return this.carriageways[at.carriageway].laneCentre(at.i, 0) - at.lateral;
  }
}

const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + cz + 32768;

export async function loadRoads(index: TileIndex): Promise<Roads> {
  const response = await fetch(`${ROADS_URL}/roads.json`);

  if (!response.ok) throw new Error(`roads: ${response.status}`);

  return new Roads(await response.json(), index);
}
