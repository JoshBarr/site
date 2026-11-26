import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Quaternion,
  SphereGeometry,
  TubeGeometry,
  Vector3,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  BUCKETS,
  CAGE_RADIUS,
  CAGE_TOP,
  COLOURS,
  HUB,
  OUTLETS,
  RAILS,
} from "./layout";
import { axle, FOOT, place, shell } from "./shape";
import { POOL, toLocal } from "./site";

// The fountain's fixed parts and its buckets, in its own frame (x across the
// mall, y up from the paving, z down it), m. Every vertex carries its grey
// as `color` and what the pool's lights put on it at night as `glow` (see
// ../models/lod.ts). Sizes by eye from photos: the cage about 2 m across
// and the ball on top about 7 m up.

const GREYS = {
  steel: "#2a2d2f",
  post: "#e6e3dc",
  rim: "#b9b4a8",
  ball: "#c8282d",
} as const;

/** A colour as the scene has it: its grey. */
function grey(hex: string) {
  const { r, g, b } = new Color(hex);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;

  return [y, y, y];
}

/** The pool's lights, under the water, light it this much at night... */
const GLOW = 0.5;

/** ...fading up it with height, m. */
const GLOW_FALL = 3;

/** The pool's wall: how thick and how high over the paving, m. */
const RIM_WIDTH = 0.25;
const RIM_HEIGHT = 0.45;

/** The ball on top, and the spike on it, m. */
const BALL_RADIUS = 0.5;
const BALL_AT = CAGE_TOP + 1.1;
const SPIKE = 0.8;

/** Afar, the rails are drawn this many times as thick. */
const COARSE_RAIL = 1.6;

/** Pipe radii, m. */
const RAIL = 0.05;
const PIPE = 0.05;
const ARM = 0.03;

export const HEIGHT = BALL_AT + BALL_RADIUS + SPIKE;

const UP = new Vector3(0, 1, 0);

/** Collects parts and their greys; merged into one geometry at the end. */
class Kit {
  private parts: BufferGeometry[] = [];

  /** `lamplit`: whether the pool's lights reach it (not its own wall). */
  add(geometry: BufferGeometry, hex: string, lamplit = true) {
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== "position" && name !== "normal") {
        geometry.deleteAttribute(name);
      }
    }

    const part = geometry.index ? geometry.toNonIndexed() : geometry;
    const count = part.getAttribute("position").count;
    const colour = new Float32Array(count * 3);
    const glow = new Float32Array(count * 3);
    const shade = grey(hex);
    const y = part.getAttribute("position");

    for (let i = 0; i < count; i++) {
      colour.set(shade, i * 3);

      const lit = lamplit
        ? GLOW * Math.exp(-Math.max(y.getY(i) - HUB, 0) / GLOW_FALL)
        : 0;

      glow.set([shade[0] * lit, shade[1] * lit, shade[2] * lit], i * 3);
    }

    part.setAttribute("color", new Float32BufferAttribute(colour, 3));
    part.setAttribute("glow", new Float32BufferAttribute(glow, 3));
    this.parts.push(part);

    return this;
  }

  /** A round pipe from a to b. */
  pipe(a: Vector3, b: Vector3, radius: number, hex: string) {
    const along = new Vector3().subVectors(b, a);
    const length = along.length();

    if (length < 1e-6) return this;

    const pipe = new CylinderGeometry(radius, radius, length, 8);
    pipe.applyQuaternion(
      new Quaternion().setFromUnitVectors(UP, along.normalize())
    );
    pipe.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);

    return this.add(pipe, hex);
  }

  /** A round pipe bent smoothly through `points`; `coarse`, in few pieces. */
  bent(points: Vector3[], radius: number, hex: string, coarse = false) {
    const curve = new CatmullRomCurve3(points);

    const tube = coarse
      ? new TubeGeometry(curve, 12, radius, 4)
      : new TubeGeometry(curve, 48, radius, 8);

    return this.add(tube, hex);
  }

  geometry() {
    const merged = mergeGeometries(this.parts);
    this.parts.forEach((part) => part.dispose());

    return merged;
  }
}

/** A point on a rail at `angle`: `r` out from the middle, `y` up. */
const onRail = (angle: number, r: number, y: number) =>
  new Vector3(Math.sin(angle) * r, y, Math.cos(angle) * r);

/** The pool's wall, on the outside of OSM's edge. */
function rim(kit: Kit) {
  const points = POOL.map(([e, n]) => toLocal(e, n));

  // Which way round it goes, so the wall's built outward.
  const area = points.reduce((sum, [x, z], i) => {
    const [nx, nz] = points[(i + 1) % points.length];

    return sum + x * nz - nx * z;
  }, 0);

  const outward = (Math.sign(area) * RIM_WIDTH) / 2;

  points.forEach(([x, z], i) => {
    const [nx, nz] = points[(i + 1) % points.length];
    const dx = nx - x;
    const dz = nz - z;
    const length = Math.hypot(dx, dz);

    // Along this side, run on past each corner by half its width so the
    // corners close, and set out from the pool by half its width.
    const wall = new BoxGeometry(RIM_WIDTH, RIM_HEIGHT, length + RIM_WIDTH);
    wall.rotateY(Math.atan2(dx, dz));
    wall.translate(
      (x + nx) / 2 + (dz / length) * outward,
      RIM_HEIGHT / 2,
      (z + nz) / 2 - (dx / length) * outward
    );

    kit.add(wall, GREYS.rim, false);
  });
}

