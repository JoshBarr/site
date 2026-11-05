import {
  DataArrayTexture,
  LinearFilter,
  FloatType,
  NearestFilter,
  RedFormat,
  RGFormat,
  UnsignedByteType,
} from "three/webgpu";
import { countLoaded } from "../loading";
import { TileIndex, TileInfo, tileKey } from "./manifest";

interface Pending {
  tile: TileInfo;
  priority: number;
}

/** Cubic B-spline weights for samples i-1..i+2, as the terrain shader's. */
function bspline(f: number, out: Float64Array) {
  const g = 1 - f;
  const f2 = f * f;
  const f3 = f2 * f;
  out[0] = (g * g * g) / 6;
  out[1] = (3 * f3 - 6 * f2 + 4) / 6;
  out[2] = (-3 * f3 + 3 * f2 + 3 * f + 1) / 6;
  out[3] = f3 / 6;
}

const wu = new Float64Array(4);
const wv = new Float64Array(4);

/** Tiles at or below this level are never evicted, so there is always a fallback. */
const PINNED_LEVEL = 1;

/**
 * Streams height tiles into a fixed pool of layers in one array texture.
 * Callers say which tiles they want each frame; the cache loads the most
 * important ones and evicts least-recently-used layers.
 */
export class TileCache {
  readonly texture: DataArrayTexture;
  /**
   * In the same layers: relief (R; ridges and gullies, 0.5 level) and
   * building cover (G).
   */
  readonly ground: DataArrayTexture;
  /** In the same layers: distance from the nearest street's kerb, encoded. */
  readonly roads: DataArrayTexture;
  readonly slots: number;
  /** Bumped whenever a tile finishes loading. */
  version = 0;

  /** What `texture` and `ground` hold, slot after slot. */
  private heights: Float32Array;
  private grounds: Uint8Array;
  private roadFields: Uint8Array;

  private index: TileIndex;
  private slotByKey = new Map<string, number>();
  private keyBySlot: (string | null)[];
  private lastUsed: Int32Array;
  private frame = 0;

  private wanted = new Map<string, Pending>();
  /** Asked for last frame, but not started. */
  private waiting = 0;
  private inFlight = new Set<string>();
  private failed = new Set<string>();
  private maxInFlight: number;

  private workers: Worker[] = [];
  private nextWorker = 0;
  private nextId = 0;
  private callbacks = new Map<
    number,
    (result: {
      heights?: Float32Array;
      ground?: Uint8Array;
      roads?: Uint8Array;
      error?: string;
    }) => void
  >();

  constructor(index: TileIndex, slots: number, workers = 3) {
    this.index = index;
    this.slots = slots;
    this.keyBySlot = Array.from({ length: slots }, () => null);
    this.lastUsed = new Int32Array(slots).fill(-1);
    this.maxInFlight = workers * 2;

    const size = index.samples;
    this.heights = new Float32Array(size * size * slots);

    this.texture = new DataArrayTexture(this.heights, size, size, slots);
    this.texture.format = RedFormat;
    this.texture.type = FloatType;
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    this.grounds = new Uint8Array(size * size * 2 * slots);

    this.ground = new DataArrayTexture(this.grounds, size, size, slots);
    this.ground.format = RGFormat;
    this.ground.type = UnsignedByteType;
    // Filtered by the GPU: one bilinear sample instead of four loads.
    this.ground.magFilter = LinearFilter;
    this.ground.minFilter = LinearFilter;
    this.ground.generateMipmaps = false;
    this.ground.needsUpdate = true;

    this.roadFields = new Uint8Array(size * size * slots);

    this.roads = new DataArrayTexture(this.roadFields, size, size, slots);
    this.roads.format = RedFormat;
    this.roads.type = UnsignedByteType;
    this.roads.magFilter = LinearFilter;
    this.roads.minFilter = LinearFilter;
    this.roads.generateMipmaps = false;
    this.roads.needsUpdate = true;

    for (let i = 0; i < workers; i++) {
      const worker = new Worker(new URL("./tileWorker.ts", import.meta.url));
      worker.onmessage = (event) => {
        const { id, ...result } = event.data;
        this.callbacks.get(id)?.(result);
        this.callbacks.delete(id);
      };

      this.workers.push(worker);
    }
  }

  /**
   * Terrain height (unscaled) at a world x/z from the finest loaded tile, or
   * undefined if nothing covering it is loaded. For CPU queries like keeping
   * the camera above ground, so it's the same cubic B-spline the terrain is
   * drawn with: that rides up to a few metres above the samples in gullies.
   */
  heightAt(x: number, z: number): number | undefined {
    const { manifest, samples } = this.index;
    const { rootSize, tileCells, apron } = manifest;
    const data = this.heights;
    const last = samples - 1;

    for (let level = this.index.maxLevel; level >= 0; level--) {
      const size = this.index.tileSize(level);
      const tx = Math.floor((x + rootSize / 2) / size);
      const ty = Math.floor((z + rootSize / 2) / size);
      const slot = this.slotByKey.get(tileKey(level, tx, ty));

      if (slot === undefined) continue;

      const [ox, oz] = this.index.tileOrigin(level, tx, ty);
      const u = ((x - ox) / size) * tileCells + apron;
      const v = ((z - oz) / size) * tileCells + apron;
      const i = Math.floor(u);
      const j = Math.floor(v);
      bspline(u - i, wu);
      bspline(v - j, wv);
      const base = slot * samples * samples;
      let height = 0;

      for (let b = 0; b < 4; b++) {
        const row = base + Math.min(Math.max(j + b - 1, 0), last) * samples;

        for (let a = 0; a < 4; a++) {
          const column = Math.min(Math.max(i + a - 1, 0), last);
          height += data[row + column] * wu[a] * wv[b];
        }
      }

      return height;
    }

    return undefined;
  }

