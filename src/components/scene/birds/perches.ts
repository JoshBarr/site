import { crownTop, LOBE_FLAT, onLobe } from "../trees/crown";
import { bandEnd, type TreeIndex, type TreeTile } from "../trees/manifest";

// Trees for the hoppers to perch in: the lidar's (../trees), as the trees
// layer draws them, from the same tile files (cached by then). The first
// bands only: the bigger trees, still drawn further off when the rest have
// thinned away, and the ones the tūī would sing from. Hoppers are only
// where there are trees: a site with none near has none.

/** Bands of each tile read: the first three, a quarter of its trees. */
const BANDS = 3;

/** The grid trees are looked up in, m. */
const CELL = 16;

/**
 * Per tree: x, the top of its crown as it's drawn (its top lobe's), z, the
 * crown's radius; then that lobe: how far its middle is from the trunk (x,
 * z), its radius, and the tree's own random number (../trees/crown.ts).
 */
export const TREE_STRIDE = 8;
const STRIDE = TREE_STRIDE;

/** A bird's feet are this far under its middle, m. */
const FEET = 0.03;

/** Trees about a flock, for its birds to hop between. */
export class PerchGrid {
  readonly count: number;
  private readonly cells = new Map<number, number[]>();

  constructor(readonly trees: Float32Array) {
    this.count = trees.length / STRIDE;

    for (let i = 0; i < this.count; i++) {
      const key = cellKey(trees[i * STRIDE], trees[i * STRIDE + 2]);
      const cell = this.cells.get(key);

      if (cell) cell.push(i);
      else this.cells.set(key, [i]);
    }
  }

  /**
   * The tree nearest world x, z within `reach` m, not the one at `skip`
   * (where the bird is now): its index, or -1 if there's none.
   */
  nearest(
    x: number,
    z: number,
    reach: number,
    skip?: { x: number; z: number }
  ) {
    const span = Math.ceil(reach / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best = -1;
    let bestDistance = reach;

    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const cell = this.cells.get(key(cx + dx, cz + dz));

        if (!cell) continue;

        for (const i of cell) {
          const tx = this.trees[i * STRIDE];
          const tz = this.trees[i * STRIDE + 2];

          if (skip && Math.hypot(tx - skip.x, tz - skip.z) < 1.5) continue;

          const d = Math.hypot(tx - x, tz - z);

          if (d < bestDistance) {
            best = i;
            bestDistance = d;
          }
        }
      }
    }

    return best;
  }

  /**
   * The tree nearest world x, z, however far, not the one at `skip`: -1
   * if there's no other.
   */
  closest(x: number, z: number, skip?: { x: number; z: number }) {
    let best = -1;
    let bestDistance = Infinity;

    for (let i = 0; i < this.count; i++) {
      const tx = this.trees[i * STRIDE];
      const tz = this.trees[i * STRIDE + 2];

      if (skip && Math.hypot(tx - skip.x, tz - skip.z) < 1.5) continue;

      const d = Math.hypot(tx - x, tz - z);

      if (d < bestDistance) {
        best = i;
        bestDistance = d;
      }
    }

    return best;
  }

  /** Tree `i`: x, crown top, z, crown radius; and its top lobe's radius. */
  tree(i: number) {
    const o = i * STRIDE;

    return {
      x: this.trees[o],
      top: this.trees[o + 1],
      z: this.trees[o + 2],
      radius: this.trees[o + 3],
      lobe: this.trees[o + 6],
    };
  }

  /**
   * A seat on top of tree `i`'s crown, on the foliage as it's drawn: one
   * of many, picked by `a`, `b` and `c` (0..1 each). Into `out`: x, y, z.
   */
  seat(i: number, a: number, b: number, c: number, out: Float32Array) {
    const o = i * STRIDE;
    const size = this.trees[o + 6];
    onLobe(size, this.trees[o + 7], a, b, c, out);
    out[0] += this.trees[o] + this.trees[o + 4];
    out[1] += this.trees[o + 1] - LOBE_FLAT * size + FEET;
    out[2] += this.trees[o + 2] + this.trees[o + 5];
  }
}

const key = (cx: number, cz: number) => cx * 100_003 + cz;

const cellKey = (x: number, z: number) =>
  key(Math.floor(x / CELL), Math.floor(z / CELL));

/**
 * The trees in a tile's records, `data` (x, z, ground, height and radius as
 * u16s, as scripts/trees/build_trees.py packs them), within `reach` of x,
 * z: TREE_STRIDE numbers each, the ground scaled by `verticalScale`. A
 * crown's top is its top lobe's, as the trees layer draws it: under the
 * tree's measured height, and a little off its trunk.
 */
