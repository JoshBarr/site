import { useEffect, useRef } from "react";
import { type RootState, useFrame, useThree } from "@react-three/fiber";
import { Matrix4, Object3D, Vector3 } from "three/webgpu";
import {
  NEAR_SHADOW_LAYER,
  nearShadowLight,
  sunDirection,
} from "../environment";
import { switchedOff } from "../stats";

/** The near map spans this many times the camera's distance to its target. */
const SPAN = 2.5;
const MIN_EXTENT = 1200;
const MAX_EXTENT = 16000;

/** Extents snap to steps of this ratio, so the map doesn't swim on zoom. */
const EXTENT_STEP = 2 ** 0.25;

/**
 * With the fit unchanged, re-render this often, s, for buses, trains, tree
 * sway and tiles streaming in. A tenth of a second's lag doesn't show.
 */
const REFRESH = 0.1;

/** How far a restless caster's parts reach from its base point, m. */
const RESTLESS_REACH = 200;

/** Casters that move every frame (turbine rotors), as world base points. */
const restless = new Set<readonly [number, number, number][]>();

/** Keeps the near map re-rendering every frame while any of these are in it. */
export function addRestlessCasters(
  points: readonly [number, number, number][]
) {
  restless.add(points);

  return () => {
    restless.delete(points);
  };
}

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
const point = new Vector3();
const lastCentre = new Vector3();
const lastSun = new Vector3();
const ORIGIN = new Vector3();
const UP = new Vector3(0, 1, 0);

/**
 * Whether a restless caster is in the square `half` either side of the
 * light-space centre. Projected along the sun, a caster's shadow falls where
 * it is in the light's view.
 */
function restlessIn(half: number) {
  for (const points of restless) {
    for (const [x, y, z] of points) {
      point.set(x, y, z).applyMatrix4(inverse);

      if (
        Math.abs(point.x - centre.x) < half + RESTLESS_REACH &&
        Math.abs(point.y - centre.y) < half + RESTLESS_REACH
      ) {
        return true;
      }
    }
  }

  return false;
}

/** Whether the default controls orbit a target, as CameraControls do. */
function orbits(controls: RootState["controls"]): controls is NonNullable<
  RootState["controls"]
> & {
  getTarget(out: Vector3): Vector3;
} {
  return (
    !!controls &&
    "getTarget" in controls &&
    controls.getTarget instanceof Function
  );
}

/**
 * Fits the near shadow map around what the camera is looking at, sized to
 * how far away that is (closer, finer), and aimed along the sun. It's
 * re-rendered when the fit changes, every frame while a turbine is in it,
 * and otherwise every REFRESH seconds.
 */
export function useNearShadow(mapSize: number) {
  const controls = useThree((state) => state.controls);
  const fit = useRef({ extent: 0, sinceRender: Infinity });

  // The shadow node sizes its target from this on each render.
  useEffect(() => {
    nearShadowLight.shadow.mapSize.setScalar(mapSize);
    fit.current.extent = 0;
  }, [mapSize]);

  useFrame(({ camera }, delta) => {
    if (switchedOff("nearshadow")) return;

    if (orbits(controls)) {
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

    const half = extent / 2;
    const last = fit.current;
    last.sinceRender += delta;

    const refit =
      extent !== last.extent ||
      !centre.equals(lastCentre) ||
      !toward.equals(lastSun);

    if (!refit && last.sinceRender < REFRESH && !restlessIn(half)) return;

    last.extent = extent;
    last.sinceRender = 0;
    lastCentre.copy(centre);
    lastSun.copy(toward);
    centre.applyMatrix4(basis);

    // Far enough back to take in everything the square spans, hills and all.
    const reach = extent + 2000;
    const light = nearShadowLight;
    light.position.copy(toward).multiplyScalar(reach).add(centre);
    light.target.position.copy(centre);
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();

    const shadow = light.shadow;
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