  /** Layer holding this tile, or undefined. Marks the tile as in use. */
  use(tile: TileInfo): number | undefined {
    const slot = this.slotByKey.get(tileKey(tile.level, tile.x, tile.y));

    if (slot !== undefined) {
      this.lastUsed[slot] = this.frame;
    }

    return slot;
  }

  /** Ask for a tile this frame. Lower priority values load first. */
  request(tile: TileInfo, priority: number) {
    const key = tileKey(tile.level, tile.x, tile.y);

    if (
      this.slotByKey.has(key) ||
      this.inFlight.has(key) ||
      this.failed.has(key)
    ) {
      return;
    }

    const existing = this.wanted.get(key);

    if (!existing || priority < existing.priority) {
      this.wanted.set(key, { tile, priority });
    }
  }

  /** Call once per frame after all `use`/`request` calls. */
  update() {
    const queue = [...this.wanted.values()].sort(
      (a, b) => a.priority - b.priority
    );

    this.wanted.clear();

    // Only start loads there's room for. When every layer is in use, a new
    // tile would be dropped on arrival and requested again: a reload loop.
    const room = this.evictableSlots() - this.inFlight.size;
    let started = 0;

    for (const { tile } of queue.slice(0, Math.max(0, room))) {
      if (this.inFlight.size >= this.maxInFlight) break;
      this.load(tile);
      started++;
    }

    this.waiting = queue.length - started;

    this.frame++;
  }

  private evictableSlots() {
    let count = 0;

    for (let slot = 0; slot < this.slots; slot++) {
      if (
        this.keyBySlot[slot] === null ||
        this.lastUsed[slot] < this.frame - 1
      ) {
        count++;
      }
    }

    return count;
  }

  get loading() {
    return this.inFlight.size;
  }

  /** Tiles wanted but not yet started. */
  get queued() {
    return this.waiting;
  }

  dispose() {
    for (const worker of this.workers) worker.terminate();
    this.texture.dispose();
    this.ground.dispose();
    this.roads.dispose();
  }

  private load(tile: TileInfo) {
    const key = tileKey(tile.level, tile.x, tile.y);
    const { offset, scale } = this.index.manifest.encoding;
    const id = this.nextId++;

    const url = new URL(
      this.index.url(tile.level, tile.x, tile.y),
      location.href
    ).href;

    this.inFlight.add(key);
    this.callbacks.set(id, ({ heights, ground, roads, error }) => {
      this.inFlight.delete(key);
      countLoaded();

      if (error || !heights || !ground || !roads) {
        console.warn("[terrain]", error);
        this.failed.add(key);

        return;
      }

      this.store(key, tile.level, heights, ground, roads);
    });

    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    worker.postMessage({ id, url, offset, scale });
  }

  private store(
    key: string,
    level: number,
    heights: Float32Array,
    ground: Uint8Array,
    roads: Uint8Array
  ) {
    const slot = this.freeSlot();

    if (slot === undefined) return;

    const previous = this.keyBySlot[slot];

    if (previous) this.slotByKey.delete(previous);

    this.keyBySlot[slot] = key;
    this.slotByKey.set(key, slot);
    // Count as used now so it survives until the next selection pass.
    this.lastUsed[slot] = level <= PINNED_LEVEL ? 0x7fffffff : this.frame;

    this.heights.set(heights, slot * heights.length);
    this.texture.addLayerUpdate(slot);
    this.texture.needsUpdate = true;
    this.grounds.set(ground, slot * ground.length);
    this.ground.addLayerUpdate(slot);
    this.ground.needsUpdate = true;
    this.roadFields.set(roads, slot * roads.length);
    this.roads.addLayerUpdate(slot);
    this.roads.needsUpdate = true;
    this.version++;
  }

  private freeSlot(): number | undefined {
    let oldest: number | undefined;

    for (let slot = 0; slot < this.slots; slot++) {
      if (this.keyBySlot[slot] === null) return slot;

      // Loads land between frames, after update() has advanced the counter,
      // so protect whatever the last selection pass drew.
      if (this.lastUsed[slot] >= this.frame - 1) continue;

      if (oldest === undefined || this.lastUsed[slot] < this.lastUsed[oldest]) {
        oldest = slot;
      }
    }

    return oldest;
  }
}
