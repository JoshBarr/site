import {
  DataArrayTexture,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
} from "three/webgpu";
import {
  clamp,
  float,
  floor,
  int,
  ivec2,
  max,
  mix,
  select,
  textureLoad,
  vec2,
} from "three/tsl";
import type { TileIndex } from "../terrain/manifest";
import type { TileCache } from "../terrain/TileCache";
import { verticalScale } from "../terrain/Terrain";

/**
 * Where on the GPU the ground's height is, anywhere: for each cell of a grid
 * at the finest tiles' size, the finest tile the terrain's cache holds there
 * (its west/north corner, size and layer). Heights then come straight from
 * the cache, as the terrain draws them, at whatever detail it has.
 */
export class GroundLookup {
  readonly texture: DataTexture;
  /** Cells across the root. */
  readonly cells: number;
  private data: Float32Array;
  private version = -1;
  private index: TileIndex;

  constructor(index: TileIndex) {
    this.index = index;
    this.cells = 2 ** index.maxLevel;
    this.data = new Float32Array(this.cells * this.cells * 4);
    this.texture = new DataTexture(
      this.data,
      this.cells,
      this.cells,
      RGBAFormat,
      FloatType
    );

    this.texture.magFilter = this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Repaints the grid if the cache has loaded or let go of tiles since. */
  update(cache: Pick<TileCache, "version" | "loaded">) {
    if (cache.version === this.version) return;
    this.version = cache.version;
    this.data.fill(0);

    const tiles = cache.loaded().sort((a, b) => a.tile.level - b.tile.level);

    for (const { tile, slot } of tiles) {
      // Finer tiles go on last, over the coarse ones they sit in.
      const span = 2 ** (this.index.maxLevel - tile.level);
      const [ox, oz] = this.index.tileOrigin(tile.level, tile.x, tile.y);
      const size = this.index.tileSize(tile.level);

      for (let y = tile.y * span; y < (tile.y + 1) * span; y++) {
        for (let x = tile.x * span; x < (tile.x + 1) * span; x++) {
          const p = (y * this.cells + x) * 4;
          this.data[p] = ox;
          this.data[p + 1] = oz;
          this.data[p + 2] = size;
          this.data[p + 3] = slot;
        }
      }
    }

    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}

/**
 * TSL: the ground's height at world x/z, as drawn (exaggerated, and no lower
 * than the sea), bilinear between the tile's samples; 0 until a tile there
 * has loaded.
 */
export function groundHeight(
  lookup: GroundLookup,
  heights: DataArrayTexture,
  index: TileIndex,
  xz
) {
  const { rootSize, tileCells, apron } = index.manifest;
  const last = index.samples - 1;
  const cellSize = rootSize / lookup.cells;

  const cell = ivec2(
    clamp(
      floor(xz.add(rootSize / 2).div(cellSize)),
      vec2(0),
      vec2(lookup.cells - 1)
    )
  );

  const tile = textureLoad(lookup.texture, cell);
  const slot = int(tile.w);
  const t = xz.sub(tile.xy).div(max(tile.z, 1)).mul(tileCells).add(apron);
  const i = floor(t);
  const f = t.sub(i);

  const load = (offset: [number, number]) =>
    textureLoad(
      heights,
      ivec2(clamp(i.add(vec2(...offset)), vec2(0), vec2(last)))
    ).depth(slot).r;

  const height = mix(
    mix(load([0, 0]), load([1, 0]), f.x),
    mix(load([0, 1]), load([1, 1]), f.x),
    f.y
  );

  return select(
    tile.z.greaterThan(0),
    max(height, 0).mul(verticalScale),
    float(0)
  );
}