export function decodeTrees(
  index: TreeIndex,
  tile: TreeTile,
  data: Uint16Array,
  x: number,
  z: number,
  reach: number,
  verticalScale: number
) {
  const { ground, heightStep, radiusStep } = index.manifest.encoding;
  const out: number[] = [];

  for (let o = 0; o + 3 < data.length; o += 4) {
    const tx = tile.minX + (data[o] / 65535) * tile.size;
    const tz = tile.minZ + (data[o + 1] / 65535) * tile.size;

    if (Math.hypot(tx - x, tz - z) > reach) continue;

    const metres = data[o + 2] / ground.scale - ground.offset;
    const packed = data[o + 3];
    const height = (packed >> 8) * heightStep;
    const radius = (packed & 255) * radiusStep;
    const lobe = crownTop(data[o], data[o + 1], height, radius);

    out.push(
      tx,
      metres * verticalScale + lobe.up + LOBE_FLAT * lobe.size,
      tz,
      radius,
      lobe.x,
      lobe.z,
      lobe.size,
      lobe.seed
    );
  }

  return out;
}

/**
 * The trees about the flocks' sites, read as they're asked for: a grid per
 * site, once its tiles are in; null till then. A site with no trees near
 * (or whose trees couldn't be read) gets an empty one: no hoppers there.
 */
export class Perches {
  private readonly tiles = new Map<string, Promise<Uint16Array>>();
  private readonly grids = new Map<string, PerchGrid | null>();
  private readonly byXY = new Map<string, TreeTile>();

  constructor(
    private readonly index: TreeIndex,
    private readonly verticalScale: () => number
  ) {
    for (const tile of index.tiles) this.byXY.set(`${tile.x}/${tile.y}`, tile);
  }

  /**
   * Whether `id`'s site has trees: false once they're read and there are
   * none; true till then (it can't be ruled out).
   */
  hasTrees(id: string) {
    return this.grids.get(id)?.count !== 0;
  }

  /** The trees within `reach` m of world x, z, for `id`, once they're read. */
  around(id: string, x: number, z: number, reach: number) {
    if (this.grids.has(id)) return this.grids.get(id) ?? null;

    this.grids.set(id, null);

    const tiles = this.tilesNear(x, z, reach);

    Promise.all(tiles.map((tile) => this.read(tile))).then(
      (datas) => {
        const trees = datas.flatMap((data, i) =>
          decodeTrees(
            this.index,
            tiles[i],
            data,
            x,
            z,
            reach,
            this.verticalScale()
          )
        );

        this.grids.set(id, new PerchGrid(new Float32Array(trees)));
      },
      (e) => {
        console.warn("[birds] trees:", e);
        this.grids.set(id, new PerchGrid(new Float32Array(0)));
      }
    );

    return null;
  }

  private tilesNear(x: number, z: number, reach: number) {
    const { rootSize, level } = this.index.manifest;
    const size = rootSize / 2 ** level;
    const half = rootSize / 2;
    const found: TreeTile[] = [];

    for (
      let tx = Math.floor((x - reach + half) / size);
      tx <= Math.floor((x + reach + half) / size);
      tx++
    ) {
      for (
        let ty = Math.floor((z - reach + half) / size);
        ty <= Math.floor((z + reach + half) / size);
        ty++
      ) {
        const tile = this.byXY.get(`${tx}/${ty}`);

        if (tile) found.push(tile);
      }
    }

    return found;
  }

  /** A tile's first bands, in its order. */
  private read(tile: TreeTile) {
    let reading = this.tiles.get(tile.key);

    if (!reading) {
      reading = (async () => {
        const { bands } = this.index.manifest;
        const parts: Uint16Array[] = [];

        for (let band = 0; band < Math.min(BANDS, bands.length); band++) {
          const start = band ? bandEnd(tile.count, bands[band - 1]) : 0;
          const end = bandEnd(tile.count, bands[band]);

          // Small tiles can have an empty band, with no file.
          if (end <= start) continue;
          const response = await fetch(this.index.url(tile, band));

          if (!response.ok)
            throw new Error(`${tile.key}/${band}: ${response.status}`);
          parts.push(new Uint16Array(await response.arrayBuffer()));
        }

        const data = new Uint16Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;

        for (const part of parts) {
          data.set(part, at);
          at += part.length;
        }

        return data;
      })();

      this.tiles.set(tile.key, reading);
    }

    return reading;
  }
}
