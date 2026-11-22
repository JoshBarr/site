import {
  ComputeNode,
  HalfFloatType,
  LinearFilter,
  Storage3DTexture,
  Texture,
  Vector2,
  WebGPURenderer,
} from "three/webgpu";
import {
  Fn,
  Loop,
  dot,
  float,
  fract,
  getViewPosition,
  instanceIndex,
  int,
  ivec2,
  ivec3,
  min,
  normalize,
  screenUV,
  sqrt,
  storageTexture3D,
  texture3D,
  textureLoad,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  cloudShadowMap,
  overcast,
  SHADOW_MAP_SIZE,
  sunLight,
} from "./environment";
import { hazeTransmittance, outsideClearing } from "./haze";
import { track } from "./loading";
import { switchedOff } from "./stats";

// The haze's light and shadow as a volume: a grid over the view, a cell for
// every few pixels across and down and a slice for every stretch of depth
// (froxels), filled once a frame by a compute pass. Each column of cells is
// one ray walked out from the eye, asking of every stretch of haze whether
// the sun reaches it: past the clouds (their shadow map) and past the hills
// (the sun's own). Every cell holds the sum so far, so a pixel reads its
// answer in one filtered tap at its own depth.
//
// It stands in for hazeShadow's march, which walked ten steps a pixel at a
// quarter of the clouds' size and blurred the result across the screen: a
// ridge took on the shadow of the valley behind it, and a hill's own shadow
// in the air wasn't there at all. Here a ridge and the valley behind it read
// different cells, and there are 64 steps to a ray. It isn't cheaper: on the
// M1 at 2880×1800 a frame takes about 0.4 ms longer with it than with the
// march (the pass itself about 0.6 ms). The grid's the same 14,400 rays
// whatever the screen's size.

/** Cells across, down and into the view. */
const WIDTH = 160;
const HEIGHT = 90;
const DEPTH = 64;

/**
 * Times a slice the hills' shadow is asked after. Once, each ray's stagger
 * showed as stripes down the hills; four cost 0.3 ms more than two and
 * looked the same.
 */
const SUB = 2;

/** As far as the volume reaches, m: the cloud shadow map ends, and the haze hides it. */
const REACH = 20000;

/**
 * How far behind the hills' shadow map a point must be to count as in
 * shadow, of the map's depth (60 km): the air just over a slope would
 * otherwise flicker in and out of the slope's own shadow.
 */
const BIAS = 3e-4;

/** What the page asked of the sun's glow in lit haze, of its own: ?rays=2. */
function askedRays() {
  const asked = new URLSearchParams(globalThis.location?.search ?? "").get(
    "rays"
  );

  return asked === null ? 1 : Number(asked) || 1;
}

interface Eye {
  cameraPosition: any;
  cameraWorld: any;
  projectionInverse: any;
}

/**
 * The volume, for the scene camera `eye`. `update` fills it, each frame
 * before the scene's drawn; `sample` reads it at a pixel, by the scene's
 * depth texture.
 */
