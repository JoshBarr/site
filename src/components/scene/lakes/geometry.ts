import {
  BufferAttribute,
  BufferGeometry,
  ShapeUtils,
  Vector2,
} from "three/webgpu";

/** public/lakes/lakes.json, from scripts/lakes/build_lakes.py. */
export interface LakesFile {
  /** NZTM easting and northing the rings are measured from. */
  origin: [number, number];
  lakes: Lake[];
}

interface Lake {
  name: string;
  /** The surface, m above sea level: the land's own, before it's scaled. */
  level: number;
  /** Flat [dE, dN, dE, dN, ...]: the shore, then any islands' shores. */
  rings: number[][];
}

function points(ring: number[], east: number, north: number) {
  const out: Vector2[] = [];

  for (let i = 0; i + 1 < ring.length; i += 2) {
    out.push(new Vector2(ring[i] + east, ring[i + 1] + north));
  }

  return out;
}

/**
 * Every lake as one flat sheet, each triangle facing up. x and z are the
 * world's, from `origin` (the terrain's, NZTM); y is the lake's level in
 * metres, which the material scales as the land is.
 */
export function createLakesGeometry(
  file: LakesFile,
  origin: readonly [number, number]
) {
  const east = file.origin[0] - origin[0];
  const north = file.origin[1] - origin[1];
  const positions: number[] = [];
  const indices: number[] = [];

  for (const { level, rings } of file.lakes) {
    const [shore, ...islands] = rings.map((ring) => points(ring, east, north));

    if (!shore || shore.length < 3) continue;

    const base = positions.length / 3;
    const all = [shore, ...islands].flat();

    for (const p of all) positions.push(p.x, level, -p.y);

    for (const [a, b, c] of ShapeUtils.triangulateShape(shore, islands)) {
      // Anticlockwise seen from above (east right, north up) faces up.
      const turn =
        (all[b].x - all[a].x) * (all[c].y - all[a].y) -
        (all[b].y - all[a].y) * (all[c].x - all[a].x);

      if (turn >= 0) indices.push(base + a, base + b, base + c);
      else indices.push(base + a, base + c, base + b);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3)
  );
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}
