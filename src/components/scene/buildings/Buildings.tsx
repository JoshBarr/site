import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { REFLECTION_LAYER } from "../environment";
import { addLoadingSource, hasFirstViewLoaded, track } from "../loading";
import { castsNearShadow } from "../landmarks/nearShadow";
import { setCityLights } from "../skyglow";
import { switchedOff } from "../stats";
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
   * Load every tile up to this level once the first view is in, wherever
   * the camera is, so panning never finds the distant city missing.
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
    track(loadBuildingIndex()).then(
      (index) => {
        const { origin, rootSize } = terrain.manifest;
        const [e, n] = index.manifest.origin;

        if (
          e !== origin[0] ||
          n !== origin[1] ||
          index.manifest.rootSize !== rootSize
        ) {
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

/**
 * The buildings are drawn in the sea's mirror until lighting-up is this far
 * through: all the way, when the sky's as dark as it gets. What shows of
 * them in the mirror is their mass against the sky (at dusk the harbour off
 * the city goes pale without it); against a night sky there's none to see,
 * and their lights are in the mirror as points regardless. Drawing them in
 * it costs over a millisecond of the overview's frame on an M1, which at
 * night is what took it past a 60 Hz screen's budget (?off=mirrornight to
 * draw them always).
 */
const MIRRORED_UNTIL = 1;

function BuildingTiles({
  index,
  quality,
}: {
  index: BuildingIndex;
  quality: BuildingsQuality;
}) {
  const camera = useThree((state) => state.camera);

  const { cache, material, lightsMaterial } = useMemo(() => {
    const material = createBuildingMaterial(index.manifest);
    const lightsMaterial = createLightsMaterial();

    const cache = new BuildingCache(index, material, lightsMaterial, {
      maxTriangles: quality.maxTriangles,
      setup: ({ mesh, lights }) => {
        if (mesh) castsNearShadow(mesh);

        // The lights are in the sea's mirror always; the buildings by the
        // frame (see MIRRORED_UNTIL).
        if (quality.reflections) lights?.layers.enable(REFLECTION_LAYER);
      },
    });

    return { cache, material, lightsMaterial };
  }, [index, quality]);

  useEffect(
    () =>
      addLoadingSource(
        () => cache.loading,
        () => cache.queued
      ),
    [cache]
  );

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

  const alwaysMirrored = useMemo(() => switchedOff("mirrornight"), []);
  const selected = useRef<BuildingTile[]>([]);
  const visible = useRef(new Set<TileObjects>());

  // With the vertical scale filled in per frame.
  const options = useMemo(() => ({ ...quality, verticalScale: 1 }), [quality]);

  useFrame(() => {
    options.verticalScale = verticalScale.value;
    selectTiles(index, cache, camera, options, selected.current);

    // After the first view: on a cold cache it's hundreds of tiles.
    if (hasFirstViewLoaded()) {
      for (const tile of preload) {
        cache.request(tile, PRELOAD_PRIORITY + tile.level * 1e6, true);
      }
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

    const mirrored =
      quality.reflections &&
      (alwaysMirrored || windowLights.value < MIRRORED_UNTIL);

    for (const { object, mesh, lights } of next) {
      object.visible = true;

      if (mirrored) mesh?.layers.enable(REFLECTION_LAYER);
      else mesh?.layers.disable(REFLECTION_LAYER);

      if (lights) lights.visible = lit;
    }

    visible.current = next;
    cache.update();
  });

  return <primitive object={cache.group} name="buildings" />;
}
