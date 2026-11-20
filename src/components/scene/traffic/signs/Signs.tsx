import { useEffect, useMemo, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three/webgpu";
import { PAGE_TIME } from "../../../../lib/signs";
import { sceneNow } from "../../clock";
import { nztmToWorld, type TileIndex } from "../../terrain/manifest";
import { loadRoads, type Place, type Roads } from "../roads";
import { createSigns } from "./build";
import { loadSigns, type SignsFile } from "./file";
import { type Ground, placeAll } from "./layout";
import { overrideFromUrl, useSigns } from "./useSigns";

/** Signs are drawn this near the camera, m: beyond, a gantry's a pixel or two. */
const RANGE = 7000;

const eye = new Vector3();
const scratch: Place = { x: 0, y: 0, z: 0 };

/** The road, as the layout asks after it. */
function groundOf(roads: Roads, index: TileIndex): Ground {
  const byName = new Map(roads.carriageways.map((c) => [c.name, c]));

  return {
    toWorld: (easting, northing) =>
      nztmToWorld(index.manifest, easting, northing),
    at(on, s) {
      const c = byName.get(on);

      if (!c) return null;
      const i = c.placeAt(s, 0, scratch);
      const tx = c.x[i + 1] - c.x[i];
      const tz = c.z[i + 1] - c.z[i];
      const l = Math.hypot(tx, tz) || 1;

      return { y: scratch.y, tx: tx / l, tz: tz / l, limit: c.limit[i] };
    },
  };
}

/** The signs standing along `roads`, their message signs showing NZTA's messages. */
function Standing({
  roads,
  file,
  index,
  lights,
}: {
  roads: Roads;
  file: SignsFile;
  index: TileIndex;
  lights: number;
}) {
  const messages = useSigns();
  const override = useMemo(overrideFromUrl, []);

  const signs = useMemo(
    () => createSigns(placeAll(file, groundOf(roads, index))),
    [roads, file, index]
  );

  // The painted faces, once: off the frame that set the signs up.
  useEffect(() => {
    const timer = setTimeout(() => signs.paint(), 0);

    return () => clearTimeout(timer);
  }, [signs]);

  useEffect(() => {
    signs.show(messages, override);
  }, [signs, messages, override]);

  useEffect(() => {
    signs.night.value = lights;
  }, [signs, lights]);

  useEffect(() => () => signs.dispose(), [signs]);

  useFrame(({ camera }) => {
    camera.getWorldPosition(eye);

    for (const mesh of signs.meshes) {
      mesh.visible = mesh.geometry.boundingBox!.distanceToPoint(eye) < RANGE;
    }

    // Two-page messages take turns, on the scene's clock.
    signs.page.value = Math.floor(sceneNow() / (PAGE_TIME * 1000)) % 2;
  });

  return <primitive object={signs.group} name="signs" />;
}

/**
 * The signs along State Highways 1 and 2: NZTA's message signs showing
 * what they show now (travel times, closures, or nothing), and the fixed
 * ones there's a record of (direction signs worded as OpenStreetMap has
 * them, speed limits where they change), on gantries, arms and posts.
 * `lights` (0..1) is how far through lighting-up it is. `?vms=TEXT` puts
 * TEXT on every message sign.
 */
export function Signs({
  index,
  lights = 0,
}: {
  index: TileIndex;
  lights?: number;
}) {
  const [roads, setRoads] = useState<Roads | null>(null);
  const [file, setFile] = useState<SignsFile | null>(null);

  useEffect(() => {
    loadRoads(index).then(setRoads, (e) => console.error(e));
    loadSigns().then(setFile, (e) => console.error(e));
  }, [index]);

  if (!roads || !file) return null;

  return <Standing roads={roads} file={file} index={index} lights={lights} />;
}
