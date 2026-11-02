import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { REFLECTION_LAYER } from "../environment";
import { castsNearShadow } from "../landmarks/nearShadow";
import { setCityLights } from "../skyglow";
import { TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { createLightsMaterial } from "./lights";
import { BuildingIndex, BuildingTile, loadBuildingIndex } from "./manifest";
import { createBuildingMaterial, windowLights, windowsLit } from "./material";
import { BuildingCache, selectTiles, TileObjects } from "./tiles";

export interface BuildingsQuality {
  lodFactor: number;
  /** Finest level to draw. */
  maxLevel?: number;
  /** Triangles kept loaded, drawn or not. */
  maxTriangles: number;
  /** Draw into the harbour's reflection too. */
  reflections: boolean;
  /**
   * Load every tile up to this level from the start, wherever the camera
   * is, so panning never finds the distant city missing.
   */
  preloadLevel: number;
}

export const BUILDINGS_DESKTOP: BuildingsQuality = {
  lodFactor: 2.5,
  // A whole turn over Newtown or Kilbirnie needs ~1.7M.
  maxTriangles: 2_500_000,
  reflections: true,
  // ~4 MB.
  preloadLevel: 6,
};

// Houses are only in the finest level, so mobile keeps it, just closer in.
export const BUILDINGS_MOBILE: BuildingsQuality = {
  lodFactor: 1.2,
  maxTriangles: 1_000_000,
  reflections: false,
  // ~1.3 MB.
  preloadLevel: 5,
};

/** Behind anything in view, when it comes to loading. */
const PRELOAD_PRIORITY = 1e9;

/**
 * Wellington City's buildings, streamed in tiles over the
 * terrain. They cast into the near shadow map, so mount them alongside
 * something that fits it to the view (Landmarks does). `lights` (0..1), how
 * far through lighting-up, turns on their windows one by one, for night, up
 * to `occupancy` of them lit; the coarser
 * tiles draw the buildings they leave out as points of light, and the city
 * lights the haze (see skyglow).
 */
export function Buildings({
  terrain,
  quality,
  lights = 0,
  occupancy = 0.4,
}: {
  terrain: TileIndex;
  quality: BuildingsQuality;
  lights?: number;
  occupancy?: number;
}) {
  const [index, setIndex] = useState<BuildingIndex | null>(null);

  useEffect(() => {
    windowLights.value = lights;
    windowsLit.value = occupancy;
  }, [lights, occupancy]);

  useEffect(() => {
    loadBuildingIndex().then(
      (index) => {
        const { origin, rootSize } = terrain.manifest;
        const [e, n] = index.manifest.origin;
        if (e !== origin[0] || n !== origin[1] || index.manifest.rootSize !== rootSize) {
          throw new Error("buildings were built for a different terrain frame");
        }
        const finest = index.manifest.levels.find(
          ({ level }) => level === index.maxLevel
        )!;
        setCityLights(
          rootSize,
          2 ** index.maxLevel,
          finest.tiles.map(([x, y, , , , , , , , , , , windowWall = 0]) => ({
            x,
            y,
            windowWall,
          }))
        );
        setIndex(index);
      },
      (e) => console.error(e)
    );
  }, [terrain]);

  return index && <BuildingTiles index={index} quality={quality} />;
}

function BuildingTiles({
  index,
  quality,
}: {
  index: BuildingIndex;
  quality: BuildingsQuality;
}) {
  const camera = useThree((state) => state.camera);

  const { cache, material, lightsMaterial } = useMemo(() => {
    const material = createBuildingMaterial(index.manifest.encoding);
    const lightsMaterial = createLightsMaterial();
    const cache = new BuildingCache(index, material, lightsMaterial, {
      maxTriangles: quality.maxTriangles,
      setup: ({ mesh, lights }) => {
        if (mesh) castsNearShadow(mesh);
        if (quality.reflections) {
          mesh?.layers.enable(REFLECTION_LAYER);
          lights?.layers.enable(REFLECTION_LAYER);
        }
      },
    });
    return { cache, material, lightsMaterial };
  }, [index, quality]);

  useEffect(
    () => () => {
      cache.dispose();
      material.dispose();
      lightsMaterial.dispose();
    },
    [cache, material, lightsMaterial]
  );

  const preload = useMemo(() => {
    const tiles: BuildingTile[] = [];
    const visit = (tile: BuildingTile) => {
      if (tile.level > quality.preloadLevel) return;
      tiles.push(tile);
      tile.children.forEach(visit);
    };
    index.roots.forEach(visit);
    return tiles;
  }, [index, quality]);

  const selected = useRef<BuildingTile[]>([]);
  const visible = useRef(new Set<TileObjects>());

  useFrame(() => {
    selectTiles(
      index,
      cache,
      camera,
      { ...quality, verticalScale: verticalScale.value },
      selected.current
    );
    for (const tile of preload) {
      cache.request(tile, PRELOAD_PRIORITY + tile.level * 1e6);
    }
    const next = new Set<TileObjects>();
    for (const tile of selected.current) {
      const objects = cache.use(tile);
      if (objects) next.add(objects);
    }
    for (const objects of visible.current) {
      if (!next.has(objects)) objects.object.visible = false;
    }
    const lit = windowLights.value > 0;
    for (const { object, lights } of next) {
      object.visible = true;
      if (lights) lights.visible = lit;
    }
    visible.current = next;
    cache.update();
  });

  return <primitive object={cache.group} />;
}
