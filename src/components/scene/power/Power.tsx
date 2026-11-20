import { useEffect, useMemo } from "react";
import { usePixelAngle } from "../landmarks/common";
import { addFocusSubjects, FocusSubject } from "../lens";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { Cables } from "./Cables";
import { SPANS, STRUCTURES } from "./grid";
import { layOut } from "./network";
import { Pylons } from "./Pylons";
import { Wires } from "./Wires";

/** What autofocus takes a tower for: a post about this wide, m. */
const FOCUS_RADIUS = 3;

/**
 * The national grid around Wellington: Transpower's towers and poles
 * standing on the terrain, the lines strung between them, and the HVDC
 * link's cables coming ashore from Cook Strait.
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

  return (
    <>
      <Pylons towers={network.towers} />
      <Wires wires={network.wires} />
      <Cables index={index} />
    </>
  );
}
