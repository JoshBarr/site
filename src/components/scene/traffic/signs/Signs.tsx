import { useEffect, useMemo, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three/webgpu";
import { PAGE_TIME } from "../../../../lib/signs";
import { sceneNow } from "../../clock";
import { nztmToWorld, type TileIndex } from "../../terrain/manifest";
import { loadRoads, type Place, type Roads } from "../roads";
import { demand } from "../speeds";
import { useHolidays } from "../useHolidays";
import { useTraffic } from "../useTraffic";
import { createSigns } from "./build";
import { loadSigns, type SignsFile } from "./file";
import { type Ground, type PlacedFace, placeAll } from "./layout";
import { estimateLimit, speedAt } from "./limits";
import { overrideFromUrl, useSigns } from "./useSigns";

/** Signs are drawn this near the camera, m: beyond, a gantry's a pixel or two. */
const RANGE = 7000;

/** Lane signs are worked out again this often, ms: the hour moves on. */
const RETHINK = 60_000;

/** `?lanes=KMH` shows KMH on every lane sign. */
function laneOverride() {
  const kmh = Number(new URLSearchParams(location.search).get("lanes"));

  return Number.isFinite(kmh) && kmh > 0 ? kmh : null;
}

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
  const laneKmh = useMemo(laneOverride, []);
  const { speeds } = useTraffic();
  const { holidays } = useHolidays(new Date(sceneNow()));
  const [tick, setTick] = useState(0);

  const signs = useMemo(
    () => createSigns(placeAll(file, groundOf(roads, index))),
    [roads, file, index]
  );

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), RETHINK);

    return () => clearInterval(timer);
  }, []);

  // What each lane sign likely shows: NZTA doesn't say (limits.ts).
  const limits = useMemo(() => {
    const byName = new Map(roads.carriageways.map((c) => [c.name, c]));
    const now = new Date(sceneNow());

    // How busy the hour usually is, the busier way: rush is rush either way.
    const perLane =
      Math.max(
        demand(now, holidays, true, false),
        demand(now, holidays, false, false)
      ) * 3600;

    return new Map<PlacedFace, number | null>(
      signs.lanes.map((placed) => {
        const road = byName.get(placed.on);

        if (placed.face.kind !== "lane" || !road) return [placed, null];

        return [
          placed,
          laneKmh ??
            estimateLimit(
              placed.face.zone,
              speedAt(road, placed.s, speeds),
              perLane
            ),
        ];
      })
    );
    // `tick` moves the hour on.
  }, [signs, roads, speeds, holidays, laneKmh, tick]);

  // The painted faces, once: off the frame that set the signs up.
  useEffect(() => {
    const timer = setTimeout(() => signs.paint(), 0);

    return () => clearTimeout(timer);
  }, [signs]);

  useEffect(() => {
    signs.show(messages, override, limits);
  }, [signs, messages, override, limits]);

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
 * them, speed limits where they change), on gantries, arms and posts; and
 * the motorway's lane signs, showing the limit they likely show. `lights`
 * (0..1) is how far through lighting-up it is. `?vms=TEXT` puts TEXT on
 * every message sign, `?lanes=KMH` KMH on every lane sign.
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
