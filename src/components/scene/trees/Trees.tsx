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
import { castsNearShadow } from "../landmarks/nearShadow";
import { TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { windVector } from "../weather";
import { treeAttributes } from "./geometry";
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
}

export const TREES_DESKTOP: TreesQuality = {
  fullDistance: 1100,
  maxDistance: 8000,
  shadows: true,
  maxTrees: 800_000,
};

export const TREES_MOBILE: TreesQuality = {
  fullDistance: 500,
  maxDistance: 4000,
  shadows: false,
  maxTrees: 250_000,
};

/** Thinned crowns grow up to this much, so tile bounds allow for it, m. */
const BOUNDS_MARGIN = 30;
const MAX_IN_FLIGHT = 6;

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
    loadTreeIndex().then(
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

  const { group, material } = useMemo(
    () => ({
      group: new Group(),
      material: createTreeMaterial(index.manifest),
    }),
    [index]
  );

  useEffect(() => {
    treeFullDistance.value = quality.fullDistance;
    treeMaxDistance.value = quality.maxDistance;
  }, [quality]);

  const state = useMemo(
    () => ({
      resident: new Map<string, Resident>(),
      inFlight: new Set<string>(),
      failed: new Set<string>(),
      frame: 0,
      disposed: false,
    }),
    [index]
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
    },
    [state, group, material]
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
          entry.mesh.visible = true;
          entry.mesh.geometry.instanceCount = Math.min(count, loaded);
        }
      }
    }

    wanted.sort((a, b) => a.priority - b.priority);

    for (const { tile, band } of wanted) {
      if (inFlight.size >= MAX_IN_FLIGHT) break;
      load(tile, band);
    }

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
        resident.delete(key);
      }
    }

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
  const { lathe, index } = treeAttributes();
  geometry.setAttribute("lathe", lathe);
  geometry.setIndex(index);
  geometry.setAttribute("tree", new InstancedBufferAttribute(data, 4, true));
  geometry.instanceCount = 0;

  const mesh = new Mesh(geometry, material);
  mesh.userData.tile = new Vector4(tile.minX, tile.minZ, tile.size, tile.count);
  // Culled per tile above; there's no position attribute to bound.
  mesh.frustumCulled = false;
  mesh.visible = false;

  if (shadows) castsNearShadow(mesh);
  else mesh.receiveShadow = true;

  return mesh;
}
