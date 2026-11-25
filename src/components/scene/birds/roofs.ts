import type { BuildingsManifest } from "../buildings/manifest";

// How high birds keep over the buildings: for each of the finest building
// tiles (512 m), its tallest building, from the buildings' manifest. A bird
// over a tile flies at least that high over the ground under it, so it's
// over any roof (or mast) there. Each tile's height is spread to its
// neighbours, then eased between tile middles, so a flock climbs before it
// gets to the towers rather than jumping up at the tile's edge.

export interface Roofs {
  /** Tiles across, and their size, m; the world x and z the grid starts at. */
  cells: number;
  size: number;
  start: number;
  /** Per tile, row by row (z), the tallest building near it, m. */
  heights: Float32Array;
}

/** The roofs the buildings' finest tiles say there are. */
export function roofsOf(manifest: BuildingsManifest): Roofs {
  const finest = manifest.levels.reduce((a, b) => (b.level > a.level ? b : a));
  const cells = 2 ** finest.level;
  const size = manifest.rootSize / cells;
  const tallest = new Float32Array(cells * cells);

  for (const [x, y, , , , , , , maxRel] of finest.tiles) {
    if (x >= 0 && x < cells && y >= 0 && y < cells) {
      tallest[y * cells + x] = Math.max(tallest[y * cells + x], maxRel);
    }
  }

  // Spread to the tiles round about: eased between middles, a point inside
  // a tile is never lower than its own tallest.
  const heights = new Float32Array(cells * cells);

  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      let most = 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;

          if (nx < 0 || ny < 0 || nx >= cells || ny >= cells) continue;
          most = Math.max(most, tallest[ny * cells + nx]);
        }
      }

      heights[y * cells + x] = most;
    }
  }

  return { cells, size, start: -manifest.rootSize / 2, heights };
}

/** How high the buildings near world x, z reach over their ground, m. */
export function roofAbove(roofs: Roofs, x: number, z: number) {
  const { cells, size, start, heights } = roofs;
  // From tile middles.
  const fx = (x - start) / size - 0.5;
  const fz = (z - start) / size - 0.5;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;

  // Past the grid's edge, as at it.
  const at = (cx: number, cz: number) =>
    heights[
      Math.min(Math.max(cz, 0), cells - 1) * cells +
        Math.min(Math.max(cx, 0), cells - 1)
    ];

  return (
    (at(x0, z0) * (1 - tx) + at(x0 + 1, z0) * tx) * (1 - tz) +
    (at(x0, z0 + 1) * (1 - tx) + at(x0 + 1, z0 + 1) * tx) * tz
  );
}