/**
 * The cage: four rails up from a hub on its post, closing in at the top,
 * and the ball on it. `coarse`, for afar: a few sides to each round thing,
 * the rails drawn thicker so they hold up at a pixel or two, and no struts,
 * feed pipe, collar, spike or outlets.
 */
function cage(kit: Kit, coarse = false) {
  kit.add(
    new CylinderGeometry(0.16, 0.2, HUB, coarse ? 6 : 16).translate(
      0,
      HUB / 2,
      0
    ),
    GREYS.post
  );

  for (const angle of RAILS) {
    kit.bent(
      [
        onRail(angle, 0.1, HUB + 0.05),
        onRail(angle, 0.5, HUB + 0.2),
        onRail(angle, 0.85, HUB + 0.5),
        onRail(angle, CAGE_RADIUS, HUB + 1.0),
        onRail(angle, CAGE_RADIUS, CAGE_TOP - 0.35),
        onRail(angle, 0.85, CAGE_TOP + 0.05),
        onRail(angle, 0.45, CAGE_TOP + 0.3),
        onRail(angle, 0.1, CAGE_TOP + 0.45),
      ],
      coarse ? RAIL * COARSE_RAIL : RAIL,
      GREYS.steel,
      coarse
    );

    if (coarse) continue;

    // A strut from high on each rail up to the ball's stem.
    kit.pipe(
      onRail(angle, CAGE_RADIUS * 0.97, CAGE_TOP - 0.45),
      new Vector3(0, CAGE_TOP + 0.75, 0),
      RAIL * 0.6,
      GREYS.steel
    );
  }

  if (coarse) {
    kit.add(
      new SphereGeometry(BALL_RADIUS, 10, 7).translate(0, BALL_AT, 0),
      GREYS.ball
    );

    return;
  }

  // The feed pipe up the middle, on up as the ball's stem.
  kit.pipe(
    new Vector3(0, HUB, 0),
    new Vector3(0, BALL_AT - BALL_RADIUS * 0.6, 0),
    PIPE,
    GREYS.steel
  );

  // The ball, on a flared collar, and its spike.
  kit.add(
    new CylinderGeometry(0.12, 0.3, 0.18, 16).translate(
      0,
      BALL_AT - BALL_RADIUS - 0.02,
      0
    ),
    GREYS.ball
  );

  kit.add(
    new SphereGeometry(BALL_RADIUS, 24, 16).translate(0, BALL_AT, 0),
    GREYS.ball
  );

  kit.pipe(
    new Vector3(0, BALL_AT + BALL_RADIUS * 0.9, 0),
    new Vector3(0, BALL_AT + BALL_RADIUS + SPIKE, 0),
    0.012,
    GREYS.steel
  );

  // The feed's outlets: an arm out from the middle to over each top bucket,
  // turned down.
  for (const { at } of OUTLETS) {
    const [x, y, z] = at;
    kit.pipe(
      new Vector3(0, y + 0.08, 0),
      new Vector3(x, y + 0.08, z),
      ARM,
      GREYS.steel
    );
    kit.pipe(
      new Vector3(x, y + 0.1, z),
      new Vector3(x, y - 0.02, z),
      ARM,
      GREYS.steel
    );
  }
}

/** Where a support's pipe is at height y: the middle, or a rail. */
function supports(y: number) {
  const middle = new Vector3(0, y, 0);
  const rails = y > HUB + 1 && y < CAGE_TOP - 0.35;

  return rails
    ? [middle, ...RAILS.map((angle) => onRail(angle, CAGE_RADIUS, y))]
    : [middle];
}

/** Each bucket's axle, on a stub arm off the nearest pipe. */
function arms(kit: Kit) {
  for (const bucket of BUCKETS) {
    const [px, py, pz] = bucket.pivot;
    const [ax, , az] = axle(bucket);
    // Its side, where the axle goes in.
    const side = shell(0.6, Math.PI / 2)[0] * bucket.size + 0.04;
    let best: { from: Vector3; end: Vector3; length: number } | null = null;

    for (const sign of [1, -1]) {
      const end = new Vector3(px + ax * side * sign, py, pz + az * side * sign);

      for (const from of supports(py)) {
        const length = from.distanceTo(end);

        if (!best || length < best.length) best = { from, end, length };
      }
    }

    const { from, end } = best!;
    const pivot = new Vector3(px, py, pz);
    // The axle runs in to the bucket's side; the arm meets it from its pipe.
    kit.pipe(end, pivot.clone().lerp(end, 0.55), 0.022, GREYS.steel);
    kit.pipe(from, end, ARM, GREYS.steel);
    kit.add(
      new SphereGeometry(0.045, 8, 6).translate(end.x, end.y, end.z),
      GREYS.steel
    );
  }
}

