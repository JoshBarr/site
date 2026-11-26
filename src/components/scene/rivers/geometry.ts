import { BufferAttribute, BufferGeometry } from "three/webgpu";
import { flowAlong } from "./flow";

/** public/rivers/rivers.json, from scripts/rivers/build_rivers.py. */
export interface RiversFile {
  /** NZTM easting and northing the points are measured from. */
  origin: [number, number];
  /** Each river's last this many metres are over the sea, fading out. */
  fade: number;
  rivers: River[];
}

interface River {
  name: string;
  /**
   * Flat [dE, dN, h, ...]: the left bank's point then the right's, station
   * by station downstream. h is m above sea level, before it's scaled: the
   * water's, or the drawn terrain's where its coarse tiles stand higher.
   */
  points: number[];
  /** The water's own level at each station, m above sea level. */
  levels: number[];
}

/**
 * Every river as one ribbon, bank to bank, each triangle facing up. x and z
 * are the world's, from `origin` (the terrain's, NZTM); y is the water's
 * height in metres, which the material scales as the land is. `level` is
 * the water's own, bank to bank the same. `fade` is 1 down to the coast,
 * then falls to 0 at the ribbon's end, out over the sea. `flow` is how the
 * water runs there (./flow.ts): how far down the river and how far off its
 * middle (the left bank's under 0), both in the moving pattern's metres,
 * which on a narrow river are shorter than life; its speed, m/s; and how
 * broken its surface is, 0..1. `reach` is which side (-1 at the left bank,
 * 1 at the right), how much foam the water carries there, 0..1, and how
 * much smaller than life the pattern's drawn, 0..1.
 */
export function createRiversGeometry(
  file: RiversFile,
  origin: readonly [number, number]
) {
  const east = file.origin[0] - origin[0];
  const north = file.origin[1] - origin[1];
  const positions: number[] = [];
  const fades: number[] = [];
  const levels: number[] = [];
  const flows: number[] = [];
  const reaches: number[] = [];
  const indices: number[] = [];

  for (const { name, points, levels: stationLevels } of file.rivers) {
    const base = positions.length / 3;
    const count = points.length / 3;

    for (let i = 0; i < points.length; i += 3) {
      positions.push(points[i] + east, points[i + 2], -(points[i + 1] + north));
    }

    // Each station's way to the river's end, along its middle: its fade.
    const stations = count / 2;
    const fading = Array.from({ length: stations }, () => 1);
    let toEnd = 0;

    fading[stations - 1] = 0;

    for (let station = stations - 2; station >= 0; station--) {
      const [a, b] = [station * 6, station * 6 + 6];

      toEnd += Math.hypot(
        (points[a] + points[a + 3] - points[b] - points[b + 3]) / 2,
        (points[a + 1] + points[a + 4] - points[b + 1] - points[b + 4]) / 2
      );

      if (toEnd >= file.fade) break;

      fading[station] = toEnd / file.fade;
    }

    for (const fade of fading) fades.push(fade, fade);

    for (const level of stationLevels) levels.push(level, level);

    const flowing = flowAlong(name, points, stationLevels);

    for (let station = 0; station < stations; station++) {
      const scale = flowing.scales[station];

      for (const side of [-1, 1]) {
        flows.push(
          flowing.drifts[station],
          (side * flowing.halfWidths[station]) / scale,
          flowing.speeds[station],
          flowing.roughs[station]
        );
        reaches.push(side, flowing.foams[station], scale);
      }
    }

    // Up, times twice the area, of the triangle a b c: anticlockwise seen
    // from above (east right, north up) faces up.
    const turn = (a: number, b: number, c: number) => {
      const [ax, an] = [points[a * 3], points[a * 3 + 1]];
      const [bx, bn] = [points[b * 3], points[b * 3 + 1]];
      const [cx, cn] = [points[c * 3], points[c * 3 + 1]];

      return (bx - ax) * (cn - an) - (bn - an) * (cx - ax);
    };

    const face = (a: number, b: number, c: number) => {
      if (turn(a, b, c) >= 0) indices.push(base + a, base + b, base + c);
      else indices.push(base + a, base + c, base + b);
    };

    for (let i = 0; i + 3 < count; i += 2) {
      const [left, right, nextLeft, nextRight] = [i, i + 1, i + 2, i + 3];

      face(left, right, nextLeft);
      face(right, nextRight, nextLeft);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3)
  );
  geometry.setAttribute(
    "fade",
    new BufferAttribute(new Float32Array(fades), 1)
  );
  geometry.setAttribute(
    "level",
    new BufferAttribute(new Float32Array(levels), 1)
  );
  geometry.setAttribute(
    "flow",
    new BufferAttribute(new Float32Array(flows), 4)
  );
  geometry.setAttribute(
    "reach",
    new BufferAttribute(new Float32Array(reaches), 3)
  );
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  return geometry;
}
