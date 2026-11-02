// Mirrors the manifest written by scripts/buildings/build_tiles.mjs.

// Tiles can be served from elsewhere (e.g. Vercel Blob) without code changes.
const BUILDINGS_URL = process.env.NEXT_PUBLIC_BUILDINGS_URL ?? "/buildings";

export interface EncodedRange {
  min: number;
  range: number;
}

export interface BuildingsManifest {
  attribution: string;
  /** Same world frame as the terrain. */
  origin: [number, number];
  rootSize: number;
  encoding: { rel: EncodedRange; ground: EncodedRange };
  levels: {
    level: number;
    /** Roof simplification tolerance, metres. */
    error: number;
    /**
     * [x, y, minX, minZ, maxX, maxZ, minGround, maxGround, maxRel,
     * triangles, bytes, lights, windowWall]
     */
    tiles: number[][];
  }[];
}

/**
 * One tile of buildings, or a placeholder where a coarse level kept none of
 * the buildings its children have.
 */
export interface BuildingTile {
  key: string;
  level: number;
  x: number;
  y: number;
  /** World x/z of what this tile draws; quantised positions span it. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** DEM heights under its buildings, metres, unscaled. */
  minGround: number;
  maxGround: number;
  /** Tallest building above its ground. */
  maxRel: number;
  triangles: number;
  /** Buildings drawn as a point of light: the ones this level leaves out. */
  lights: number;
  /** Wall with windows on buildings under the tile, m². */
  windowWall: number;
  /** Extent of this tile and everything under it, for culling and LOD. */
  bounds: {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
    minGround: number;
    maxGround: number;
    maxRel: number;
  };
  children: BuildingTile[];
}

export class BuildingIndex {
  readonly manifest: BuildingsManifest;
  /** Coarsest level's tiles. */
  readonly roots: BuildingTile[];
  readonly maxLevel: number;

  constructor(manifest: BuildingsManifest) {
    this.manifest = manifest;
    const levels = [...manifest.levels].sort((a, b) => a.level - b.level);
    this.maxLevel = levels[levels.length - 1].level;

    const byLevel = levels.map(
      ({ level, tiles }) =>
        new Map(
          tiles.map((entry) => {
            const tile = createTile(level, entry);

            return [tile.key, tile];
          })
        )
    );

    // Link each level to the one above, adding placeholders where the
    // coarser level has nothing.
    for (let i = levels.length - 1; i > 0; i--) {
      const shift = levels[i].level - levels[i - 1].level;
      const parents = byLevel[i - 1];

      for (const tile of byLevel[i].values()) {
        const x = tile.x >> shift;
        const y = tile.y >> shift;
        const key = `${levels[i - 1].level}/${x}/${y}`;
        let parent = parents.get(key);

        if (!parent) {
          parent = createPlaceholder(levels[i - 1].level, x, y, tile);
          parents.set(key, parent);
        }

        parent.children.push(tile);
      }
    }

    this.roots = [...byLevel[0].values()];
    this.roots.forEach(growBounds);
  }

  tileSize(level: number) {
    return this.manifest.rootSize / 2 ** level;
  }

  url({ level, x, y }: BuildingTile) {
    return `${BUILDINGS_URL}/${level}/${x}/${y}.bin`;
  }
}

function createTile(level: number, entry: number[]): BuildingTile {
  const [
    x,
    y,
    minX,
    minZ,
    maxX,
    maxZ,
    minGround,
    maxGround,
    maxRel,
    triangles,
    ,
    lights = 0,
    windowWall = 0,
  ] = entry;

  const own = { minX, minZ, maxX, maxZ, minGround, maxGround, maxRel };

  return {
    key: `${level}/${x}/${y}`,
    level,
    x,
    y,
    ...own,
    triangles,
    lights,
    windowWall,
    bounds: { ...own },
    children: [],
  };
}

function createPlaceholder(
  level: number,
  x: number,
  y: number,
  child: BuildingTile
): BuildingTile {
  const tile = createTile(level, [x, y, 0, 0, 0, 0, 0, 0, 0, 0]);
  tile.bounds = { ...child.bounds };

  return tile;
}

/** Widens each tile's bounds to cover its descendants. */
function growBounds(tile: BuildingTile) {
  for (const child of tile.children) {
    growBounds(child);
    const b = tile.bounds;
    const c = child.bounds;
    b.minX = Math.min(b.minX, c.minX);
    b.minZ = Math.min(b.minZ, c.minZ);
    b.maxX = Math.max(b.maxX, c.maxX);
    b.maxZ = Math.max(b.maxZ, c.maxZ);
    b.minGround = Math.min(b.minGround, c.minGround);
    b.maxGround = Math.max(b.maxGround, c.maxGround);
    b.maxRel = Math.max(b.maxRel, c.maxRel);
  }
}

export async function loadBuildingIndex(): Promise<BuildingIndex> {
  const response = await fetch(`${BUILDINGS_URL}/manifest.json`);

  if (!response.ok) {
    throw new Error(`buildings manifest: ${response.status}`);
  }

  return new BuildingIndex(await response.json());
}
