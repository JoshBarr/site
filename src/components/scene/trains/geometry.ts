import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  ShapeUtils,
  Vector2,
  Vector3,
} from "three/webgpu";
import { Point, RAIL_TOP, RailNetwork } from "./network";

/** Parts of a car, for its `part` attribute. */
export const BODY = 0;
export const WINDOWS = 1;
export const ROOF = 2;
export const UNDERFRAME = 3;

/**
 * A unit car, flat shaded: x across, y up from the railhead, z along, each
 * -0.5..0.5 (y 0..1). A body with a band of windows round it, a chamfered
 * roof, and narrower bogies and underframe below.
 */
export function createCarGeometry() {
  const position: number[] = [];
  const part: number[] = [];
  const quad = (p: number, a: Point, b: Point, c: Point, d: Point) => {
    position.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) part.push(p);
  };

  // Cross-section, bottom to top: [y, half width] and the part above.
  const FLOOR = 0.18;
  const rows: [number, number, number][] = [
    [FLOOR, 0.5, BODY],
    [0.47, 0.5, WINDOWS],
    [0.72, 0.5, BODY],
    [0.86, 0.5, ROOF],
    [1, 0.36, -1],
  ];
  const L = 0.5;
  for (let r = 0; r < rows.length - 1; r++) {
    const [y0, w0, p] = rows[r];
    const [y1, w1] = rows[r + 1];
    // Sides.
    quad(p, [w0, y0, L], [w0, y0, -L], [w1, y1, -L], [w1, y1, L]);
    quad(p, [-w0, y0, -L], [-w0, y0, L], [-w1, y1, L], [-w1, y1, -L]);
    // Ends: the cab windows run round them too.
    quad(p, [-w0, y0, L], [w0, y0, L], [w1, y1, L], [-w1, y1, L]);
    quad(p, [w0, y0, -L], [-w0, y0, -L], [-w1, y1, -L], [w1, y1, -L]);
  }
  const top = rows[rows.length - 1];
  quad(
    ROOF,
    [top[1], 1, L],
    [top[1], 1, -L],
    [-top[1], 1, -L],
    [-top[1], 1, L]
  );
  quad(
    BODY,
    [-0.5, FLOOR, L],
    [-0.5, FLOOR, -L],
    [0.5, FLOOR, -L],
    [0.5, FLOOR, L]
  );

  // Underframe and bogies: a narrower box under the floor.
  const u = 0.4;
  const ul = 0.44;
  quad(UNDERFRAME, [u, 0, ul], [u, 0, -ul], [u, FLOOR, -ul], [u, FLOOR, ul]);
  quad(
    UNDERFRAME,
    [-u, 0, -ul],
    [-u, 0, ul],
    [-u, FLOOR, ul],
    [-u, FLOOR, -ul]
  );
  quad(UNDERFRAME, [-u, 0, ul], [u, 0, ul], [u, FLOOR, ul], [-u, FLOOR, ul]);
  quad(
    UNDERFRAME,
    [u, 0, -ul],
    [-u, 0, -ul],
    [-u, FLOOR, -ul],
    [u, FLOOR, -ul]
  );

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(position), 3)
  );
  geometry.setAttribute("part", new BufferAttribute(new Float32Array(part), 1));
  geometry.computeVertexNormals();
  return geometry;
}

// --- Track. ---

/** Half the gauge, centre to centre of the rails: 3 ft 6 in. */
const HALF_GAUGE = 0.535;
const RAIL_WIDTH = 0.07;
const RAIL_DEPTH = 0.15;
/** The ballast shoulder spreads from the top to the toe, below the ground. */
const BALLAST_TOP = RAIL_TOP - RAIL_DEPTH - 0.05;
const BALLAST_HALF_TOP = 1.4;
const BALLAST_HALF_TOE = 2.1;
const BALLAST_TOE = -0.4;
/** The sleepers' ends either side of the rails. */
const SLEEPER_HALF = 1.05;
/** Platform tops, above the railhead: about a Matangi's floor. */
const PLATFORM_ABOVE_RAIL = 0.95;
/**
 * Drop points along straight track while it stays within this, m: in the
 * detailed tracks, and the plainer ones beyond.
 */
