import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Camera,
  Frustum,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
} from "three/webgpu";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { createLights } from "./lights";
import { BuildingIndex, BuildingsManifest, BuildingTile } from "./manifest";

/** "BLD3": see scripts/buildings/build_tiles.mjs for the format. */
const MAGIC = 0x33444c42;
const HEADER_BYTES = 32;
const VERTEX_BYTES = 12;
const LIGHT_BYTES = 16;

const padded = (bytes: number) => Math.ceil(bytes / 4) * 4;

/**
 * Decodes a tile file: geometry with "quantised" and "building" attributes,
 * if it has buildings, and lights as world-space floats (see createLights),
 * if it has those.
 */
async function decodeTile(
  buffer: ArrayBuffer,
  tile: BuildingTile,
  { encoding }: BuildingsManifest
) {
  await MeshoptDecoder.ready;
  const [
    magic,
    vertexCount,
    indexCount,
    indexSize,
    vertexBytes,
    indexBytes,
    lightCount,
    lightBytes,
  ] = new Uint32Array(buffer, 0, 8);
  if (magic !== MAGIC) throw new Error("not a building tile");
  const indexStart = HEADER_BYTES + padded(vertexBytes);
  const lightStart = indexStart + padded(indexBytes);

  let lights: Float32Array | null = null;
  if (lightCount) {
    const raw = new Uint16Array(lightCount * (LIGHT_BYTES / 2));
    MeshoptDecoder.decodeVertexBuffer(
      new Uint8Array(raw.buffer),
      lightCount,
      LIGHT_BYTES,
      new Uint8Array(buffer, lightStart, lightBytes)
    );
    const decode = (q: number, { min, range }: { min: number; range: number }) =>
      (q / 65535) * range + min;
    lights = new Float32Array(lightCount * 8);
    for (let i = 0; i < lightCount; i++) {
      const [x, z, ground, height, seed, wall, top, drawn] = raw.subarray(
        i * 8,
        i * 8 + 8
      );
      lights.set(
        [
          tile.minX + (x / 65535) * (tile.maxX - tile.minX),
          decode(ground, encoding.ground),
          tile.minZ + (z / 65535) * (tile.maxZ - tile.minZ),
          decode(height, encoding.rel),
          seed,
          wall,
          decode(top, encoding.rel),
          drawn,
        ],
        i * 8
      );
    }
  }
  if (!indexCount) return { geometry: null, lights };

  const vertices = new Uint16Array(vertexCount * (VERTEX_BYTES / 2));
  MeshoptDecoder.decodeVertexBuffer(
    new Uint8Array(vertices.buffer),
    vertexCount,
    VERTEX_BYTES,
    new Uint8Array(buffer, HEADER_BYTES, vertexBytes)
  );
  const indices =
    indexSize === 4 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  MeshoptDecoder.decodeIndexBuffer(
    new Uint8Array(indices.buffer),
    indexCount,
    indexSize,
    new Uint8Array(buffer, indexStart, indexBytes)
  );

  const interleaved = new InterleavedBuffer(vertices, VERTEX_BYTES / 2);
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "quantised",
    new InterleavedBufferAttribute(interleaved, 4, 0, true)
  );
  geometry.setAttribute(
    "building",
    new InterleavedBufferAttribute(interleaved, 2, 4, true)
  );
  geometry.setIndex(new BufferAttribute(indices, 1));
  return { geometry, lights };
}

/** A loaded tile: its buildings and lights, either of which may be missing. */
export interface TileObjects {
  object: Object3D;
  mesh?: Mesh;
  lights?: Sprite;
}

interface Resident extends TileObjects {
  level: number;
  triangles: number;
  lastUsed: number;
}

/**
 * Streams building tiles into meshes under one group. Callers say which
 * tiles they want each frame; the cache fetches the most important ones and
 * drops the least recently used past a triangle budget. Tiles coarser than
 * the finest are few and hold the distant city's lights; they're never
 * dropped, so a view panned back to is never dark.
 */
export class BuildingCache {
  readonly group = new Group();
  /** Bumped whenever a tile finishes loading. */
  version = 0;

  private index: BuildingIndex;
  private material: Material;
  private lightsMaterial: SpriteNodeMaterial;
  private setup: (objects: TileObjects) => void;
  private maxTriangles: number;
  private maxInFlight: number;

  private resident = new Map<string, Resident>();
  private residentTriangles = 0;
  private wanted = new Map<string, { tile: BuildingTile; priority: number }>();
  private inFlight = new Set<string>();
  private failed = new Set<string>();
  private frame = 0;
  private disposed = false;

  constructor(
    index: BuildingIndex,
    material: Material,
    lightsMaterial: SpriteNodeMaterial,
    {
      maxTriangles,
      maxInFlight = 4,
      setup = () => {},
    }: {
      maxTriangles: number;
      maxInFlight?: number;
      /** Called on each new tile, e.g. to set layers and shadows. */
      setup?: (objects: TileObjects) => void;
    }
  ) {
    this.index = index;
    this.material = material;
    this.lightsMaterial = lightsMaterial;
    this.maxTriangles = maxTriangles;
    this.maxInFlight = maxInFlight;
    this.setup = setup;
  }

  /** True when the tile can be drawn: loaded, empty, or given up on. */
  ready(tile: BuildingTile) {
    return (
      (tile.triangles === 0 && tile.lights === 0) ||
      this.resident.has(tile.key) ||
      this.failed.has(tile.key)
    );
  }

