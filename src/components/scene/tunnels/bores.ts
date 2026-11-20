import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import type { Point, RailNetwork } from "../trains/network";

// The tunnels as bores: each a line along its floor with how far the floor
// reaches either side, for lining, for putting portals on, and for telling
// when something's inside one. The roads' come from
// public/tunnels/tunnels.json (built by scripts/tunnels/build_tunnels.mjs);
// the railway's from the rail network trains run on, a bore for each track.

const TUNNELS_URL = process.env.NEXT_PUBLIC_TUNNELS_URL ?? "/tunnels";

export interface Bore {
  kind: "road" | "rail";
  /** Along its floor: world x, y (the road's surface, or the track's bed), z. */
  points: Point[];
  /** Metres along it to each point, over the ground. */
  along: number[];
  /** World x/z to the right of the way it runs at each point: unit. */
  across: [number, number][];
  /** The floor's edges, m to the left and right of the line at each point. */
  left: number[];
  right: number[];
  /**
   * Whether, at each point, a side's open to another bore alongside: two
   * tracks through one tunnel are two bores with no wall between them.
   */
  openLeft: boolean[];
  openRight: boolean[];
  /** Whether each end's a portal: not where a line runs off the map. */
  portals: [boolean, boolean];
  /** From the floor to the crown, m. */
  height: number;
  /** A road's lanes marked on its floor, each this wide, m: 0 for none. */
  lanes: number;
  lane: number;
}

/** A bore along `points`, less what's worked out from them. */
function bore(
  points: Point[],
  rest: Omit<Bore, "points" | "along" | "across">
): Bore {
  const along = [0];

  for (let i = 1; i < points.length; i++) {
    const [ax, , az] = points[i - 1];
    const [bx, , bz] = points[i];
    along.push(along[i - 1] + Math.hypot(bx - ax, bz - az));
  }

  const across = points.map((_, i): [number, number] => {
    const [ax, , az] = points[Math.max(i - 1, 0)];
    const [bx, , bz] = points[Math.min(i + 1, points.length - 1)];
    const length = Math.hypot(bx - ax, bz - az) || 1;

    return [-(bz - az) / length, (bx - ax) / length];
  });

  return { points, along, across, ...rest };
}

// --- Roads. ---

interface TunnelsFile {
  tunnels: {
    name: string;
    lanes: number;
    lane: number;
    width: number;
    height: number;
    top: number;
    points: number[];
  }[];
}

/** The road tunnels in `file` as bores, one each: both ways share it. */
export function roadBores(file: TunnelsFile, index: TileIndex): Bore[] {
  const scale = verticalScale.value;

  return file.tunnels.map(({ lanes, lane, width, height, top, points }) => {
    const line: Point[] = [];

    for (let i = 0; i < points.length; i += 3) {
      const [x, z] = nztmToWorld(index.manifest, points[i], points[i + 1]);
      line.push([x, points[i + 2] * scale + top, z]);
    }

    return bore(line, {
      kind: "road",
      left: line.map(() => width / 2),
      right: line.map(() => width / 2),
      openLeft: line.map(() => false),
      openRight: line.map(() => false),
      portals: [true, true],
      height,
      // A single lane isn't marked: buses each way keep to their own side.
      lanes: lanes > 1 ? lanes : 0,
      lane,
    });
  });
}

export async function loadRoadBores(index: TileIndex) {
  const response = await fetch(`${TUNNELS_URL}/tunnels.json`);

  if (!response.ok) throw new Error(`tunnels: HTTP ${response.status}`);

  // SAFETY: tunnels.json is built by scripts/tunnels/build_tunnels.mjs as a
  // TunnelsFile, and deployed with the app.
  return roadBores((await response.json()) as TunnelsFile, index);
}

// --- The railway. ---

/** A track's bore: from the track to its wall, and the floor to the crown, m. */
interface RailSection {
  half: number;
  height: number;
}

