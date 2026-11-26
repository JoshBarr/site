import { useCallback } from "react";
import type { TileIndex } from "../terrain/manifest";
import { createLakesGeometry, type LakesFile } from "./geometry";
import { useWaterMesh, type WaterLook } from "./water";

const LAKES_URL = process.env.NEXT_PUBLIC_LAKES_URL ?? "/lakes";

/**
 * A reservoir's dark, peaty and still, darker than the sea's shallows, and
 * down in a valley.
 */
const LOOK: WaterLook = { reflectance: 0.012, banks: 0.2 };

/**
 * Lakes, reservoirs and ponds (scripts/lakes), each a flat sheet at its
 * water's level: the sea's drawn at sea level only, so Zealandia's
 * reservoirs and the like were bare ground.
 */
export function Lakes({ index }: { index: TileIndex }) {
  const build = useCallback(
    // lakes.json is built by scripts/lakes/build_lakes.py as a
    // LakesFile, and deployed with the app.
    (file: LakesFile) => createLakesGeometry(file, index.manifest.origin),
    [index]
  );

  const mesh = useWaterMesh(`${LAKES_URL}/lakes.json`, build, LOOK);

  return mesh && <primitive object={mesh} name="lakes" />;
}
