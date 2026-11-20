import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { usePixelAngle } from "../landmarks/common";
import { addFocusSubjects, FocusSubject } from "../lens";
import { switchedOff } from "../stats";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { Cables } from "./Cables";
import {
  gridLit,
  link,
  placeLink,
  setLink,
  standTowers,
  stepGrid,
  toggleGrid,
} from "./energise";
import { feeding, HAYWARDS, levelsOf, SUBSTATIONS } from "./feed";
import { useGridFlow } from "./flow";
import { SPANS, STRUCTURES } from "./grid";
import { layOut } from "./network";
import { Pylons } from "./Pylons";
import { Wires } from "./Wires";

/** What autofocus takes a tower for: a post about this wide, m. */
const FOCUS_RADIUS = 3;

/** Each structure's substations, by how far along the lines they are. */
const FED = feeding(STRUCTURES, SPANS, SUBSTATIONS);

/** ?grid=lit starts with the grid lit, from Haywards. */
const startsLit = () =>
  new URLSearchParams(location.search).get("grid") === "lit";

/**
 * The national grid around Wellington: Transpower's towers and poles
 * standing on the terrain, the lines strung between them, and the HVDC
 * link's cables coming ashore from Cook Strait. Lit (click a tower), it
 * shows what it's carrying (./flow.ts).
 */
export function Power({ index }: { index: TileIndex }) {
  // The landmarks keep this too, but either layer may be off.
  usePixelAngle();

  const network = useMemo(
    () =>
      layOut(
        STRUCTURES,
        SPANS,
        // Ground heights are from the DEM; the terrain is drawn exaggerated.
        (easting, northing, ground) => {
          const [x, z] = nztmToWorld(index.manifest, easting, northing);

          return [x, ground * verticalScale.value, z];
        },
        verticalScale.value
      ),
    [index]
  );

  useEffect(
    () =>
      addFocusSubjects(
        network.towers.map(({ position, height }): FocusSubject => ({
          kind: "post",
          base: position,
          height,
          radius: () => FOCUS_RADIUS,
        }))
      ),
    [network]
  );

  // Clicked, a tower lights the grid.
  useEffect(() => standTowers(network.towers), [network]);
  useFrame((_, delta) => stepGrid(delta));

  const carried = useGridFlow();

  // How hard each tower's line is working, and each wire's at either end.
  const carrying = useMemo(() => {
    const levels = levelsOf(FED, carried.levels);
    const ends = [...network.strung].map((span) => SPANS[span]);

    return {
      towers: { levels, link: FED.link },
      wires: {
        levels: Float32Array.from(
          ends.flatMap(([a, b]) => [levels[a], levels[b]])
        ),
        link: Uint8Array.from(ends, ([a, b]) => FED.link[a] & FED.link[b]),
      },
    };
  }, [network, carried]);

  useEffect(() => setLink(carried.link), [carried]);

  // ?off=gridnight: the link's pulses don't show unlit.
  useEffect(() => {
    if (switchedOff("gridnight")) link.night.value = 0;
  }, []);

  useEffect(() => {
    const [x, z] = nztmToWorld(index.manifest, ...HAYWARDS);

    placeLink(x, 0, z);

    if (!startsLit() || gridLit()) return;

    // From the tower nearest: the light runs out along the lines from it.
    toggleGrid(
      network.towers.reduce((best, tower) =>
        Math.hypot(tower.position[0] - x, tower.position[2] - z) <
        Math.hypot(best.position[0] - x, best.position[2] - z)
          ? tower
          : best
      )
    );
  }, [index, network]);

  return (
    <>
      <Pylons towers={network.towers} carrying={carrying.towers} />
      <Wires wires={network.wires} carrying={carrying.wires} />
      <Cables index={index} />
    </>
  );
}