  /** Lower priority loads first. */
  request(tile: BuildingTile, priority: number) {
    // Loaded but waiting on its siblings to be drawn: don't evict it, or
    // a view over budget would never finish loading.
    const entry = this.resident.get(tile.key);
    if (entry) entry.lastUsed = this.frame;
    if (this.ready(tile) || this.inFlight.has(tile.key)) return;
    const pending = this.wanted.get(tile.key);
    if (!pending || priority < pending.priority) {
      this.wanted.set(tile.key, { tile, priority });
    }
  }

  /** The tile's objects, if loaded; marks it as in use this frame. */
  use(tile: BuildingTile): TileObjects | undefined {
    const entry = this.resident.get(tile.key);
    if (entry) entry.lastUsed = this.frame;
    return entry;
  }

  /** Starts the most wanted loads and evicts. Call once per frame. */
  update() {
    const queue = [...this.wanted.values()].sort(
      (a, b) => a.priority - b.priority
    );
    for (const { tile } of queue) {
      if (this.inFlight.size >= this.maxInFlight) break;
      this.load(tile);
    }
    this.wanted.clear();
    this.evict();
    this.frame++;
  }

  private async load(tile: BuildingTile) {
    this.inFlight.add(tile.key);
    try {
      const response = await fetch(this.index.url(tile));
      if (!response.ok) throw new Error(`${response.status}`);
      const { geometry, lights: data } = await decodeTile(
        await response.arrayBuffer(),
        tile,
        this.index.manifest
      );
      if (this.disposed) {
        geometry?.dispose();
        return;
      }
      const object = new Group();
      let mesh: Mesh | undefined;
      if (geometry) {
        mesh = new Mesh(geometry, this.material);
        // Positions are 0..1 across the tile's bounds.
        mesh.position.set(tile.minX, 0, tile.minZ);
        mesh.scale.set(tile.maxX - tile.minX, 1, tile.maxZ - tile.minZ);
        // Culled per tile by the selection; there's no position attribute
        // for three to compute bounds from.
        mesh.frustumCulled = false;
        object.add(mesh);
      }
      const lights = data ? createLights(data, this.lightsMaterial) : undefined;
      if (lights) object.add(lights);
      object.visible = false;
      this.setup({ object, mesh, lights });
      this.group.add(object);
      this.resident.set(tile.key, {
        object,
        mesh,
        lights,
        level: tile.level,
        triangles: tile.triangles,
        lastUsed: this.frame,
      });
      this.residentTriangles += tile.triangles;
      this.version++;
    } catch (e) {
      console.warn(`buildings ${tile.key}: ${e}`);
      this.failed.add(tile.key);
    } finally {
      this.inFlight.delete(tile.key);
    }
  }

  private evict() {
    if (this.residentTriangles <= this.maxTriangles) return;
    const idle = [...this.resident].filter(
      ([, entry]) =>
        entry.lastUsed < this.frame && entry.level >= this.index.maxLevel
    );
    idle.sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [key, entry] of idle) {
      if (this.residentTriangles <= this.maxTriangles) break;
      this.remove(entry);
      this.resident.delete(key);
      this.residentTriangles -= entry.triangles;
    }
  }

  private remove({ object, mesh, lights }: TileObjects) {
    this.group.remove(object);
    mesh?.geometry.dispose();
    lights?.geometry.dispose();
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.resident.values()) this.remove(entry);
    this.resident.clear();
  }
}

export interface SelectOptions {
  /** Refine a tile when the camera is closer than its size times this. */
  lodFactor: number;
  /** Never refine past this level. */
  maxLevel?: number;
  /** Terrain height multiplier, for bounding boxes. */
  verticalScale: number;
}

const box = new Box3();
const frustum = new Frustum();
const projScreen = new Matrix4();
const cameraPosition = new Vector3();

function setBox(tile: BuildingTile, verticalScale: number) {
  const b = tile.bounds;
  box.min.set(b.minX, b.minGround * verticalScale - 50, b.minZ);
  box.max.set(b.maxX, b.maxGround * verticalScale + b.maxRel, b.maxZ);
  return box;
}

/**
 * Walks the tile tree from the coarsest level, choosing tiles to draw by
 * camera distance. A tile stays drawn until all of its children in view
 * have loaded, so buildings refine in place instead of blinking out.
 */
export function selectTiles(
  index: BuildingIndex,
  cache: BuildingCache,
  camera: Camera,
  { lodFactor, maxLevel = Infinity, verticalScale }: SelectOptions,
  out: BuildingTile[]
) {
  out.length = 0;
  camera.getWorldPosition(cameraPosition);
  projScreen.multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );
  frustum.setFromProjectionMatrix(projScreen, camera.coordinateSystem);

  const inView = (tile: BuildingTile) =>
    frustum.intersectsBox(setBox(tile, verticalScale));

  const visit = (tile: BuildingTile) => {
    const distance = setBox(tile, verticalScale).distanceToPoint(
      cameraPosition
    );

    if (
      tile.children.length &&
      tile.level < maxLevel &&
      distance < index.tileSize(tile.level) * lodFactor
    ) {
      const children = tile.children.filter(inView);
      for (const child of children) {
        const d = setBox(child, verticalScale).distanceToPoint(cameraPosition);
        cache.request(child, child.level * 1e6 + d);
      }
      if (children.every((child) => cache.ready(child))) {
        children.forEach(visit);
        return;
      }
    }

    // Coarse levels first, then nearest first.
    cache.request(tile, tile.level * 1e6 + distance);
    if (cache.ready(tile)) out.push(tile);
  };

  for (const root of index.roots) {
    if (inView(root)) visit(root);
  }
  return out;
}
