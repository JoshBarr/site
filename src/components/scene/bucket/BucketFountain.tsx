import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  DoubleSide,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Sphere,
  Vector3,
} from "three/webgpu";
import {
  attribute,
  normalGeometry,
  positionGeometry,
  transformNormalToView,
  uniform,
  uniformArray,
} from "three/tsl";
import { POOL_LAYER, REFLECTION_LAYER } from "../environment";
import { pixelAngle, rotateX, rotateY } from "../landmarks/common";
import { addRestlessCasters, castsNearShadow } from "../landmarks/nearShadow";
import type { Wind } from "../landmarks/WindTurbines";
import { addFocusSubjects } from "../lens";
import { createModelMaterial } from "../models/lod";
import { keepShrubsOff } from "../trees/Shrubs";
import { nztmToWorld, type TileIndex } from "../terrain/manifest";
import { switchedOff } from "../stats";
import { verticalScale } from "../terrain/Terrain";
import { velocity } from "../wind/estimate";
import { BUCKETS, FEEDS } from "./layout";
import {
  createBucketsGeometry,
  createFrameGeometry,
  createSimpleGeometry,
  HEIGHT,
} from "./model";
import { REST } from "./shape";
import { createPoolGeometry, createPoolMaterial } from "./pool";
import { GROUND, POOL, SITE, YAW } from "./site";
import { createSpray } from "./spray";
import { createTipping } from "./tipping";

/** It's been running this long when the scene comes to it, s. */
const WARM_UP = 90;

/**
 * It's drawn in full, its buckets swinging, its water falling and its pool
 * mirroring them, once it stands this many pixels tall on screen, as the
 * vehicles' close-up models are (../models/lod.ts)...
 */
const DETAIL_PIXELS = 64;

/** ...as a still, cheap stand-in down to this, and not at all under it. */
const SHOWN_PIXELS = 3;

/** Going back down takes this much less, so it doesn't flicker at an edge. */
const HYSTERESIS = 0.85;

/** What can move, in the fountain's frame: buckets, and water in a wind. */
const BUCKETS_BOUND = new Sphere(new Vector3(0, 3.4, 0), 3);
const SPRAY_BOUND = new Sphere(new Vector3(0, 3, 0), 9);

/** And the whole of it, for whether it's in view at all. */
const BOUND_RADIUS = 9;

type Detail = "none" | "simple" | "full";

/**
 * Cuba Mall's a street between buildings three and four storeys high: the
 * wind down it's this share of the wind over the city. A guess.
 */
const SHELTER = 0.5;

/** Shrubs are kept this far from the pool's middle, m: past its ends. */
const POOL_REACH = 5;

/** Its mirror's resolution, of the screen's: fewer pixels on phones. */
const MIRROR_SCALE = globalThis.matchMedia?.("(pointer: coarse)").matches
  ? 0.25
  : 0.4;

/** The buckets' fibreglass. */
function createBucketsMaterial(count: number) {
  const tips = uniformArray<"float">(
    Array.from({ length: count }, () => 0),
    "float"
  );

  const lit = uniform(0);

  const material = new MeshStandardNodeMaterial({
    roughness: 0.35,
    metalness: 0,
    // Open scoops: their insides show.
    side: DoubleSide,
  });

  const hang = attribute<"vec4">("hang", "vec4");
  const lean = tips.element(attribute<"float">("bucket", "float").toInt());
  const turn = lean.sub(REST);

  material.positionNode = rotateY(rotateX(positionGeometry, turn), hang.w).add(
    hang.xyz
  );

  material.normalNode = transformNormalToView(
    rotateY(rotateX(normalGeometry, turn), hang.w)
  );

  material.colorNode = attribute<"vec3">("color", "vec3");
  material.emissiveNode = attribute<"vec3">("glow", "vec3").mul(lit);

  return { material, tips, lit };
}