const SIMPLIFY = 0.12;
const SIMPLIFY_PLAIN = 0.4;

const BALLAST = new Color(0x7e7e7e);
const SLEEPERS = new Color(0x5e5e5e);
const RAIL_SIDE = new Color(0x3a3a3a);
const RAIL_HEAD = new Color(0xb4b4b4);
const PLATFORM = new Color(0xb8b8b8);
const PLATFORM_EDGE = new Color(0x8e8e8e);

/** Douglas–Peucker on a track's points: fewer where it runs straight. */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay, az] = points[a];
    const [bx, by, bz] = points[b];
    const d = [bx - ax, by - ay, bz - az];
    const dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1e-9;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const t =
        ((p[0] - ax) * d[0] + (p[1] - ay) * d[1] + (p[2] - az) * d[2]) / dd;
      const off = Math.hypot(
        p[0] - ax - d[0] * t,
        p[1] - ay - d[1] * t,
        p[2] - az - d[2] * t
      );
      if (off > worst) {
        worst = off;
        at = i;
      }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Track built in square chunks this wide, m, each on its own. */
const CHUNK = 1500;

/** Where a run of track goes, mitred across at each point. */
interface Line {
  points: Point[];
  /** World x/z across the track at each point, scaled for its mitre. */
  across: [number, number][];
  detailed: boolean;
}

/** A square of track: its world bounds, and its geometry when wanted. */
export interface TrackChunk {
  box: Box3;
  build(): BufferGeometry;
}

/**
 * The track, low poly, in chunks: a ballast bed with its shoulders sunk
 * into the ground and a darker band of sleepers. The tracks modelled in
 * detail, from Wellington station to the first tunnels, have two rails
 * with bright heads as well, and the station's platforms. Nothing's laid
 * in tunnels. Each chunk is one geometry, coloured per vertex.
 */
export function createTrackChunks(network: RailNetwork): TrackChunk[] {
  const { model, tunnel } = network.flags;
  const cells = new Map<
    string,
    {
      box: Box3;
      segments: [Line, number][];
      platforms: RailNetwork["platforms"];
    }
  >();
  const cellAt = (x: number, z: number) => {
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { box: new Box3(), segments: [], platforms: [] };
      cells.set(key, cell);
    }
    return cell;
  };
  const corner = new Vector3();

  for (const way of network.ways) {
    if (way.flags & tunnel) continue;
    const detailed = (way.flags & model) !== 0;
    const points = simplify(
      way.points.map((i) => network.point(i)),
      detailed ? SIMPLIFY : SIMPLIFY_PLAIN
    );

    // Across the track at each point (world x/z), mitred at bends.
    const across = points.map((p, i): [number, number] => {
      const a = points[Math.max(i - 1, 0)];
      const b = points[Math.min(i + 1, points.length - 1)];
      let tx = b[0] - a[0];
      let tz = b[2] - a[2];
      const length = Math.hypot(tx, tz) || 1;
      tx /= length;
      tz /= length;
      let miter = 1;
      if (i > 0 && i < points.length - 1) {
        const ix = p[0] - a[0];
        const iz = p[2] - a[2];
        const cosine = (ix * tx + iz * tz) / (Math.hypot(ix, iz) || 1);
        miter = 1 / Math.max(cosine, 0.5);
      }
      return [-tz * miter, tx * miter];
    });
    const line: Line = { points, across, detailed };

    for (let i = 0; i < points.length - 1; i++) {
      const [ax, , az] = points[i];
      const [bx, , bz] = points[i + 1];
      const cell = cellAt((ax + bx) / 2, (az + bz) / 2);
      cell.segments.push([line, i]);
      for (const [x, y, z] of [points[i], points[i + 1]]) {
        cell.box.expandByPoint(
          corner.set(
            x - BALLAST_HALF_TOE,
            y + BALLAST_TOE,
            z - BALLAST_HALF_TOE
          )
        );
        cell.box.expandByPoint(
          corner.set(x + BALLAST_HALF_TOE, y + RAIL_TOP, z + BALLAST_HALF_TOE)
        );
      }
    }
  }

  for (const platform of network.platforms) {
    const [x, z] = platform.ring[0];
    const cell = cellAt(x, z);
    cell.platforms.push(platform);
    const top = platform.ground + RAIL_TOP + PLATFORM_ABOVE_RAIL;
    for (const [px, pz] of platform.ring) {
      cell.box.expandByPoint(corner.set(px, platform.ground - 0.3, pz));
      cell.box.expandByPoint(corner.set(px, top, pz));
    }
  }

  return [...cells.values()].map(({ box, segments, platforms }) => ({
    box,
    build: () => buildTrack(segments, platforms),
  }));
}

