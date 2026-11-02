import { Box3, Camera, Frustum, Matrix4, Vector3 } from "three/webgpu";
import { TileIndex, TileInfo } from "./manifest";
import { TileCache } from "./TileCache";

/** One terrain patch to draw, and where its heights come from. */
export interface DrawNode {
  originX: number;
  originZ: number;
  size: number;
  level: number;
  slot: number;
  /** Patch position and scale within the source tile, in 0..1. */
  u0: number;
  v0: number;
  uvScale: number;
}

export interface SelectOptions {
  /** Split when the camera is closer than size * lodFactor. */
  lodFactor: number;
  maxNodes: number;
  /** Quads per patch side. */
  gridSize: number;
  /** Terrain height multiplier, for bounding boxes. */
  verticalScale: number;
  /** Never split below this level. */
  maxLevel?: number;
  /** Skip frustum culling, e.g. when drawing for a mirrored camera. */
  frustumCulled?: boolean;
  /** When false, only draw from tiles already loaded; never fetch. */
  request?: boolean;
}

const box = new Box3();
const frustum = new Frustum();
const projScreen = new Matrix4();
const cameraPosition = new Vector3();

/**
 * Adds a patch drawn from `data`, or the best loaded ancestor until it
 * arrives.
 */
function pushNode(
  index: TileIndex,
  cache: TileCache,
  level: number,
  x: number,
  y: number,
  data: TileInfo,
  out: DrawNode[]
) {
  let source: TileInfo | undefined = data;
  let slot = cache.use(source);
  while (slot === undefined && source.level > 0) {
    source = index.get(source.level - 1, source.x >> 1, source.y >> 1);
    if (!source) return;
    slot = cache.use(source);
  }
  if (slot === undefined) return;

  const f = 2 ** (level - source.level);
  const [originX, originZ] = index.tileOrigin(level, x, y);
  out.push({
    originX,
    originZ,
    size: index.tileSize(level),
    level,
    slot,
    u0: (x - source.x * f) / f,
    v0: (y - source.y * f) / f,
    uvScale: 1 / f,
  });
}

/**
 * Every tile at one level, regardless of camera: for things that need a
 * fixed view of the whole map, like a shadow map.
 */
export function selectLevel(
  index: TileIndex,
  cache: TileCache,
  level: number,
  out: DrawNode[]
) {
  out.length = 0;
  for (const tile of index.tilesAt(level)) {
    // After everything the camera needs.
    cache.request(tile, 1e9 + level);
    pushNode(index, cache, level, tile.x, tile.y, tile, out);
  }
  return out;
}

/**
 * Walks the tile quadtree from the root, picking a patch per area based on
 * camera distance. Patches use the best loaded ancestor's heights until their
 * own tile arrives, so the terrain refines progressively instead of popping in.
 */
export function selectNodes(
  index: TileIndex,
  cache: TileCache,
  camera: Camera,
  {
    lodFactor,
    maxNodes,
    gridSize,
    verticalScale,
    maxLevel = Infinity,
    frustumCulled = true,
    request = true,
  }: SelectOptions,
  out: DrawNode[]
) {
  out.length = 0;
  camera.getWorldPosition(cameraPosition);
  projScreen.multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );
  frustum.setFromProjectionMatrix(projScreen, camera.coordinateSystem);

  const setBox = (level: number, x: number, y: number, data: TileInfo) => {
    const [ox, oz] = index.tileOrigin(level, x, y);
    const size = index.tileSize(level);
    box.min.set(ox, data.minHeight * verticalScale, oz);
    box.max.set(
      ox + size,
      Math.max(data.maxHeight, 0) * verticalScale,
      oz + size
    );
  };

  const draw = (level: number, x: number, y: number, data: TileInfo) => {
    if (out.length < maxNodes) pushNode(index, cache, level, x, y, data, out);
  };

  // Patches keep splitting past the finest data until their vertices are as
  // dense as its samples, so coastlines follow the data, not the patch grid.
  const extraLevels = Math.log2(index.manifest.tileCells / gridSize);

  /**
   * `borrowed` is set when the patch has no tile of its own and is drawn from
   * an ancestor's data.
   */
  const visit = (level: number, x: number, y: number, borrowed?: TileInfo) => {
    const tile = borrowed ?? index.get(level, x, y);
    if (!tile) return;

    setBox(level, x, y, tile);
    if (frustumCulled && !frustum.intersectsBox(box)) return;

    const distance = box.distanceToPoint(cameraPosition);
    if (request && !borrowed) {
      // Coarse levels first, then nearest first.
      cache.request(tile, level * 1e6 + distance);
    }

    if (level >= maxLevel || distance > index.tileSize(level) * lodFactor) {
      draw(level, x, y, tile);
      return;
    }

    const next = level + 1;
    const children = [
      [x * 2, y * 2],
      [x * 2 + 1, y * 2],
      [x * 2, y * 2 + 1],
      [x * 2 + 1, y * 2 + 1],
    ];
    const finerData =
      !borrowed &&
      next <= index.maxLevel &&
      children.some(([cx, cy]) => index.inRange(next, cx, cy));

    if (!finerData && level >= tile.level + extraLevels) {
      draw(level, x, y, tile);
      return;
    }

    for (const [cx, cy] of children) {
      if (!finerData || !index.inRange(next, cx, cy)) {
        visit(next, cx, cy, tile);
      } else if (index.get(next, cx, cy)) {
        visit(next, cx, cy);
      }
      // Otherwise the child was generated and is all sea.
    }
  };

  visit(0, 0, 0);
  return out;
}
