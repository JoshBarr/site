import { useEffect, useMemo } from "react";
import { InstancedBufferAttribute, Mesh } from "three/webgpu";
import { castsNearShadow } from "../landmarks/nearShadow";
import { useRenderer } from "../renderer";
import type { PlacedTower } from "./network";
import {
  BODY,
  createTowerGeometry,
  createTowerMaterial,
} from "./pylonGeometry";
import { SPECS, TowerKind } from "./towers";

/**
 * Transpower's towers, poles and gantries: one instanced mesh to a kind,
 * all sharing a material.
 */
export function Pylons({ towers }: { towers: PlacedTower[] }) {
  const renderer = useRenderer();
  const msaa = renderer.samples > 1;

  const meshes = useMemo(() => {
    const material = createTowerMaterial(msaa);
    const kinds = new Map<TowerKind, PlacedTower[]>();

    for (const tower of towers) {
      kinds.set(tower.kind, [...(kinds.get(tower.kind) ?? []), tower]);
    }

    return [...kinds].map(([kind, standing]) => {
      const spec = SPECS[kind];
      const place = new Float32Array(standing.length * 4);
      const tall = new Float32Array(standing.length);

      standing.forEach(({ position, yaw, height }, i) => {
        place.set([...position, yaw], i * 4);
        tall[i] = (height - spec.head) / BODY;
      });

      const geometry = createTowerGeometry(spec);
      geometry.setAttribute("place", new InstancedBufferAttribute(place, 4));
      geometry.setAttribute("tall", new InstancedBufferAttribute(tall, 1));

      const mesh = new Mesh(geometry, material);
      mesh.name = `${kind} towers`;
      mesh.count = standing.length;
      // Towers are placed in the shader; the geometry's bounds mean nothing.
      mesh.frustumCulled = false;
      castsNearShadow(mesh);

      return mesh;
    });
  }, [towers, msaa]);

  useEffect(
    () => () => {
      meshes.forEach((mesh) => mesh.geometry.dispose());
      meshes[0]?.material.dispose();
    },
    [meshes]
  );

  return (
    <>
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </>
  );
}
