import { useEffect, useMemo } from "react";
import { Mesh } from "three/webgpu";
import { castsNearShadow } from "../landmarks/nearShadow";
import { createCraneMaterial } from "./ContainerCranes";
import {
  createLuffingCraneGeometry,
  createTripodCraneGeometry,
  LUFFING_CRANE_SPEC,
  TRIPOD_CRANE_SPEC,
} from "./heritageCraneGeometry";

type Point = [number, number, number];

/** Compass bearing each crane's jib is parked pointing along, degrees. */
const LUFFING_JIB_BEARING = 158;
const TRIPOD_JIB_BEARING = 90;

/** Compass bearing the quay runs along, by the shed: the portal's square to it. */
const QUAY_BEARING = 175;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Turn about the vertical that points a crane's +x along a bearing. */
const facing = (bearing: number) => Math.PI / 2 - radians(bearing);

/** Queens Wharf's level-luffing and tripod cranes, standing where they are. */
export function HeritageCranes({
  luffing,
  tripod,
}: {
  luffing: Point;
  tripod: Point;
}) {
  const meshes = useMemo(() => {
    const luffingMesh = new Mesh(
      createLuffingCraneGeometry(
        LUFFING_CRANE_SPEC,
        radians(LUFFING_JIB_BEARING - QUAY_BEARING)
      ),
      createCraneMaterial(LUFFING_CRANE_SPEC.colour)
    );

    const tripodMesh = new Mesh(
      createTripodCraneGeometry(TRIPOD_CRANE_SPEC),
      createCraneMaterial(TRIPOD_CRANE_SPEC.colour)
    );

    for (const mesh of [luffingMesh, tripodMesh]) castsNearShadow(mesh);

    return { luffing: luffingMesh, tripod: tripodMesh };
  }, []);

  useEffect(
    () => () => {
      for (const mesh of [meshes.luffing, meshes.tripod]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
    [meshes]
  );

  return (
    <>
      <group
        name="luffing crane"
        position={luffing}
        rotation-y={facing(LUFFING_JIB_BEARING)}
      >
        <primitive object={meshes.luffing} />
      </group>
      <group
        name="tripod crane"
        position={tripod}
        rotation-y={facing(TRIPOD_JIB_BEARING)}
      >
        <primitive object={meshes.tripod} />
      </group>
    </>
  );
}
