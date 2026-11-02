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

export class Roads {
  readonly flags: RoadsFile["flags"];
  readonly junction: RoadsFile["junction"];
  readonly carriageways: Carriageway[];

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
}

export async function loadRoads(index: TileIndex): Promise<Roads> {
  const response = await fetch(`${ROADS_URL}/roads.json`);

  if (!response.ok) throw new Error(`roads: ${response.status}`);

  return new Roads(await response.json(), index);
}
