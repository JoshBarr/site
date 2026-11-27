import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Frustum,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Sphere,
  Vector3,
} from "three/webgpu";
import { sceneNow } from "../clock";
import { seaLevel } from "../environment";
import { pixelAngle } from "../landmarks/common";
import { castsNearShadow } from "../landmarks/nearShadow";
import { addOverClouds } from "../overClouds";
import { addFocusSubjects } from "../lens";
import type { Wind } from "../landmarks/WindTurbines";
import { nztmToWorld, type TileIndex } from "../terrain/manifest";
import { velocity } from "../wind/estimate";
import { flowAt, loadWindField, type WindField } from "../wind/field";
import {
  createPontoonGeometry,
  NOZZLE_HEIGHT,
  PONTOON_RADIUS,
} from "./pontoon";
import { forced, FOUNTAIN, ROTUNDA, scheduled, tooWindy } from "./schedule";
import { createSpray, DRIFTS, SETTLES, SPRAY_HEIGHT } from "./spray";

/** Drops of spray: fewer on phones. */
const DROPS = globalThis.matchMedia?.("(pointer: coarse)").matches
  ? 3000
  : 6000;

/** A step in the scene's clock longer than this is a jump, not a frame, s. */
const JUMP = 2;

/**
 * How tall the spray stands on screen, px, where it starts to fade, and
 * where it's gone and not drawn: far off, a 6000-drop spray and a pass of
 * its own for a white tick.
 */
const FADES_PIXELS = 4;
const GONE_PIXELS = 2;

/** Round the jet's middle, out past the ring and the widest mist, m. */
const REACH = SPRAY_HEIGHT / 2 + 8;

/** Far off: when a pump that's running stops. */
const NEVER = 1e9;

/**
 * The Carter Fountain in Oriental Bay, running to its hours unless the wind
 * at the Band Rotunda's sensor is up: its pontoon, riding the tide, and the
 * spray off it, blown about by the wind there and lit from below at night. `wind` is the wind out at sea; `lights` 0..1 how far into night.
 */
export function Fountain({
  index,
  wind,
  lights,
}: {
  index: TileIndex;
  wind: Wind;
  lights: number;
}) {
  const { manifest } = index;

  const { spray, pontoon, nozzle, sensor } = useMemo(() => {
    const [x, z] = nztmToWorld(manifest, ...FOUNTAIN);
    const nozzle = new Vector3(x, 0, z);

    const pontoon = new Mesh(
      createPontoonGeometry(),
      new MeshStandardNodeMaterial({
        vertexColors: true,
        roughness: 0.8,
        metalness: 0,
      })
    );

    pontoon.position.copy(nozzle);
    castsNearShadow(pontoon);

    return {
      spray: createSpray(nozzle, DROPS),
      pontoon,
      nozzle,
      sensor: nztmToWorld(manifest, ...ROTUNDA),
    };
  }, [manifest]);

  useEffect(
    () => () => {
      for (const mesh of [spray.mesh, pontoon]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
    [spray, pontoon]
  );

  const [land, setLand] = useState<WindField | null>(null);

  useEffect(() => {
    let current = true;

    loadWindField().then(
      (loaded) => current && setLand(loaded),
      (e) => console.error("[fountain] wind field:", e)
    );

    return () => {
      current = false;
    };
  }, []);

  // The wind at the sensor, which decides, and out at the fountain, which
  // blows the spray. Until the land's in, the wind at sea for both.
  const blowing = useMemo(() => {
    const open = velocity(wind);
    const [wx, wz] = open;

    if (!land) return { sensor: wind.speed, spray: open };

    const [sx, sz] = flowAt(land, manifest.rootSize, ...sensor, wx, wz);

    return {
      sensor: Math.hypot(sx, sz),
      spray: flowAt(land, manifest.rootSize, nozzle.x, nozzle.z, wx, wz),
    };
  }, [wind, land, manifest, sensor, nozzle]);

  useEffect(() => {
    spray.uniforms.wind.value.set(...blowing.spray);
  }, [spray, blowing]);

  // The spray's drawn over the clouds, in a pass of its own.
  useEffect(() => addOverClouds(spray.mesh), [spray]);

  useEffect(() => {
    spray.uniforms.lights.value = lights;
  }, [spray, lights]);

  const [running, setRunning] = useState(false);
  const held = useMemo(forced, []);

  const state = useRef({
    origin: sceneNow(),
    last: NaN,
    on: false,
    // Its hours, read once a second, not every frame.
    second: NaN,
    hours: false,
  });

  const view = useMemo(
    () => ({
      frustum: new Frustum(),
      matrix: new Matrix4(),
      bound: new Sphere(),
    }),
    []
  );

  useFrame(({ camera }) => {
    const { uniforms } = spray;
    const now = sceneNow();
    const s = state.current;
    const clock = (now - s.origin) / 1000;
    // Afloat, it rides the tide.
    pontoon.position.y = seaLevel.value;
    const jumped = !(Math.abs(clock - s.last) < JUMP);
    const second = Math.floor(now / 1000);

    if (second !== s.second) {
      s.second = second;
      s.hours = scheduled(now);
    }

    const on = held ?? (s.hours && !tooWindy(blowing.sensor));
    s.last = clock;
    uniforms.clock.value = clock;

    if (on !== s.on || jumped) {
      if (jumped) {
        // Come to it in the middle of a run: it's been going a while; or not.
        uniforms.started.value = on ? clock - 60 : -NEVER;
        uniforms.stopped.value = on ? NEVER : -NEVER;
      } else if (on) {
        uniforms.started.value = clock;
        uniforms.stopped.value = NEVER;
      } else {
        uniforms.stopped.value = clock;
      }

      if (on !== s.on) setRunning(on);

      s.on = on;
    }

    // Drawn only while there's water in the air, it's in view, and it's big
    // enough to see; else the drops aren't drawn, nor the pass they're in.
    const inAir = clock - uniforms.stopped.value < SETTLES;
    const distance = camera.position.distanceTo(nozzle);
    const pixels = SPRAY_HEIGHT / Math.max(distance * pixelAngle.value, 1e-9);
    uniforms.fade.value = MathUtils.smoothstep(
      pixels,
      GONE_PIXELS,
      FADES_PIXELS
    );
    let shown = inAir && pixels > GONE_PIXELS;

    if (shown) {
      // The mist goes downwind: the bound's pulled that way, and grown.
      const [wx, wz] = blowing.spray;
      const drift = DRIFTS / 2;
      view.bound.center.set(
        nozzle.x + wx * drift,
        seaLevel.value + SPRAY_HEIGHT / 2,
        nozzle.z + wz * drift
      );
      view.bound.radius = REACH + Math.hypot(wx, wz) * drift;
      view.matrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse
      );
      view.frustum.setFromProjectionMatrix(
        view.matrix,
        camera.coordinateSystem
      );
      shown = view.frustum.intersectsSphere(view.bound);
    }

    spray.mesh.visible = shown;
  });

  // Autofocus can land on the pontoon, and the jet while it's running.
  useEffect(
    () =>
      addFocusSubjects([
        {
          kind: "post",
          base: [nozzle.x, 0, nozzle.z],
          height: running ? SPRAY_HEIGHT : NOZZLE_HEIGHT,
          radius: (height) => (height < NOZZLE_HEIGHT ? PONTOON_RADIUS : 2),
        },
      ]),
    [running, nozzle]
  );

  return <primitive object={pontoon} name="fountain" />;
}
