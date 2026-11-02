import { useEffect, useMemo } from "react";
import { Mesh, MeshStandardNodeMaterial, Vector3 } from "three/webgpu";
import {
  attribute,
  cameraPosition,
  float,
  max,
  modelWorldMatrix,
  positionGeometry,
  vec4,
} from "three/tsl";
import { pixelAngle } from "../landmarks/common";
import { castsNearShadow } from "../landmarks/nearShadow";
import type { ObstructionLight } from "../landmarks/ObstructionLights";
import {
  craneLightPoints,
  CranePose,
  CraneSpec,
  createCraneGeometry,
} from "./craneGeometry";

/** Members are drawn at least this many pixels thick. */
const MIN_PIXELS = 1;

export interface PlacedCrane {
  /** World position of the crane's centre, between the rails. */
  position: [number, number, number];
  /** Turn about the vertical that points its boom (+x) seaward, radians. */
  rotation: number;
  pose: CranePose;
}

function createCraneMaterial(spec: CraneSpec) {
  const material = new MeshStandardNodeMaterial({
    color: spec.colour,
    roughness: 0.6,
    metalness: 0,
  });

  const spread = attribute("spread", "vec3");
  const thickness = attribute("thickness", "float");
  const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const pixel = cameraPosition.distance(world).mul(pixelAngle);
  const widen = max(float(1), pixel.mul(MIN_PIXELS).div(thickness));
  material.positionNode = positionGeometry.add(spread.mul(widen.sub(1)));
  // The shadow pass sees the crane from the sun: true size.
  material.castShadowPositionNode = positionGeometry;

  return material;
}

/** Ship-to-shore container cranes, each with its boom and trolley set. */
export function ContainerCranes({
  spec,
  cranes,
}: {
  spec: CraneSpec;
  cranes: PlacedCrane[];
}) {
  const meshes = useMemo(() => {
    const material = createCraneMaterial(spec);

    return cranes.map(({ pose }) => {
      const mesh = new Mesh(createCraneGeometry(spec, pose), material);
      castsNearShadow(mesh);

      return mesh;
    });
  }, [spec, cranes]);

  useEffect(
    () => () => {
      meshes.forEach((mesh) => mesh.geometry.dispose());
      meshes[0]?.material.dispose();
    },
    [meshes]
  );

  return (
    <>
      {meshes.map((mesh, i) => (
        <group
          key={mesh.uuid}
          name="container crane"
          position={cranes[i].position}
          rotation-y={cranes[i].rotation}
        >
          <primitive object={mesh} />
        </group>
      ))}
    </>
  );
}

const UP = new Vector3(0, 1, 0);

export function craneLights(
  spec: CraneSpec,
  { position, rotation, pose }: PlacedCrane
): ObstructionLight[] {
  const base = new Vector3(...position);

  return craneLightPoints(spec, pose).map((point) => ({
    position: point.applyAxisAngle(UP, rotation).add(base).toArray(),
    low: true,
  }));
}
