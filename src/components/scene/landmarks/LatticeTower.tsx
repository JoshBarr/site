import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import type { WebGPURenderer } from "three/webgpu";
import { createLatticeTower, LatticeTowerSpec } from "./latticeGeometry";
import { castsNearShadow } from "./nearShadow";
import type { ObstructionLight } from "./ObstructionLights";

export function LatticeTower({
  spec,
  position,
  rotation = 0,
}: {
  spec: LatticeTowerSpec;
  /** World position of the base. */
  position: [number, number, number];
  /** Turn about the vertical, radians. */
  rotation?: number;
}) {
  const renderer = useThree((state) => state.gl) as unknown as WebGPURenderer;
  const msaa = renderer.samples > 1;
  const tower = useMemo(() => {
    const tower = createLatticeTower(spec, msaa);
    tower.meshes.forEach(castsNearShadow);
    return tower;
  }, [spec, msaa]);
  useEffect(() => () => tower.dispose(), [tower]);

  return (
    <group position={position} rotation-y={rotation}>
      {tower.meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </group>
  );
}

export function towerLights(
  spec: LatticeTowerSpec,
  [x, y, z]: [number, number, number]
): ObstructionLight[] {
  return spec.lights.map((height) => ({ position: [x, y + height, z] }));
}
