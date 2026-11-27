import {
  BufferGeometry,
  Float32BufferAttribute,
  ShapeUtils,
  Vector2,
  Vector3,
} from "three/webgpu";
import type { Outline } from "./marinaOutlines";

/** A solid stood up from an outline: a pontoon, a wall or a mound. */
export interface Solid {
  /** Its rings, as marinaOutlines.ts has them: NZTM, outside anticlockwise. */
  outline: Outline;
  /** Its top and its foot, m. */
  top: number;
  bottom: number;
  /** How far its foot spreads past its top's edge, m: 0 stands it upright. */
  batter: number;
  /** Its grey, 0..1: the top's, and the sides'. */
  tone: [top: number, sides: number];
}

const UP = new Vector3(0, 1, 0);
const a = new Vector3();
const b = new Vector3();
const out = new Vector3();

/** A ring's points from a flat [e, n, …]. */
function pointsOf(ring: number[]) {
  const points: [number, number][] = [];

  for (let i = 0; i < ring.length; i += 2) points.push([ring[i], ring[i + 1]]);

  return points;
}

/**
 * The solids, as one mesh's geometry in the world frame by `toWorld` (NZTM
 * to world x, z): each a flat top over its outline, holes and all, and sides
 * down to its foot, flat-shaded. A `tone` attribute carries each face's grey.
 */
export function createSolidsGeometry(
  solids: Solid[],
  toWorld: (easting: number, northing: number) => [number, number]
) {
  const positions: number[] = [];
  const tones: number[] = [];

  /** One triangle, wound to face along `facing`. */
  const triangle = (
    p: Vector3,
    q: Vector3,
    r: Vector3,
    facing: Vector3,
    tone: number
  ) => {
    a.subVectors(q, p);
    b.subVectors(r, p);
    const flip = a.cross(b).dot(facing) < 0;

    for (const v of flip ? [p, r, q] : [p, q, r]) {
      positions.push(v.x, v.y, v.z);
      tones.push(tone);
    }
  };

  for (const { outline, top, bottom, batter, tone } of solids) {
    const rings = outline.map(pointsOf);
    const world = rings.map((ring) => ring.map(([e, n]) => toWorld(e, n)));

    // The top, holes left open.
    const [outer, ...holes] = world;
    const flat = world.flat();

    const faces = ShapeUtils.triangulateShape(
      outer.map(([x, z]) => new Vector2(x, z)),
      holes.map((hole) => hole.map(([x, z]) => new Vector2(x, z)))
    );

    const corner = flat.map(([x, z]) => new Vector3(x, top, z));

    for (const [i, j, k] of faces) {
      triangle(corner[i], corner[j], corner[k], UP, tone[0]);
    }

    // The sides: each ring's edges, outward to its right (the outside's
    // wound anticlockwise, the holes clockwise), down to the foot.
    rings.forEach((ring, r) => {
      const count = ring.length;

      const normals = ring.map(([e, n], i) => {
        const [ne, nn] = ring[(i + 1) % count];
        const length = Math.hypot(ne - e, nn - n) || 1;

        return [(nn - n) / length, -(ne - e) / length] as const;
      });

      const feet = ring.map(([e, n], i) => {
        const n0 = normals[(i + count - 1) % count];
        const n1 = normals[i];
        let me = n0[0] + n1[0];
        let mn = n0[1] + n1[1];
        const m = Math.hypot(me, mn) || 1;
        me /= m;
        mn /= m;

        const reach = Math.min(
          batter / Math.max(me * n0[0] + mn * n0[1], 0.1),
          2 * batter
        );

        const [x, z] = toWorld(e + me * reach, n + mn * reach);

        return new Vector3(x, bottom, z);
      });

      const tops = world[r].map(([x, z]) => new Vector3(x, top, z));

      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const [ne, nn] = normals[i];
        // East, north to the world's x, z: z runs south.
        out.set(ne, 0, -nn);
        triangle(tops[i], feet[i], feet[j], out, tone[1]);
        triangle(tops[i], feet[j], tops[j], out, tone[1]);
      }
    });
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("tone", new Float32BufferAttribute(tones, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return geometry;
}
