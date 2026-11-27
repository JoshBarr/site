import { HalfFloatType } from "three/webgpu";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
import {
  Fn,
  If,
  Loop,
  dot,
  float,
  fract,
  getViewPosition,
  max,
  normalize,
  rtt,
  screenCoordinate,
  screenUV,
  vec2,
  vec4,
} from "three/tsl";
import { cloudShadowMap, moonlit, overcast, sunDirection } from "./environment";
import { hazeGlowToward, hazeTransmittance, outsideClearing } from "./haze";
import { sunUnderCloud } from "./cloudLight";
import { hazeSunFull } from "./sky/skyModel";
import { cloudLayers } from "./clouds/density";

// The haze is worked out in one go along each ray, as though the sun lit
// all of it: it glowed the same in a cloud's shadow as beside it. Here the
// ray's walked, coarsely and at low resolution, against the clouds' shadow
// map, for how much of the haze along it the sun doesn't reach; that much of
// the sun's glow is taken back out of the frame. Under broken cloud the air
// is darker under each cloud, and the sun comes down between them in shafts.

/** Steps along each ray. */
const STEPS = 10;

/** As far as a ray's walked, m: the shadow map ends, and the haze hides it. */
const REACH = 20000;

/** The pass's size, of the clouds' own. */
const SCALE = 0.5;

/** How far it's blurred, in its own pixels (the kernel's sigma). */
const BLUR = 2;

/**
 * Of each pixel's haze, the share (of the whole frame's light, 0..1) that
 * lies in cloud shadow, and (in g) the share the sun's on, as a texture at
 * low resolution: `shadedHaze` takes the one out. `depth` is the scene's
 * depth texture, the rest the scene camera's; `resolutionScale` the
 * clouds', of the drawing buffer.
 */
export function hazeShadow({
  depth,
  cameraPosition,
  cameraWorld,
  projectionInverse,
  resolutionScale,
}: {
  depth: any;
  cameraPosition: any;
  cameraWorld: any;
  projectionInverse: any;
  resolutionScale: number;
}) {
  const { low, mid } = cloudLayers;

  // Whether there are shadows to find: some cloud, and not a full deck,
  // under which there's no sun for the haze to have more or less of.
  const shadows = low.shape.z
    .greaterThan(0)
    .or(mid.shape.z.greaterThan(0))
    .and(overcast.lessThan(0.99));

  const march = Fn(() => {
    const lost = float(0).toVar();
    const lit = float(0).toVar();

    If(shadows, () => {
      const sceneDepth = depth.sample(screenUV).r;
      const view = getViewPosition(screenUV, sceneDepth, projectionInverse);
      const world = cameraWorld.mul(vec4(view, 1)).xyz;
      const toScene = world.sub(cameraPosition);
      const direction = normalize(toScene);
      const sky = sceneDepth.greaterThanEqual(0.99999);
      const end = sky.select(float(REACH), toScene.length().min(REACH));

      // Interleaved gradient noise, so the steps' banding is grain.
      const jitter = fract(
        dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715)).mul(52.9829189)
      );

      const through = float(1).toVar();

      Loop(STEPS, ({ i }) => {
        // Bunched toward the camera, where the haze counts most: the step
        // from u to u + 1/STEPS of the way, squared.
        const u = float(i).add(1).div(STEPS);
        const at = float(i).add(jitter).div(STEPS);
        const p = cameraPosition.add(direction.mul(end.mul(at.mul(at))));
        const far = cameraPosition.add(direction.mul(end.mul(u.mul(u))));

        // What this stretch of haze adds to the ray, of all it could.
        const beyond = hazeTransmittance(cameraPosition, far).toVar();

        const seen = cloudShadowMap.sample(p).toVar();

        lost.addAssign(through.sub(beyond).mul(float(1).sub(seen)));
        lit.addAssign(through.sub(beyond).mul(seen));
        through.assign(beyond);
      });

      // No haze is drawn around a followed vehicle; none to take back.
      const cleared = sky.select(float(1), outsideClearing(world));

      lost.mulAssign(cleared);
      lit.mulAssign(cleared);
    });

    return vec4(lost, lit, 0, 1);
  })();

  const walked = rtt(march, null, null, {
    type: HalfFloatType,
    resolutionScale: resolutionScale * SCALE,
  });

  // Blurred, at its own small size: the steps' grain shows as it's
  // stretched over the frame, and a shadow in haze has no edge to lose.
  return gaussianBlur(walked, 1, BLUR);
}

/**
 * `color` (the scene, hazed as though the sun reached all of it) less the
 * sun's glow in the haze found in cloud or hill shadow: `lost`, that share
 * of the frame's light (see hazeShadow, or the haze volume), and `lit` the
 * share the sun's on. The volume gives `rays` too, how much to make of the
 * glow there (1 as it is). `depth` is the scene's depth texture, the rest
 * the scene camera's.
 */
export function shadedHaze(
  color,
  { lost, lit, rays }: { lost: any; lit: any; rays?: any },
  {
    depth,
    cameraWorld,
    projectionInverse,
  }: { depth: any; cameraWorld: any; projectionInverse: any }
): any {
  const view = getViewPosition(screenUV, float(0.5), projectionInverse);
  const direction = normalize(cameraWorld.mul(vec4(view, 0)).xyz);

  // The sun's share of the haze's glow, as the fog on every material has
  // it (hazeColor): the sky model's by day, the moon's lobe by night.
  const lobe = hazeGlowToward(dot(direction, sunDirection), 0.6);
  const full = hazeSunFull(direction).add(lobe.mul(moonlit));

  // The scene's hazed as though the share of the sun that gets under the
  // cloud (./cloudLight.ts) reached all of it evenly, and this puts the sun
  // where it is: more of its glow where the ray's in the open, less where
  // it's in shadow, and nothing to change under a clear sky or a full deck.
  const sunned = rays ? lit.mul(rays) : lit;
  const all = lit.add(lost);

  // The sky's haze is drawn with that share too, but it's only ever
  // darkened here, never brightened: the cloud laid over it after has
  // nothing put back, and a brighter sky behind shows along every ridge,
  // where the cloud's soft edge lets it by.
  const drawn = depth
    .sample(screenUV)
    .r.greaterThanEqual(0.99999)
    .select(max(sunUnderCloud.mul(all), lit), sunUnderCloud.mul(all));

  return max(color.add(full.mul(sunned.sub(drawn))), 0);
}