/** The suburban lines': wired, and to the main line's gauge. Near enough. */
const RAIL: RailSection = { half: 2.5, height: 5.8 };

/**
 * Tracks nearer than this, m, and within LEVEL of each other's height, are
 * through the same tunnel.
 */
const ALONGSIDE = 8;
const LEVEL = 3;

/** Of the way to another track, this much is sideways when it's alongside. */
const SIDEWAYS = 0.8;

/**
 * Track mapped as in a tunnel for less than this, m, is under a bridge or a
 * building: nothing the bare ground has a hill for.
 */
const SHORTEST = 25;

/** How far from `p`, across the ground, and where, the nearest of `line` is. */
function nearestOn(line: Point[], [x, y, z]: Point) {
  let best = { distance: Infinity, x: 0, z: 0, level: Infinity };

  for (let i = 1; i < line.length; i++) {
    const [ax, ay, az] = line[i - 1];
    const [bx, by, bz] = line[i];
    const dx = bx - ax;
    const dz = bz - az;

    const t = Math.min(
      Math.max(
        ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9),
        0
      ),
      1
    );

    const px = ax + dx * t;
    const pz = az + dz * t;
    const distance = Math.hypot(px - x, pz - z);

    if (distance < best.distance) {
      best = {
        distance,
        x: px,
        z: pz,
        level: Math.abs(ay + (by - ay) * t - y),
      };
    }
  }

  return best;
}

/**
 * The tunnels `network`'s tracks run through, a bore for each track. Where
 * two run side by side they're open to each other, each floor reaching
 * half way to the other track.
 */
export function railBores(network: RailNetwork, section = RAIL): Bore[] {
  const { tunnel } = network.flags;
  const inTunnel = network.ways.filter((way) => way.flags & tunnel);

  // Out in the open at a point, a tunnel has its portal there.
  const open = new Set(
    network.ways
      .filter((way) => !(way.flags & tunnel))
      .flatMap((way) => way.points)
  );

  // A tunnel mapped as several ways end to end is one bore.
  const runs: number[][] = [];
  const left = new Set(inTunnel);

  for (const way of inTunnel) {
    if (!left.delete(way)) continue;
    const run = [...way.points];

    for (let grown = true; grown;) {
      grown = false;

      for (const other of left) {
        const first = other.points[0];
        const last = other.points[other.points.length - 1];

        // Not on through a portal: that's the next tunnel.
        if (first === run[run.length - 1] && !open.has(first)) {
          run.push(...other.points.slice(1));
        } else if (last === run[0] && !open.has(last)) {
          run.unshift(...other.points.slice(0, -1));
        } else if (last === run[run.length - 1] && !open.has(last)) {
          run.push(...other.points.toReversed().slice(1));
        } else if (first === run[0] && !open.has(first)) {
          run.unshift(...other.points.toReversed().slice(0, -1));
        } else continue;

        left.delete(other);
        grown = true;
      }
    }

    runs.push(run);
  }

  const tunnels = runs.flatMap((run) => {
    const line = run.map((i) => network.point(i));

    const length = line
      .slice(1)
      .reduce(
        (sum, [x, , z], i) => sum + Math.hypot(x - line[i][0], z - line[i][2]),
        0
      );

    return length < SHORTEST ? [] : [{ run, line }];
  });

  const lines = tunnels.map(({ line }) => line);

  return tunnels.map(({ run, line }, k) => {
    const made = bore(line, {
      kind: "rail",
      left: line.map(() => section.half),
      right: line.map(() => section.half),
      openLeft: line.map(() => false),
      openRight: line.map(() => false),
      portals: [open.has(run[0]), open.has(run[run.length - 1])],
      height: section.height,
      lanes: 0,
      lane: 0,
    });

    line.forEach((p, i) => {
      for (const [j, other] of lines.entries()) {
        if (j === k) continue;
        const near = nearestOn(other, p);

        if (near.distance > ALONGSIDE || near.level > LEVEL) continue;
        const [ax, az] = made.across[i];
        const toRight = (near.x - p[0]) * ax + (near.z - p[2]) * az;

        // Ahead or behind, it's the next tunnel along the same track.
        if (Math.abs(toRight) < near.distance * SIDEWAYS || near.distance < 1)
          continue;

        if (toRight > 0) {
          made.right[i] = near.distance / 2;
          made.openRight[i] = true;
        } else {
          made.left[i] = near.distance / 2;
          made.openLeft[i] = true;
        }
      }
    });

    return made;
  });
}

