// Mirrors the manifest written by scripts/terrain/build_tiles.py.

// Tiles can be served from elsewhere (e.g. Vercel Blob) without code changes.
export const TERRAIN_URL = process.env.NEXT_PUBLIC_TERRAIN_URL ?? "/terrain";

export interface TerrainManifest {
  crs: string;
  origin: [number, number];
  rootSize: number;
  tileCells: number;
  apron: number;
  encoding: { offset: number; scale: number };
  levels: {
    level: number;
    resolution: number;
    /** [x0, x1, y0, y1], end-exclusive */
    range: [number, number, number, number];
    /** [x, y, minHeight, maxHeight] */
    tiles: [number, number, number, number][];
  }[];
  /** water.png: depth over the root in 8 bits; "sqrt" stores sqrt(depth / maxDepth). */
  water?: { size: number; maxDepth: number; encoding?: "linear" | "sqrt" };
  /**
   * landcover.png: fractions of forest, scrub and urban cover (R, G, B) over
   * NZTM bounds [west, south, east, north]. Row 0 is the north edge.
   */
  landcover?: {
    bounds: [number, number, number, number];
    size: [number, number];
  };
  /**
   * shore.png: signed distance to the shore, positive out to sea, around the
   * harbour: (v - 128) * unit metres. Sample (i, j) is `resolution` * i east
   * and * j south of `origin`, an NZTM easting and northing.
   */
  shore?: {
    origin: [number, number];
    resolution: number;
    size: [number, number];
    unit: number;
  };
}

export interface TileInfo {
  level: number;
  x: number;
  y: number;
  minHeight: number;
  maxHeight: number;
}

export function tileKey(level: number, x: number, y: number) {
  return `${level}/${x}/${y}`;
}

/**
 * Lookup structure over the manifest. World frame: x = east, z = south,
 * metres from the manifest origin.
 */
export class TileIndex {
  readonly manifest: TerrainManifest;
  readonly maxLevel: number;
  readonly samples: number;
  private tiles = new Map<string, TileInfo>();

  constructor(manifest: TerrainManifest) {
    this.manifest = manifest;
    this.maxLevel = Math.max(...manifest.levels.map((l) => l.level));
    this.samples = manifest.tileCells + 1 + 2 * manifest.apron;

    for (const { level, tiles } of manifest.levels) {
      for (const [x, y, minHeight, maxHeight] of tiles) {
        this.tiles.set(tileKey(level, x, y), {
          level,
          x,
          y,
          minHeight,
          maxHeight,
        });
      }
    }
  }

  get(level: number, x: number, y: number) {
    return this.tiles.get(tileKey(level, x, y));
  }

  tilesAt(level: number): TileInfo[] {
    const entry = this.manifest.levels.find((l) => l.level === level);

    return entry
      ? entry.tiles.flatMap(([x, y]) => this.get(level, x, y) ?? [])
      : [];
  }

  /** True when the level was generated over this tile's area. */
  inRange(level: number, x: number, y: number) {
    const entry = this.manifest.levels.find((l) => l.level === level);

    if (!entry) return false;
    const [x0, x1, y0, y1] = entry.range;

    return x >= x0 && x < x1 && y >= y0 && y < y1;
  }

  tileSize(level: number) {
    return this.manifest.rootSize / 2 ** level;
  }

  /** World-space west/north corner of a tile. */
  tileOrigin(level: number, x: number, y: number): [number, number] {
    const size = this.tileSize(level);
    const half = this.manifest.rootSize / 2;

    return [-half + x * size, -half + y * size];
  }

  url(level: number, x: number, y: number) {
    return `${TERRAIN_URL}/${level}/${x}/${y}.webp`;
  }
}

/** NZTM2000 easting/northing to world x/z. */
export function nztmToWorld(
  manifest: TerrainManifest,
  easting: number,
  northing: number
): [number, number] {
  return [easting - manifest.origin[0], -(northing - manifest.origin[1])];
}

export async function loadManifest(): Promise<TileIndex> {
  const response = await fetch(`${TERRAIN_URL}/manifest.json`);

  if (!response.ok) {
    throw new Error(`terrain manifest: ${response.status}`);
  }

  return new TileIndex(await response.json());
}