/**
 * The Bucket Fountain in Cuba Mall (Burren and Keen, 1969): a steel cage on
 * a post in its pool, a ball on top, and its buckets filling from the feed
 * and tipping, each into the next, or not quite, and down into the pool;
 * splashing the paving, more so in a wind. `wind` is the wind over the
 * city; `lights` 0..1 how far into night, its pool's lights coming on.
 */
export function BucketFountain({
  index,
  wind,
  lights,
}: {
  index: TileIndex;
  wind: Wind;
  lights: number;
}) {
  const { manifest } = index;
  const camera = useThree((state) => state.camera);

  const built = useMemo(() => {
    const scale = verticalScale.value;
    const [x, z] = nztmToWorld(manifest, ...SITE);
    const base = new Vector3(x, GROUND * scale, z);

    const group = new Group();
    group.position.copy(base);
    group.rotation.y = YAW;
    group.updateMatrixWorld(true);

    const frameLook = createModelMaterial({ roughness: 0.5 });
    // The stand-in's buckets are single sheets.
    frameLook.material.side = DoubleSide;
    const frame = new Mesh(createFrameGeometry(), frameLook.material);
    castsNearShadow(frame);

    const simple = new Mesh(createSimpleGeometry(), frameLook.material);
    castsNearShadow(simple);

    const buckets = createBucketsMaterial(BUCKETS.length);
    const bucketMesh = new Mesh(createBucketsGeometry(), buckets.material);
    // They swing in the shader: bounds for wherever they swing to.
    bucketMesh.geometry.boundingSphere = BUCKETS_BOUND.clone();
    castsNearShadow(bucketMesh);

    const spray = createSpray();
    spray.mesh.geometry.boundingSphere = SPRAY_BOUND.clone();
    spray.mesh.frustumCulled = true;

    // In the pool's mirror, and only in its.
    for (const mesh of [frame, bucketMesh, spray.mesh]) {
      mesh.layers.enable(POOL_LAYER);
    }

    // The pool: mirrored up close, and only the sky's in it from afar.
    const poolGeometry = createPoolGeometry();
    const mirrors = !switchedOff("reflection") && !switchedOff("poolmirror");

    const looks = [true, false].map((mirrored) =>
      createPoolMaterial({ mirrored, resolutionScale: MIRROR_SCALE })
    );

    const pools = looks.map(({ material }) => {
      const mesh = new Mesh(poolGeometry, material);
      // Which way the outline's triangles face isn't known: either.
      material.side = DoubleSide;
      // After the terrain, as water is.
      mesh.renderOrder = 1;
      mesh.visible = false;

      return mesh;
    });

    const [mirror] = looks;

    if (mirror.mirror) group.add(mirror.mirror.target);

    group.add(frame, simple, bucketMesh, spray.mesh, ...pools);

    // Nothing's shown till the first frame's worked out how much.
    for (const object of [frame, simple, bucketMesh, spray.mesh]) {
      object.visible = false;
    }

    const tipping = createTipping(BUCKETS, FEEDS);
    tipping.step(0);

    for (let t = 0; t < WARM_UP; t += 0.1) tipping.step(0.1);

    return {
      base,
      group,
      pools,
      poolGeometry,
      looks,
      mirrors,
      frame,
      frameLook,
      simple,
      bucketMesh,
      buckets,
      spray,
      tipping,
    };
  }, [manifest]);

  useEffect(
    () => () => {
      const { frame, frameLook, simple, bucketMesh, buckets, spray } = built;
      frame.geometry.dispose();
      simple.geometry.dispose();
      frameLook.material.dispose();
      bucketMesh.geometry.dispose();
      buckets.material.dispose();
      spray.dispose();
      built.poolGeometry.dispose();
      built.looks.forEach(({ material }) => material.dispose());
    },
    [built]
  );

  useEffect(() => {
    built.frameLook.lit.value = lights;
    built.buckets.lit.value = lights;
    built.spray.lights.value = lights;
    built.looks.forEach((look) => (look.lights.value = lights));
  }, [built, lights]);

  // The mirror sees what the sea's does (the land's stand-in, the
  // buildings, their lights), and the fountain.
  useEffect(() => {
    const layers =
      built.looks[0].mirror?.reflector.getVirtualCamera(camera).layers;

    layers?.set(REFLECTION_LAYER);
    layers?.enable(POOL_LAYER);
  }, [built, camera]);

  // Down the mall, sheltered, in the fountain's own frame.
  const blowing = useMemo((): [number, number] => {
    const [wx, wz] = velocity(wind);
    const c = Math.cos(-YAW);
    const s = Math.sin(-YAW);

    return [(wx * c + wz * s) * SHELTER, (-wx * s + wz * c) * SHELTER];
  }, [wind]);

  // While its buckets swing, the near shadow map keeps up with them.
  const restless = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      restless.current?.();
      restless.current = null;
    },
    [built]
  );

  // The scrub cover has a shrub or two in the pool: its planters, maybe.
  useEffect(() => {
    const east = POOL.reduce((sum, [e]) => sum + e, 0) / POOL.length;
    const north = POOL.reduce((sum, [, n]) => sum + n, 0) / POOL.length;
    const [x, z] = nztmToWorld(manifest, SITE[0] + east, SITE[1] + north);

    return keepShrubsOff(x, z, POOL_REACH);
  }, [manifest]);

  useEffect(() => {
    const { x, y, z } = built.base;

    return addFocusSubjects([
      { kind: "post", base: [x, y, z], height: HEIGHT, radius: () => 1.1 },
    ]);
  }, [built]);

  const eye = useRef(new Vector3());
  const shown = useRef<Detail>("none");

  const view = useMemo(
    () => ({
      frustum: new Frustum(),
      matrix: new Matrix4(),
      bound: new Sphere(),
    }),
    []
  );

  useFrame(({ camera }, delta) => {
    const { base, group, tipping, spray, buckets, pools, looks } = built;
    const distance = camera.position.distanceTo(base);
    const pixels = HEIGHT / Math.max(distance * pixelAngle.value, 1e-9);
    const keep = shown.current;

    // How much of it to draw, by how tall it stands on screen.
    const detail: Detail =
      pixels > DETAIL_PIXELS * (keep === "full" ? HYSTERESIS : 1)
        ? "full"
        : pixels > SHOWN_PIXELS * (keep === "none" ? 1 : HYSTERESIS)
          ? "simple"
          : "none";

    const full = detail === "full";
    const mirrored = full && built.mirrors;

    built.frame.visible = full;
    built.bucketMesh.visible = full;
    built.simple.visible = detail === "simple";
    pools[0].visible = mirrored;
    pools[1].visible = detail !== "none" && !mirrored;

    if (full !== (keep === "full")) {
      restless.current?.();
      restless.current = full
        ? addRestlessCasters([[base.x, base.y, base.z]])
        : null;
    }

    shown.current = detail;

    // Off screen, or too small to see move: nothing moves.
    view.matrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    view.frustum.setFromProjectionMatrix(view.matrix, camera.coordinateSystem);
    view.bound.set(base, BOUND_RADIUS);
    view.bound.center.y += HEIGHT / 2;

    if (!full || !view.frustum.intersectsSphere(view.bound)) {
      spray.clear();
      spray.mesh.visible = false;

      return;
    }

    looks.forEach(({ clock }) => (clock.value += Math.min(delta, 0.1)));
    tipping.step(delta);

    for (let i = 0; i < BUCKETS.length; i++) {
      buckets.tips.array[i] = tipping.tip[i];
    }

    spray.mesh.visible = true;
    spray.eye.value.copy(group.worldToLocal(eye.current.copy(camera.position)));
    spray.update(Math.min(delta, 0.05), tipping, blowing);
  });

  return (
    <>
      <primitive object={built.group} name="bucket-fountain" />
    </>
  );
}