// --- Where they all are. ---

/** Squares for finding the bore over a place, m. */
const CELL = 64;

/** Up or down from a bore's floor, m, something's still in it. */
const IN_BORE = 4;

const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + cz + 32768;

/**
 * Every tunnel in the scene, for telling when something's inside one: each
 * layer lists the bores it draws.
 */
class Underground {
  private listed = new Set<Bore[]>();
  /** Bores' segments by the squares they cross. */
  private grid: Map<number, [Bore, number][]> | null = null;

  /** Lists `bores`, until the function it returns is called. */
  add(bores: Bore[]) {
    this.listed.add(bores);
    this.grid = null;

    return () => {
      this.listed.delete(bores);
      this.grid = null;
    };
  }

  private cells() {
    if (this.grid) return this.grid;
    const grid = new Map<number, [Bore, number][]>();

    for (const bores of this.listed) {
      for (const made of bores) {
        for (let i = 0; i < made.points.length - 1; i++) {
          const [ax, , az] = made.points[i];
          const [bx, , bz] = made.points[i + 1];

          const margin =
            Math.max(
              made.left[i],
              made.right[i],
              made.left[i + 1],
              made.right[i + 1]
            ) + IN_BORE;

          const x0 = Math.floor((Math.min(ax, bx) - margin) / CELL);
          const x1 = Math.floor((Math.max(ax, bx) + margin) / CELL);
          const z0 = Math.floor((Math.min(az, bz) - margin) / CELL);
          const z1 = Math.floor((Math.max(az, bz) + margin) / CELL);

          for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
              const key = cellKey(cx, cz);
              const cell = grid.get(key);

              if (cell) cell.push([made, i]);
              else grid.set(key, [[made, i]]);
            }
          }
        }
      }
    }

    return (this.grid = grid);
  }

  /**
   * How far into a tunnel the place `x`, `y`, `z` is, m from the nearer
   * portal (Infinity in one with none on the map); 0 if it isn't in one.
   * `slack` m further to either side still counts.
   */
  inside(x: number, y: number, z: number, slack = 0) {
    const cell = this.cells().get(
      cellKey(Math.floor(x / CELL), Math.floor(z / CELL))
    );

    let deepest = 0;

    for (const [made, i] of cell ?? []) {
      const [ax, ay, az] = made.points[i];
      const [bx, by, bz] = made.points[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const length = Math.hypot(dx, dz);

      if (length < 1e-3) continue;
      const t = ((x - ax) * dx + (z - az) * dz) / (length * length);

      // Past either end, it's the next segment's, or out of the tunnel.
      if (t < 0 || t > 1) continue;

      if (Math.abs(y - (ay + (by - ay) * t)) > IN_BORE) continue;
      const toRight = ((z - az) * dx - (x - ax) * dz) / length;

      const reach =
        toRight > 0
          ? made.right[i] + (made.right[i + 1] - made.right[i]) * t
          : made.left[i] + (made.left[i + 1] - made.left[i]) * t;

      if (Math.abs(toRight) > reach + slack) continue;
      const at = made.along[i] + length * t;
      const end = made.along[made.along.length - 1];

      const within = Math.min(
        made.portals[0] ? at : Infinity,
        made.portals[1] ? end - at : Infinity
      );

      deepest = Math.max(deepest, within);
    }

    return deepest;
  }
}

export const underground = new Underground();
