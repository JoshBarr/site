import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Matrix4, Object3D, Vector3 } from "three/webgpu";
import {
  NEAR_SHADOW_LAYER,
  nearShadowLight,
  sunDirection,
} from "../environment";

/** The near map spans this many times the camera's distance to its target. */
const SPAN = 2.5;
const MIN_EXTENT = 1200;
const MAX_EXTENT = 16000;
/** Extents snap to steps of this ratio, so the map doesn't swim on zoom. */
const EXTENT_STEP = 2 ** 0.25;

/** Puts an object's meshes into the near shadow map, casting and receiving. */
export function castsNearShadow(object: Object3D) {
  object.traverse((child) => {
    child.layers.enable(NEAR_SHADOW_LAYER);
    child.castShadow = true;
    child.receiveShadow = true;
  });
}

const target = new Vector3();
const centre = new Vector3();
const basis = new Matrix4();
const inverse = new Matrix4();
const ORIGIN = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * Fits the near shadow map around what the camera is looking at, sized to
 * how far away that is (closer, finer), aimed along the sun, and re-renders
 * it every frame: its casters move (rotors spin, nacelles yaw), and there
 * are few of them.
 */
export function useNearShadow(mapSize: number) {
  const controls = useThree((state) => state.controls) as {
    getTarget?: (out: Vector3) => Vector3;
  } | null;

  // The shadow node sizes its target from this on each render.
  useEffect(() => {
    nearShadowLight.shadow.mapSize.setScalar(mapSize);
  }, [mapSize]);

  useFrame(({ camera }) => {
    if (controls?.getTarget) {
      controls.getTarget(target);
    } else {
      camera.getWorldDirection(target).multiplyScalar(1000);
      target.add(camera.position);
    }

    const distance = camera.position.distanceTo(target);
    const wanted = Math.min(Math.max(distance * SPAN, MIN_EXTENT), MAX_EXTENT);
    const extent =
      EXTENT_STEP ** Math.ceil(Math.log(wanted) / Math.log(EXTENT_STEP));
    const texel = extent / mapSize;

    // Snap the centre to whole texels across the light's view, so the
    // shadows of still things hold still as the view moves.
    const toward = sunDirection.value;
    basis.lookAt(toward, ORIGIN, UP);
    inverse.copy(basis).invert();
    centre.copy(target).applyMatrix4(inverse);
    centre.x = Math.round(centre.x / texel) * texel;
    centre.y = Math.round(centre.y / texel) * texel;
    centre.applyMatrix4(basis);

    // Far enough back to take in everything the square spans, hills and all.
    const reach = extent + 2000;
    const light = nearShadowLight;
    light.position.copy(toward).multiplyScalar(reach).add(centre);
    light.target.position.copy(centre);
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();

    const shadow = light.shadow;
    const half = extent / 2;
    Object.assign(shadow.camera, {
      left: -half,
      right: half,
      top: half,
      bottom: -half,
      near: 1,
      far: reach * 2,
    });
    shadow.camera.updateProjectionMatrix();
    // About 30 cm of depth bias, and a texel and a half along the normal.
    shadow.bias = -0.3 / (reach * 2);
    shadow.normalBias = texel * 1.5;
    shadow.needsUpdate = true;
  });
}
