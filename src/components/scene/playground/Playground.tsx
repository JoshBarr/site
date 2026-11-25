import { useEffect, useMemo } from "react";
import { DoubleSide, Mesh, MeshStandardNodeMaterial } from "three/webgpu";
import { attribute, luminance, vec3 } from "three/tsl";
import { addFocusSubjects } from "../lens";
import { castsNearShadow } from "../landmarks/nearShadow";
import { nztmToWorld, type TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { createEquipmentGeometry, LIGHTHOUSE_HEIGHT } from "./equipment";
import { EQUIPMENT, groundAt } from "./layout";
import { ANCHOR } from "./site";
import { createSurfaceGeometry, createSurfaceMaterial } from "./surface";

/** The equipment's material: each part's colour as its grey, like the scene. */
function createEquipmentMaterial() {
  const material = new MeshStandardNodeMaterial({
    roughness: 0.75,
    metalness: 0,
    // Sail, hull and gallery rail are single sheets, seen from both sides.
    side: DoubleSide,
  });

  material.colorNode = vec3(luminance(attribute<"vec3">("tint", "vec3")));

  return material;
}

/**
 * Te Aro Mahana, the playground in Frank Kitts Park: its painted ground,
 * lighthouse and slides, swings, carousel and sail, fishnet climber and waka.
 */
export function Playground({ index }: { index: TileIndex }) {
  const { meshes, dispose } = useMemo(() => {
    const scale = verticalScale.value;
    const [x, z] = nztmToWorld(index.manifest, ...ANCHOR);

    const surface = createSurfaceMaterial();
    const ground = new Mesh(createSurfaceGeometry(scale), surface.material);
    castsNearShadow(ground);
    // A sheet on the ground: it takes shadows but has none worth casting.
    ground.castShadow = false;

    const equipment = new Mesh(
      createEquipmentGeometry(scale),
      createEquipmentMaterial()
    );

    castsNearShadow(equipment);

    const meshes = [ground, equipment];
    meshes.forEach((mesh) => mesh.position.set(x, 0, z));

    return {
      meshes,
      dispose: () => {
        meshes.forEach((mesh) => {
          mesh.geometry.dispose();
          mesh.material.dispose();
        });
        surface.map.dispose();
      },
    };
  }, [index]);

  useEffect(() => dispose, [dispose]);

  // Autofocus sees the lighthouse, the tallest thing in it.
  useEffect(() => {
    const [e, n] = EQUIPMENT.lighthouse;
    const [x, z] = nztmToWorld(index.manifest, ANCHOR[0] + e, ANCHOR[1] + n);

    return addFocusSubjects([
      {
        kind: "post",
        base: [x, groundAt(e, n) * verticalScale.value, z],
        height: LIGHTHOUSE_HEIGHT,
        radius: () => 1.5,
      },
    ]);
  }, [index]);

  return (
    <>
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} name="playground" />
      ))}
    </>
  );
}