function buildTrack(
  segments: [Line, number][],
  platforms: RailNetwork["platforms"]
) {
  const position: number[] = [];
  const color: number[] = [];
  const triangle = (tone: Color, ...points: Point[]) => {
    for (const p of points) {
      position.push(...p);
      color.push(tone.r, tone.g, tone.b);
    }
  };
  const quad = (tone: Color, a: Point, b: Point, c: Point, d: Point) => {
    triangle(tone, a, b, c);
    triangle(tone, a, c, d);
  };

  for (const [{ points, across, detailed }, i] of segments) {
    const j = i + 1;
    // A point `offset` m across from track point k, `up` above its bed.
    const at = (k: number, offset: number, up: number): Point => [
      points[k][0] + across[k][0] * offset,
      points[k][1] + up,
      points[k][2] + across[k][1] * offset,
    ];
    const strip = (
      tone: Color,
      o0: number,
      u0: number,
      o1: number,
      u1: number
    ) => quad(tone, at(i, o0, u0), at(j, o0, u0), at(j, o1, u1), at(i, o1, u1));

    // Ballast: shoulders, then the top either side of the sleepers.
    strip(
      BALLAST,
      -BALLAST_HALF_TOE,
      BALLAST_TOE,
      -BALLAST_HALF_TOP,
      BALLAST_TOP
    );
    strip(
      BALLAST,
      BALLAST_HALF_TOP,
      BALLAST_TOP,
      BALLAST_HALF_TOE,
      BALLAST_TOE
    );
    strip(BALLAST, -BALLAST_HALF_TOP, BALLAST_TOP, -SLEEPER_HALF, BALLAST_TOP);
    strip(BALLAST, SLEEPER_HALF, BALLAST_TOP, BALLAST_HALF_TOP, BALLAST_TOP);
    strip(SLEEPERS, -SLEEPER_HALF, BALLAST_TOP, SLEEPER_HALF, BALLAST_TOP);
    if (!detailed) continue;

    // Rails: two sides and the head.
    for (const side of [-1, 1]) {
      const c = side * HALF_GAUGE;
      const w = RAIL_WIDTH / 2;
      strip(RAIL_SIDE, c - w, BALLAST_TOP, c - w, RAIL_TOP);
      strip(RAIL_SIDE, c + w, RAIL_TOP, c + w, BALLAST_TOP);
      strip(RAIL_HEAD, c - w, RAIL_TOP, c + w, RAIL_TOP);
    }
  }

  // Platforms: their outlines raised to the trains' floors.
  for (const { ground, ring } of platforms) {
    const top = ground + RAIL_TOP + PLATFORM_ABOVE_RAIL;
    const contour = ring.map(([x, z]) => new Vector2(x, z));
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
      triangle(
        PLATFORM,
        [ring[a][0], top, ring[a][1]],
        [ring[b][0], top, ring[b][1]],
        [ring[c][0], top, ring[c][1]]
      );
    }
    ring.forEach(([x0, z0], k) => {
      const [x1, z1] = ring[(k + 1) % ring.length];
      quad(
        PLATFORM_EDGE,
        [x0, ground - 0.3, z0],
        [x1, ground - 0.3, z1],
        [x1, top, z1],
        [x0, top, z0]
      );
    });
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(position), 3)
  );
  geometry.setAttribute(
    "color",
    new BufferAttribute(new Float32Array(color), 3)
  );
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