export function createHazeVolume(eye: Eye) {
  const { cameraPosition, cameraWorld, projectionInverse } = eye;
  const volume = new Storage3DTexture(WIDTH, HEIGHT, DEPTH);

  volume.type = HalfFloatType;
  volume.magFilter = volume.minFilter = LinearFilter;
  volume.generateMipmaps = false;

  const hills = !switchedOff("hillshafts");
  const shadowMatrix = uniform(sunLight.shadow.matrix);

  /**
   * The size of the scene's depth as last drawn, which says where each ray
   * met the ground a frame ago. Past there a ray's under the ground, where
   * the sun's map calls everything shadowed.
   */
  const depthSize = uniform(new Vector2(1, 1));

  /** How far along a ray, 0..1 of REACH, cell boundary `u` lies. */
  const along = (u) => u.mul(u).mul(REACH);

  const build = (sunDepth: Texture | null, sceneDepth: Texture | null) =>
    Fn(() => {
      const x = instanceIndex.mod(WIDTH).toVar();
      const y = instanceIndex.div(WIDTH).toVar();
      const uv = vec2(x, y).add(0.5).div(vec2(WIDTH, HEIGHT)).toVar();
      const view = getViewPosition(uv, float(0.5), projectionInverse);
      const direction = normalize(cameraWorld.mul(vec4(view, 0)).xyz).toVar();

      // A different stagger for each ray, so the slices' banding comes out
      // as grain, and as unlike its neighbours' as can be (the R2 sequence),
      // so the filtered read (four rays to a pixel) smooths it.
      const jitter = fract(
        dot(vec2(x, y), vec2(0.7548776662, 0.569840291))
      ).toVar();

      // Where this ray met the ground last frame, m.
      const ground = float(1e9).toVar();

      if (sceneDepth) {
        const at = ivec2(uv.mul(depthSize).min(depthSize.sub(1)));
        const depth = textureLoad(sceneDepth, at).r;

        ground.assign(
          depth
            .greaterThanEqual(0.99999)
            .select(1e9, getViewPosition(uv, depth, projectionInverse).length())
        );
      }

      /** Whether the sun's over the hills at p: 1 lit, 0 in their shadow. */
      const overHills = (p) => {
        if (!sunDepth) return float(1);

        const at = shadowMatrix.mul(vec4(p, 1));
        const coord = at.xyz.div(at.w).toVar();
        const st = vec2(coord.x, coord.y.oneMinus());

        const inside = st.x
          .greaterThan(0)
          .and(st.x.lessThan(1))
          .and(st.y.greaterThan(0))
          .and(st.y.lessThan(1))
          .and(coord.z.greaterThan(0))
          .and(coord.z.lessThan(1));

        const texel = ivec2(
          st.mul(SHADOW_MAP_SIZE).clamp(0, SHADOW_MAP_SIZE - 1)
        );

        const nearest = textureLoad(sunDepth, texel).r;

        return inside.and(coord.z.greaterThan(nearest.add(BIAS))).select(0, 1);
      };

      const lost = float(0).toVar();
      const lit = float(0).toVar();
      const through = float(1).toVar();
      const hill = float(1).toVar();

      Loop(DEPTH, ({ i }) => {
        const far = cameraPosition.add(
          direction.mul(along(float(i).add(1).div(DEPTH)))
        );

        // The hills' shadows are sharp, and a ray toward a low sun runs
        // along their edges: asked several times a slice. Under the ground
        // the answer's kept from the last of the air: it's the pixels beside
        // this ray, seeing past the ground it met, that read these cells.
        const hills = float(0).toVar();

        for (let sub = 0; sub < SUB; sub++) {
          const t = along(float(i).add(jitter.add(sub).div(SUB)).div(DEPTH));

          hill.assign(
            t
              .lessThan(ground)
              .select(overHills(cameraPosition.add(direction.mul(t))), hill)
          );
          hills.addAssign(hill.div(SUB));
        }

        // The clouds' are soft: once, midway.
        const p = cameraPosition.add(
          direction.mul(along(float(i).add(0.5).div(DEPTH)))
        );

        const seen = cloudShadowMap.sample(p).mul(hills);
        // What this stretch of haze adds to the ray, of all it could.
        const beyond = hazeTransmittance(cameraPosition, far).toVar();
        const share = through.sub(beyond);

        lost.addAssign(share.mul(float(1).sub(seen)));
        lit.addAssign(share.mul(seen));
        through.assign(beyond);

        // SAFETY: a storage texture's written by cell (ivec3); the types
        // only know of reading one by where (vec3).
        storageTexture3D(
          volume,
          ivec3(int(x), int(y), i) as any,
          vec4(lost, lit, 0, 1)
        ).toStack();
      });
    })().compute(WIDTH * HEIGHT);

  let pass: ComputeNode | null = null;
  let compiled: Promise<void> | null = null;
  let ready = false;

  return {
    /** The sun's glow in lit haze, of its own: 1 as it is, more for shafts. */
    rays: uniform(askedRays()),

    /**
     * Of a pixel's haze, the share (of the whole frame's light, 0..1) in
     * shadow, and the share lit: `depth` is the scene's depth texture node.
     */
    sample(depth) {
      const sceneDepth = depth.sample(screenUV).r;
      const view = getViewPosition(screenUV, sceneDepth, projectionInverse);
      const sky = sceneDepth.greaterThanEqual(0.99999);
      const t = sky.select(float(REACH), min(view.length(), REACH));
      const w = sqrt(t.div(REACH));

      // A cell holds the sum to its far side, so its centre stands for
      // half a cell further than it lies; nearer than the first, the sum
      // grows from nothing at the eye.
      const read = texture3D(volume, vec3(screenUV, w.sub(0.5 / DEPTH))).mul(
        min(w.mul(DEPTH), 1)
      );

      // No haze is drawn around a followed vehicle; none to take back.
      const world = cameraWorld.mul(vec4(view, 1)).xyz;

      const shown = float(1)
        .sub(overcast)
        .mul(sky.select(float(1), outsideClearing(world)));

      return { lost: read.r.mul(shown), lit: read.g.mul(shown) };
    },

    /**
     * Fills the volume for this frame's camera. `sceneDepth` is the scene
     * pass's depth texture, `width` and `height` its size.
     */
    update(
      renderer: WebGPURenderer,
      sceneDepth: Texture,
      width: number,
      height: number
    ) {
      if (!pass) {
        // The sun's map is made when its shadow's first drawn; until then
        // the volume's empty, and the haze unshaded.
        const sunDepth = sunLight.shadow.map?.depthTexture ?? null;

        if (hills && !sunDepth) return;

        pass = build(hills ? sunDepth : null, hills ? sceneDepth : null);
      }

      depthSize.value.set(width, height);

      // Compiled in the background: three dispatches a compute pass
      // whether its pipeline's ready or not (see pipelines.ts).
      if (!ready) {
        compiled ??= track(renderer.compileComputeAsync(pass)).then(() => {
          ready = true;
        });

        return;
      }

      renderer.compute(pass);
    },

    dispose() {
      pass?.dispose();
      volume.dispose();
    },
  };
}
