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
 * all sharing a material. `carrying` is for when the grid's lit (see
 * energise.ts): how hard each one's line is working (`levels`, 0..1) and
 * whether it's the HVDC link's (`link`), in the towers' order. Without it,
 * they're any line's at its most.
 */
export function Pylons({
  towers,
  carrying,
}: {
  towers: PlacedTower[];
  carrying?: { levels: Float32Array; link: Uint8Array };
}) {
  const link = carrying?.link;
  const levels = carrying?.levels;

  const renderer = useRenderer();
  const msaa = renderer.samples > 1;

  const kinds = useMemo(() => {
    const material = createTowerMaterial(msaa);
    const standing = new Map<TowerKind, number[]>();

    towers.forEach(({ kind }, i) => {
      standing.set(kind, [...(standing.get(kind) ?? []), i]);
    });

    return [...standing].map(([kind, those]) => {
      const spec = SPECS[kind];
      const place = new Float32Array(those.length * 4);
      const stands = new Float32Array(those.length * 3);

      those.forEach((tower, i) => {
        const { position, yaw, height } = towers[tower];

        place.set([...position, yaw], i * 4);
        // Its level's filled in below, and again whenever it changes.
        stands.set([(height - spec.head) / BODY, 1, link?.[tower] ?? 0], i * 3);
      });

      const geometry = createTowerGeometry(spec);
      geometry.setAttribute("place", new InstancedBufferAttribute(place, 4));
      geometry.setAttribute("stands", new InstancedBufferAttribute(stands, 3));

      const mesh = new Mesh(geometry, material);
      mesh.name = `${kind} towers`;
      mesh.count = those.length;
      // Towers are placed in the shader; the geometry's bounds mean nothing.
      mesh.frustumCulled = false;
      castsNearShadow(mesh);

      return { mesh, towers: those };
    });
  }, [towers, link, msaa]);

  useEffect(() => {
    for (const { mesh, towers: those } of kinds) {
      const stands = mesh.geometry.getAttribute("stands");

      those.forEach((tower, i) => stands.setY(i, levels?.[tower] ?? 1));
      stands.needsUpdate = true;
    }
  }, [kinds, levels]);

  useEffect(
    () => () => {
      kinds.forEach(({ mesh }) => mesh.geometry.dispose());
      kinds[0]?.mesh.material.dispose();
    },
    [kinds]
  );

  return (
    <>
      {kinds.map(({ mesh }) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </>
  );
}
