// Mirrors the manifest written by scripts/trees/build_trees.py.

// Tiles can be served from elsewhere (e.g. Vercel Blob) without code changes.
const TREES_URL = process.env.NEXT_PUBLIC_TREES_URL ?? "/trees";

/** Bytes per tree: x, z, ground, height << 8 | radius, as u16s. */
export const TREE_BYTES = 8;

export interface TreesManifest {
  attribution: string;
  /** Same world frame as the terrain. */
  origin: [number, number];
  rootSize: number;
  /** Terrain level the tiles are cut at. */
  level: number;
  /**
   * Cumulative fractions of each tile's trees per file. Trees are stored in
   * a weighted random order, so any prefix is an even thinning of the tile.
   */
  bands: number[];
  encoding: {
    /** As the terrain: metres = q / scale - offset. */
    ground: { offset: number; scale: number };
    heightStep: number;
    radiusStep: number;
  };
  /** [x, y, count, minGround, maxGround, maxHeight] */
  tiles: [number, number, number, number, number, number][];
}

export interface TreeTile {
  key: string;
  x: number;
  y: number;
  /** World x/z of the tile's north-west corner, and its side. */
  minX: number;
  minZ: number;
  size: number;
  count: number;
  /** DEM heights under its trees, metres, unscaled. */
  minGround: number;
  maxGround: number;
  maxHeight: number;
}

/** Index after a band's last tree. Must match band_end in the build. */
export function bandEnd(count: number, fraction: number) {
  return Math.min(count, Math.ceil(count * fraction));
}

export class TreeIndex {
  readonly manifest: TreesManifest;
  readonly tiles: TreeTile[];

  constructor(manifest: TreesManifest) {
    this.manifest = manifest;
    const size = manifest.rootSize / 2 ** manifest.level;
    const half = manifest.rootSize / 2;
    this.tiles = manifest.tiles.map(
      ([x, y, count, minGround, maxGround, maxHeight]) => ({
        key: `${x}/${y}`,
        x,
        y,
        minX: x * size - half,
        minZ: y * size - half,
        size,
        count,
        minGround,
        maxGround,
        maxHeight,
      })
    );
  }

  url({ x, y }: TreeTile, band: number) {
    return `${TREES_URL}/${band}/${x}/${y}.bin`;
  }
}

export async function loadTreeIndex(): Promise<TreeIndex> {
  const response = await fetch(`${TREES_URL}/manifest.json`);

  if (!response.ok) throw new Error(`trees manifest: ${response.status}`);

  return new TreeIndex(await response.json());
}
