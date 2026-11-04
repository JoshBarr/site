import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera } from "three/webgpu";
import { sceneNow } from "../clock";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { marks, rings, SLOTS, waves } from "./glow";
import { marker, ripple, shake } from "./ripple";
import { useQuakes } from "./useQuakes";

/** Past the epicentre's distance from the middle, a ripple's off the map, m. */
const OFF_MAP = 60_000;

/** Pixels the view's thrown about per MMI felt. */
const THROW = 2;

/** Seconds per jolt, roughly, in each direction. */
const JOLTS = [
  [0.071, 0.113, 0.191],
  [0.083, 0.127, 0.167],
];

/** A jumble of sines, -1..1: the view's throw at `t` seconds, along `axis`. */
const jolt = (t: number, axis: 0 | 1) =>
  JOLTS[axis].reduce((sum, period) => sum + Math.sin(t / period), 0) / 3;

/**
 * Earthquakes from GeoNet: a wave bending the scene as it spreads from
 * each epicentre as the shaking does, a circle where each struck fading
 * over the day after, and the view shaken when one would have been felt
 * where the camera is. Drawn by the terrain's and the water's materials
 * and the frame's pipeline (./glow.ts), from the slots filled here.
 */
export function Quakes({ index }: { index: TileIndex }) {
  const quakes = useQuakes();
  const camera = useThree((state) => state.camera);

  useEffect(
    () => () => {
      if (camera instanceof PerspectiveCamera) camera.clearViewOffset();

      waves.value = 0;

      for (let i = 0; i < SLOTS; i++) {
        rings[i].value.set(0, 0, 0, 0);
        marks[i].value.set(0, 0, 0, 0);
      }
    },
    [camera]
  );

  useFrame(({ clock, size }) => {
    const now = sceneNow();
    let felt = 0;

    const shown = [...quakes.current.values()].flatMap(({ quake, start }) => {
      const [x, z] = nztmToWorld(index.manifest, ...quake.position);
      const reach = Math.hypot(x, z) + OFF_MAP;
      const ring = ripple(quake, start, now, reach);
      const mark = marker(quake, now);
      // Where the camera is over the ground, km from the epicentre.
      const across = Math.hypot(camera.position.x - x, camera.position.z - z);

      felt = Math.max(felt, shake(quake, start, now, across / 1000));

      return ring || mark ? [{ x, z, ring, mark }] : [];
    });

    // Ripples first, then the brightest circles.
    shown.sort(
      (a, b) =>
        (b.ring?.strength ?? -1) - (a.ring?.strength ?? -1) ||
        (b.mark?.strength ?? 0) - (a.mark?.strength ?? 0)
    );

    waves.value = 0;

    for (let i = 0; i < SLOTS; i++) {
      const { x = 0, z = 0, ring = null, mark = null } = shown[i] ?? {};

      if (ring) waves.value++;

      rings[i].value.set(x, z, ring?.radius ?? 0, ring?.strength ?? 0);
      marks[i].value.set(
        mark?.radius ?? 0,
        mark?.strength ?? 0,
        ring?.width ?? 1,
        0
      );
    }

    if (!(camera instanceof PerspectiveCamera)) return;

    if (felt > 0) {
      const t = clock.elapsedTime;
      const { width, height } = size;

      camera.setViewOffset(
        width,
        height,
        jolt(t, 0) * felt * THROW,
        jolt(t, 1) * felt * THROW,
        width,
        height
      );
    } else if (camera.view?.enabled) {
      camera.clearViewOffset();
    }
  });

  return null;
}
