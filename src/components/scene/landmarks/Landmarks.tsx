import { useEffect, useMemo } from "react";
import { addFocusSubjects, FocusSubject } from "../lens";
import {
  ContainerCranes,
  craneLights,
  PlacedCrane,
} from "../port/ContainerCranes";
import { ContainerYard } from "../port/ContainerYard";
import {
  CENTREPORT_CRANE,
  CranePose,
  craneHeight,
  CraneSpec,
} from "../port/craneGeometry";
import { CRANES, WHARF_BEARING, YARD } from "../port/terminal";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { obstructionLights, usePixelAngle } from "./common";
import { LatticeTower, towerLights } from "./LatticeTower";
import { useNearShadow } from "./nearShadow";
import {
  KAUKAU_TOWER,
  LatticeTowerSpec,
  MT_VICTORIA_TOWER,
  towerHeight,
  widthAt,
} from "./latticeGeometry";
import { ObstructionLights } from "./ObstructionLights";
import {
  BROOKLYN,
  KAUKAU,
  MILL_CREEK,
  MT_VICTORIA,
  Site,
  WEST_WIND,
} from "./sites";
import { turbineLights } from "./turbineLights";
import { E_44, SWT_2_3_82, TurbineModel } from "./turbineModels";
import { Wind, WindTurbines } from "./WindTurbines";

type Point = [number, number, number];

/** What autofocus sees of a lattice tower: its taper. */
function towerSubject(spec: LatticeTowerSpec, base: Point): FocusSubject {
  return {
    kind: "post",
    base,
    height: towerHeight(spec),
    radius: (height) => widthAt(spec, height) / 2,
  };
}

/** What autofocus sees of a turbine: its tower, and the disc its rotor sweeps. */
function turbineSubjects(
  model: TurbineModel,
  [x, y, z]: Point
): FocusSubject[] {
  return [
    {
      kind: "post",
      base: [x, y, z],
      height: model.hubHeight,
      radius: (height) =>
        model.towerBaseRadius +
        (model.towerTopRadius - model.towerBaseRadius) *
          (height / model.hubHeight),
    },
    {
      kind: "ball",
      centre: [x, y + model.hubHeight, z],
      radius: model.rotorRadius,
    },
  ];
}

/** What autofocus sees of a container crane: a fat post as tall as it. */
function craneSubject(spec: CraneSpec, crane: PlacedCrane): FocusSubject {
  return {
    kind: "post",
    base: crane.position,
    height: craneHeight(spec, crane.pose),
    radius: () => spec.gauge / 2,
  };
}

/**
 * The cranes north to south: one working with its boom down, one stowed.
 * They're always posed so, whether or not a ship is in.
 */
const CRANE_POSES: CranePose[] = [
  { boom: 0, trolley: 32 },
  { boom: (80 * Math.PI) / 180, trolley: 0 },
];

/**
 * Wellington's wind turbines and transmitter towers, CentrePort's cranes
 * and container stacks, standing on the
 * terrain and casting shadows on it. `lights` (0..1) turns on their aviation
 * lights, for night.
 */
export function Landmarks({
  index,
  wind,
  lights = 0,
  shadowMapSize = 4096,
}: {
  index: TileIndex;
  wind: Wind;
  lights?: number;
  /** Resolution of the near shadow map they cast into. */
  shadowMapSize?: number;
}) {
  usePixelAngle();
  useNearShadow(shadowMapSize);

  useEffect(() => {
    obstructionLights.value = lights;
  }, [lights]);

  const placed = useMemo(() => {
    // Ground heights are from the DEM; the terrain is drawn exaggerated.
    const place = ([e, n, ground]: Site): Point => {
      const [x, z] = nztmToWorld(index.manifest, e, n);
      return [x, ground * verticalScale.value, z];
    };
    const westWind = WEST_WIND.map(place);
    const millCreek = MILL_CREEK.map(place);
    const brooklyn = [place(BROOKLYN)];
    const kaukau = place(KAUKAU);
    const mtVictoria = place(MT_VICTORIA);
    // Booms (+x in the crane's frame) out over the harbour, square to the wharf.
    const seaward = ((WHARF_BEARING - 90) * Math.PI) / 180;
    const cranes: PlacedCrane[] = CRANES.map((site, i) => ({
      position: place(site),
      rotation: Math.PI / 2 - seaward,
      pose: CRANE_POSES[i % CRANE_POSES.length],
    }));

    return {
      siemens: [...westWind, ...millCreek],
      brooklyn,
      kaukau,
      mtVictoria,
      cranes,
      lights: [
        ...turbineLights(SWT_2_3_82, westWind),
        ...turbineLights(SWT_2_3_82, millCreek),
        ...towerLights(KAUKAU_TOWER, kaukau),
        ...towerLights(MT_VICTORIA_TOWER, mtVictoria),
        ...cranes.flatMap((crane) => craneLights(CENTREPORT_CRANE, crane)),
      ],
      focus: [
        ...[...westWind, ...millCreek].flatMap((site) =>
          turbineSubjects(SWT_2_3_82, site)
        ),
        ...turbineSubjects(E_44, brooklyn[0]),
        towerSubject(KAUKAU_TOWER, kaukau),
        towerSubject(MT_VICTORIA_TOWER, mtVictoria),
        ...cranes.map((crane) => craneSubject(CENTREPORT_CRANE, crane)),
      ],
    };
  }, [index]);

  useEffect(() => addFocusSubjects(placed.focus), [placed]);

  return (
    <>
      <WindTurbines model={SWT_2_3_82} positions={placed.siemens} wind={wind} />
      <WindTurbines model={E_44} positions={placed.brooklyn} wind={wind} />
      <LatticeTower spec={KAUKAU_TOWER} position={placed.kaukau} />
      <LatticeTower spec={MT_VICTORIA_TOWER} position={placed.mtVictoria} />
      <ContainerCranes spec={CENTREPORT_CRANE} cranes={placed.cranes} />
      <ContainerYard index={index} yard={YARD} wharfBearing={WHARF_BEARING} />
      <ObstructionLights lights={placed.lights} />
    </>
  );
}
