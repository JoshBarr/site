import { useEffect, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  Box3,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Material,
  Matrix4,
  Mesh,
  Vector3,
  Vector4,
} from "three/webgpu";
import { castsNearShadow, nearShadowFrustum } from "../landmarks/nearShadow";
import { addLoadingSource, countLoaded, track } from "../loading";
import { TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { windVector } from "../weather";
import { FAR_RANGES, treeAttributes } from "./geometry";
import {
  bandEnd,
  loadTreeIndex,
  TREE_BYTES,
  TreeIndex,
  TreeTile,
} from "./manifest";
import {
  createTreeMaterial,
  drawnShare,
  treeFullDistance,
  treeMaxDistance,
  treeNearDistance,
  treeViewer,
  treeWind,
} from "./material";

export interface TreesQuality {
  /** Every tree is drawn this close, m; further out, fewer. */
  fullDistance: number;
  /** None beyond, m. */
  maxDistance: number;
  /** Cast into the near shadow map. */
  shadows: boolean;
  /** Trees kept loaded, drawn or not. */
  maxTrees: number;
  /** Closer than this, m, trees get lobed crowns. Inside fullDistance. */
  nearDistance: number;
}

export const TREES_DESKTOP: TreesQuality = {
  fullDistance: 1100,
  maxDistance: 8000,
  shadows: true,
  maxTrees: 800_000,
  nearDistance: 200,
};

export const TREES_MOBILE: TreesQuality = {
  fullDistance: 500,
  maxDistance: 4000,
  shadows: false,
  maxTrees: 250_000,
  nearDistance: 100,
};

/** Thinned crowns grow up to this much, so tile bounds allow for it, m. */
const BOUNDS_MARGIN = 30;
const MAX_IN_FLIGHT = 6;

/**
 * Near trees are gathered this far past the near distance, and again once
 * the camera has moved half of it: the shader picks each frame which of
 * them are close enough, m.
 */
const NEAR_SLACK = 40;

/** Tiles further than this draw their trees' lobes as octahedra, m. */
const DISTANT = 700;

interface Resident {
  /** Trees loaded so far, in the tile's order. */
  data: Uint16Array;
  /** Bands loaded. */
  bands: number;
  mesh?: Mesh<InstancedBufferGeometry>;
  lastUsed: number;
}

/**
 * Trees found in the lidar (see scripts/trees/build_trees.py): every
 * street tree, back-yard tree and the town belt's pines, streamed in tiles
 * around the camera. Distant tiles fetch and draw only a share of theirs,
 * the bigger trees first.
 */
export function Trees({
  terrain,
  quality,
  wind,
}: {
  terrain: TileIndex;
  quality: TreesQuality;
  wind: { speed: number; direction: number };
}) {
  const [index, setIndex] = useState<TreeIndex | null>(null);

  useEffect(() => {
    const [x, z] = windVector(wind.speed, wind.direction);
    treeWind.value.set(x, z);
  }, [wind]);

  useEffect(() => {
    track(loadTreeIndex()).then(
      (index) => {
        const { origin, rootSize } = terrain.manifest;
        const [e, n] = index.manifest.origin;

        if (
          e !== origin[0] ||
          n !== origin[1] ||
          index.manifest.rootSize !== rootSize
        ) {
          throw new Error("trees were built for a different terrain frame");
        }

        setIndex(index);
      },
      (e) => console.error(e)
    );
  }, [terrain]);

  return index && <TreeTiles index={index} quality={quality} />;
}

const box = new Box3();
const frustum = new Frustum();
const shadowFrustum = new Frustum();
const projScreen = new Matrix4();
const cameraPosition = new Vector3();

function setBox(tile: TreeTile) {
  const scale = verticalScale.value;
  box.min.set(
    tile.minX - BOUNDS_MARGIN,
    tile.minGround * scale - BOUNDS_MARGIN,
    tile.minZ - BOUNDS_MARGIN
  );
  box.max.set(
    tile.minX + tile.size + BOUNDS_MARGIN,
    tile.maxGround * scale + tile.maxHeight * 1.5,
    tile.minZ + tile.size + BOUNDS_MARGIN
  );

  return box;
}

function TreeTiles({
  index,
  quality,
}: {
  index: TreeIndex;
  quality: TreesQuality;
}) {
  const camera = useThree((state) => state.camera);

  const { group, material, near } = useMemo(() => {
    const group = new Group();
    // Tiles are placed in the shader; their matrices never change.
    group.matrixAutoUpdate = false;

    const near = new NearTrees(createTreeMaterial(index.manifest, "near"));
    near.groundEncoding = index.manifest.encoding.ground;
    group.add(near.mesh);

    return {
      group,
      material: createTreeMaterial(index.manifest, "far"),
      near,
    };
  }, [index]);

  useEffect(() => {
    treeFullDistance.value = quality.fullDistance;
    treeMaxDistance.value = quality.maxDistance;
    treeNearDistance.value = Math.min(
      quality.nearDistance,
      quality.fullDistance
    );
    near.shadows(quality.shadows);
  }, [quality, near]);

  const state = useMemo(
    () => ({
      resident: new Map<string, Resident>(),
      inFlight: new Set<string>(),
      failed: new Set<string>(),
      /** Bands wanted last frame but not started. */
      queued: 0,
      frame: 0,
      disposed: false,
    }),
    [index]
  );

  useEffect(
    () =>
      addLoadingSource(
        () => state.inFlight.size,
        () => state.queued
      ),
    [state]
  );

  useEffect(
    () => () => {
      state.disposed = true;

      for (const entry of state.resident.values()) {
        entry.mesh?.geometry.dispose();
      }

      state.resident.clear();
      group.clear();
      material.dispose();
      near.dispose();
    },
    [state, group, material, near]
  );

  useFrame(() => {
    const { resident, inFlight, failed } = state;
    const { bands } = index.manifest;
    camera.getWorldPosition(cameraPosition);
    treeViewer.value.copy(cameraPosition);
    projScreen.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    frustum.setFromProjectionMatrix(projScreen, camera.coordinateSystem);

    // Only tiles inside the near shadow map cast into it; the rest would
    // be drawn into it only to be clipped.
    nearShadowFrustum(shadowFrustum);

    const wanted: { tile: TreeTile; band: number; priority: number }[] = [];
    let loadedTrees = 0;

    for (const tile of index.tiles) {
      const entry = resident.get(tile.key);

      if (entry) loadedTrees += entry.data.length / 4;
      const distance = setBox(tile).distanceToPoint(cameraPosition);
      const share = drawnShare(distance);
      const inView = share > 0 && frustum.intersectsBox(box);
      const count = inView ? Math.ceil(tile.count * share) : 0;

      if (!count) {
        if (entry?.mesh) entry.mesh.visible = false;
        continue;
      }

      const loaded = entry ? entry.data.length / 4 : 0;
      const bandsLoaded = entry?.bands ?? 0;

      if (
        loaded < count &&
        bandsLoaded < bands.length &&
        !inFlight.has(tile.key) &&
        !failed.has(tile.key)
      ) {
        // Coarse bands first, everywhere; then nearest first.
        wanted.push({
          tile,
          band: bandsLoaded,
          priority: bandsLoaded * 1e6 + distance,
        });
      }

      if (entry) {
        entry.lastUsed = state.frame;

        if (entry.mesh) {
          const { mesh } = entry;
          mesh.visible = true;
          mesh.geometry.instanceCount = Math.min(count, loaded);

          const { start, count: indices } =
            FAR_RANGES[distance > DISTANT ? 1 : 0];

          mesh.geometry.setDrawRange(start, indices);

          if (quality.shadows) {
            mesh.castShadow = shadowFrustum.intersectsBox(box);
          }
        }
      }
    }

    wanted.sort((a, b) => a.priority - b.priority);

    let started = 0;

    for (const { tile, band } of wanted) {
      if (inFlight.size >= MAX_IN_FLIGHT) break;
      load(tile, band);
      started++;
    }

    state.queued = wanted.length - started;

    // Over budget: drop the tiles unused longest, whole.
    if (loadedTrees > quality.maxTrees) {
      const idle = [...resident].filter(
        ([key, entry]) => entry.lastUsed < state.frame && !inFlight.has(key)
      );

      idle.sort(([, a], [, b]) => a.lastUsed - b.lastUsed);

      for (const [key, entry] of idle) {
        if (loadedTrees <= quality.maxTrees) break;
        loadedTrees -= entry.data.length / 4;
        remove(entry);
        near.invalidate();
        resident.delete(key);
      }
    }

    near.update(index.tiles, resident, cameraPosition, treeNearDistance.value);
    state.frame++;
  });

  function remove(entry: Resident) {
    if (!entry.mesh) return;
    group.remove(entry.mesh);
    entry.mesh.geometry.dispose();
  }

  async function load(tile: TreeTile, band: number) {
    const { resident, inFlight, failed } = state;
    const { bands } = index.manifest;
    inFlight.add(tile.key);

    try {
      const start = band ? bandEnd(tile.count, bands[band - 1]) : 0;
      const end = bandEnd(tile.count, bands[band]);
      let added = new Uint16Array(0);

      // Small tiles can have an empty band, with no file.
      if (end > start) {
        const response = await fetch(index.url(tile, band));

        if (!response.ok) throw new Error(`${response.status}`);
        added = new Uint16Array(await response.arrayBuffer());

        if (added.length * 2 !== (end - start) * TREE_BYTES) {
          throw new Error("unexpected size");
        }
      }

      if (state.disposed) return;

      const previous = resident.get(tile.key);
      const data = new Uint16Array((previous?.data.length ?? 0) + added.length);

      if (previous) data.set(previous.data);
      data.set(added, previous?.data.length ?? 0);

      if (previous) remove(previous);

      const mesh = data.length
        ? createTileMesh(tile, data, material, quality.shadows)
        : undefined;

      if (mesh) group.add(mesh);
      near.invalidate();
      resident.set(tile.key, {
        data,
        bands: band + 1,
        mesh,
        lastUsed: state.frame,
      });
    } catch (e) {
      console.warn(`trees ${tile.key}/${band}: ${e}`);
      failed.add(tile.key);
    } finally {
      inFlight.delete(tile.key);
      countLoaded();
    }
  }

  return <primitive object={group} name="trees" />;
}

function createTileMesh(
  tile: TreeTile,
  data: Uint16Array,
  material: Material,
  shadows: boolean
) {
  const geometry = new InstancedBufferGeometry();
  const { lobe, index } = treeAttributes("far");
  geometry.setAttribute("lobe", lobe);
  geometry.setIndex(index);
  geometry.setAttribute("tree", new InstancedBufferAttribute(data, 4, true));
  geometry.instanceCount = 0;

  const mesh = new Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.userData.tile = new Vector4(tile.minX, tile.minZ, tile.size, tile.count);
  // Culled per tile above; there's no position attribute to bound.
  mesh.frustumCulled = false;
  mesh.visible = false;

  if (shadows) castsNearShadow(mesh);
  else mesh.receiveShadow = true;

  return mesh;
}

/**
 * The trees close to the camera, drawn with lobed crowns: copied out of the
 * resident tiles into one instanced mesh whenever the camera has moved far
 * enough or tiles have come or gone.
 */
class NearTrees {
  readonly mesh: Mesh<InstancedBufferGeometry>;
  private material: Material;
  private capacity = 0;
  private trees = new Uint16Array(0);
  private tiles = new Float32Array(0);
  private attributes: InstancedBufferAttribute[] = [];
  private gatheredAt = new Vector3(Infinity, 0, 0);
  private stale = true;
  private castsShadows = false;

  constructor(material: Material) {
    this.material = material;
    this.mesh = new Mesh(this.allocate(4096), material);
    this.mesh.matrixAutoUpdate = false;
    // Placed in the shader; there's no position attribute to bound.
    this.mesh.frustumCulled = false;
    this.mesh.name = "near trees";
  }

  shadows(on: boolean) {
    this.castsShadows = on;

    if (on) castsNearShadow(this.mesh);
    else this.mesh.receiveShadow = true;
  }

  invalidate() {
    this.stale = true;
  }

  update(
    tiles: TreeTile[],
    resident: Map<string, Resident>,
    camera: Vector3,
    nearDistance: number
  ) {
    if (
      !this.stale &&
      camera.distanceToSquared(this.gatheredAt) < (NEAR_SLACK / 2) ** 2
    ) {
      return;
    }

    this.stale = false;
    this.gatheredAt.copy(camera);
    const reach = nearDistance + NEAR_SLACK;
    const scale = verticalScale.value;
    let count = 0;

    for (const tile of tiles) {
      const entry = resident.get(tile.key);

      if (!entry || setBox(tile).distanceToPoint(camera) > reach) continue;
      const { data } = entry;
      const { minX, minZ, size } = tile;
      const unit = size / 65535;
      const { scale: groundScale, offset } = this.groundEncoding;

      for (let i = 0; i < data.length; i += 4) {
        const dx = minX + data[i] * unit - camera.x;
        const dz = minZ + data[i + 1] * unit - camera.z;
        const dy = (data[i + 2] / groundScale - offset) * scale - camera.y;

        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;

        if (count === this.capacity) {
          this.mesh.geometry.dispose();
          this.mesh.geometry = this.allocate(this.capacity * 2, count);
        }

        this.trees.set(data.subarray(i, i + 4), count * 4);
        this.tiles[count * 4] = minX;
        this.tiles[count * 4 + 1] = minZ;
        this.tiles[count * 4 + 2] = size;
        this.tiles[count * 4 + 3] = tile.count;
        count++;
      }
    }

    const geometry = this.mesh.geometry;
    geometry.instanceCount = count;
    this.mesh.visible = count > 0;

    for (const attribute of this.attributes) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * 4);
      attribute.needsUpdate = true;
    }
  }

  /** Set by the owner from the manifest. */
  groundEncoding = { scale: 1, offset: 0 };

  /** A geometry for `capacity` trees, keeping the first `keep` of the old. */
  private allocate(capacity: number, keep = 0) {
    const trees = new Uint16Array(capacity * 4);
    const tiles = new Float32Array(capacity * 4);
    trees.set(this.trees.subarray(0, keep * 4));
    tiles.set(this.tiles.subarray(0, keep * 4));
    this.trees = trees;
    this.tiles = tiles;
    this.capacity = capacity;

    const geometry = new InstancedBufferGeometry();
    const { lobe, index } = treeAttributes("near");
    geometry.setAttribute("lobe", lobe);
    geometry.setIndex(index);
    this.attributes = [
      new InstancedBufferAttribute(trees, 4, true),
      new InstancedBufferAttribute(tiles, 4),
    ];
    geometry.setAttribute("tree", this.attributes[0]);
    geometry.setAttribute("treeTile", this.attributes[1]);
    geometry.instanceCount = 0;

    if (this.mesh) {
      this.mesh.geometry = geometry;

      if (this.castsShadows) castsNearShadow(this.mesh);
    }

    return geometry;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