/** The fountain's fixed parts: pool wall, post, cage, ball and arms. */
export function createFrameGeometry() {
  const kit = new Kit();
  rim(kit);
  cage(kit);
  arms(kit);

  return kit.geometry();
}

/** Rings from foot to rim, and points round each. */
const RINGS = 8;
const AROUND = 28;

/** The buckets afar: rings and points round, still at rest. */
const COARSE_RINGS = 3;
const COARSE_AROUND = 8;

/**
 * The whole fountain, cheaply, for afar: the pool's wall, the cage on its
 * post with the ball on top, and each bucket a few faces, still, at rest.
 */
export function createSimpleGeometry() {
  const kit = new Kit();
  rim(kit);
  cage(kit, true);

  for (const bucket of BUCKETS) {
    const position: number[] = [];
    const index: number[] = [];

    for (let i = 0; i <= COARSE_RINGS; i++) {
      for (let k = 0; k <= COARSE_AROUND; k++) {
        const phi = (k / COARSE_AROUND) * 2 * Math.PI;
        position.push(...place(bucket, shell(i / COARSE_RINGS, phi), 0));
      }
    }

    for (let i = 0; i < COARSE_RINGS; i++) {
      for (let k = 0; k < COARSE_AROUND; k++) {
        const a = i * (COARSE_AROUND + 1) + k;
        const c = a + COARSE_AROUND + 1;
        index.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }

    const shellGeometry = new BufferGeometry();
    shellGeometry.setAttribute(
      "position",
      new Float32BufferAttribute(position, 3)
    );
    shellGeometry.setIndex(index);
    shellGeometry.computeVertexNormals();
    kit.add(shellGeometry, COLOURS[bucket.colour]);
  }

  return kit.geometry();
}

/**
 * Every bucket in one geometry, each in its own frame at its size (see
 * shape.ts), its pivot and facing in a `hang` attribute (x, y, z, facing)
 * and its index in `bucket`, for the shader to swing it by its lean.
 */
export function createBucketsGeometry() {
  const position: number[] = [];
  const normal: number[] = [];
  const colour: number[] = [];
  const glow: number[] = [];
  const hang: number[] = [];
  const which: number[] = [];
  const index: number[] = [];

  BUCKETS.forEach((bucket, b) => {
    const base = position.length / 3;
    const shade = grey(COLOURS[bucket.colour]);

    const lit =
      GLOW * Math.exp(-Math.max(bucket.pivot[1] - HUB, 0) / GLOW_FALL);

    const { size, pivot, facing } = bucket;

    const vertex = (
      p: [number, number, number],
      n: [number, number, number]
    ) => {
      position.push(p[0] * size, p[1] * size, p[2] * size);
      normal.push(...n);
      colour.push(...shade);
      glow.push(shade[0] * lit, shade[1] * lit, shade[2] * lit);
      hang.push(pivot[0], pivot[1], pivot[2], facing);
      which.push(b);
    };

    // The shell, its normals from the grid's own neighbours: two-sided, so
    // its outside's fine for both.
    for (let i = 0; i <= RINGS; i++) {
      const s = i / RINGS;

      for (let k = 0; k <= AROUND; k++) {
        const phi = (k / AROUND) * 2 * Math.PI;
        const p = shell(s, phi);
        const ds = shell(Math.min(s + 0.01, 1), phi);
        const ds0 = shell(Math.max(s - 0.01, 0), phi);
        const dp = shell(s, phi + 0.01);

        const along = new Vector3(
          ds[0] - ds0[0],
          ds[1] - ds0[1],
          ds[2] - ds0[2]
        );

        const round = new Vector3(dp[0] - p[0], dp[1] - p[1], dp[2] - p[2]);
        const n = new Vector3().crossVectors(round, along).normalize();
        vertex(p, [n.x, n.y, n.z]);
      }
    }

    for (let i = 0; i < RINGS; i++) {
      for (let k = 0; k < AROUND; k++) {
        const a = base + i * (AROUND + 1) + k;
        const c = a + AROUND + 1;
        index.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }

    // Its foot, closed.
    const foot = position.length / 3;
    vertex([0, -FOOT - 0.01, 0], [0, -1, 0]);

    for (let k = 0; k < AROUND; k++) {
      index.push(foot, base + k + 1, base + k);
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normal, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colour, 3));
  geometry.setAttribute("glow", new Float32BufferAttribute(glow, 3));
  geometry.setAttribute("hang", new Float32BufferAttribute(hang, 4));
  geometry.setAttribute("bucket", new Float32BufferAttribute(which, 1));
  geometry.setIndex(index);

  return geometry;
}
