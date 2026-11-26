import { useCallback, useMemo } from "react";
import { useWaterMesh, type WaterLook } from "../lakes/water";
import { useCalmSea } from "../ocean/calm";
import type { TileIndex } from "../terrain/manifest";
import { createRiversGeometry, type RiversFile } from "./geometry";

const RIVERS_URL = process.env.NEXT_PUBLIC_RIVERS_URL ?? "/rivers";

/**
 * Shallow over grey gravel, a little lighter than a lake, still dark enough
 * to read as water against the shingle beside it. Out on a valley's floor
 * the far bank's low, so the sky's in more of it than a lake's.
 */
const LOOK: WaterLook = { reflectance: 0.03, banks: 0.05, fades: true };

/**
 * Te Awa Kairangi / the Hutt, the Wainuiomata and the Ōrongorongo
 * (scripts/rivers): ribbons on their water's surface as the lidar has it,
 * falling to the sea. Down at its level they're shaded as it is (see
 * `sea` in ../lakes/water.ts), so what fades out into it past the coast is
 * the same water. `sea` is whether there's one drawn for them to run into:
 * they wait for it.
 */
export function Rivers({ index, sea }: { index: TileIndex; sea: boolean }) {
  const build = useCallback(
    // rivers.json is built by scripts/rivers/build_rivers.py as a
    // RiversFile, and deployed with the app.
    (file: RiversFile) => createRiversGeometry(file, index.manifest.origin),
    [index]
  );

  const calm = useCalmSea();

  const look = useMemo(
    () => (!sea ? LOOK : calm ? { ...LOOK, sea: calm } : null),
    [sea, calm]
  );

  const mesh = useWaterMesh(`${RIVERS_URL}/rivers.json`, build, look);

  return mesh && <primitive object={mesh} name="rivers" />;
}
