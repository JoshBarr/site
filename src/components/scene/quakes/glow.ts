import { Camera, Vector4 } from "three/webgpu";
import {
  abs,
  exp,
  float,
  Fn,
  fwidth,
  getViewPosition,
  If,
  max,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { sunIntensity } from "../environment";

// Earthquakes in the scene: a circle painted onto the ground and the sea
// where each struck, for a day after, and a wave bending the frame where
// the shaking's front is, rolling outward from the epicentre with nothing
// drawn. Quakes.tsx fills the slots each frame; the terrain's and the
// water's materials add quakeGlow to what they show, and the frame's
// pipeline (../clouds/Clouds.tsx) reads the scene through quakeWarp.

/** As many as are shown at once: the newest few, most often none. */
export const SLOTS = 6;

/** Each slot: epicentre x and z (world), the wave's radius and strength. */
export const rings = Array.from({ length: SLOTS }, () =>
  uniform(new Vector4())
);

/** Each slot: the marker's radius and strength, and the wave's width. */
export const marks = Array.from({ length: SLOTS }, () =>
  uniform(new Vector4())
);

/** How many slots have a wave in them: none, and the frame isn't bent. */
export const waves = uniform(0);

/** Amber, like GeoNet's newest quakes. */
const COLOUR = vec3(1, 0.5, 0.18);

/**
 * How far the ground's thrown at a wave's crest, as a fraction of its
 * distance from the camera: the same few pixels near or far.
 */
const THROW = 0.012;

/** Crests in a wave's width. */
const CRESTS = 1.6;

/**
 * Light from the markers at world x/z `world`. Bright enough to read by
 * day, held back at night, when the ground's dark.
 */
export function quakeGlow(world) {
  return Fn(() => {
    const glow = float(0).toVar();

    for (let i = 0; i < SLOTS; i++) {
      const mark = marks[i];

      // Skipped where the slot's empty, as it most often is: otherwise every
      // pixel of the land and the sea pays for six circles (about 1.6 ms at
      // 2160x1350 on an M1). The branch is on a uniform, so fwidth may sit
      // inside it.
      If(mark.y.greaterThan(0), () => {
        const d = world.sub(rings[i].xy).length();
        // Never thinner than a pixel or two, so far circles don't shimmer.
        const pixel = fwidth(d);
        const line = max(mark.x.mul(0.03), pixel.mul(1.5));
        const outline = float(1).sub(smoothstep(0, line, abs(d.sub(mark.x))));

        const fill = float(1)
          .sub(smoothstep(mark.x.mul(0.9), mark.x, d))
          .mul(0.07);

        glow.addAssign(outline.add(fill).mul(mark.y));
      });
    }

    return COLOUR.mul(glow).mul(sunIntensity.mul(0.35).add(0.04));
  })();
}

/**
 * Where to read the scene from for this pixel, its `depth` as `camera` saw
 * it: off to one side where a wave's passing, as if the ground there had
 * rolled up and out from the epicentre; where it is, otherwise.
 */
export function quakeWarp(depth, camera: Camera) {
  const cameraWorld = uniform(camera.matrixWorld);
  const cameraView = uniform(camera.matrixWorldInverse);
  const projection = uniform(camera.projectionMatrix);
  const projectionInverse = uniform(camera.projectionMatrixInverse);
  const cameraAt = uniform(camera.position);

  return Fn(() => {
    const from = screenUV.toVar();

    If(waves.greaterThan(0), () => {
      const sceneDepth = depth.sample(screenUV).r;
      const view = getViewPosition(screenUV, sceneDepth, projectionInverse);
      const world = cameraWorld.mul(vec4(view, 1)).xyz;
      let push: any = vec3(0);

      for (let i = 0; i < SLOTS; i++) {
        const ring = rings[i];
        const away = world.xz.sub(ring.xy);
        const along = away.length();
        const width = marks[i].z;
        const off = along.sub(ring.z).div(width);

        const wave = sin(off.mul(Math.PI * CRESTS))
          .mul(exp(off.mul(off).negate()))
          .mul(ring.w);

        const out = away.div(max(along, 1));
        push = push.add(vec3(out.x, 0.6, out.y).mul(wave));
      }

      const reach = world.distance(cameraAt).mul(THROW);

      const onScreen = (p) => {
        const clip = projection.mul(cameraView.mul(vec4(p, 1)));

        return clip.xy.div(clip.w);
      };

      // NDC is twice uv and y up; screenUV's y is down.
      const moved = onScreen(world.add(push.mul(reach))).sub(onScreen(world));

      // The sky stays put: there's no ground there to roll.
      If(sceneDepth.lessThan(0.99999), () => {
        from.addAssign(moved.mul(vec2(0.5, -0.5)));
      });
    });

    return from;
  })();
}
