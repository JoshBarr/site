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
import { hazeSunRadiance, skyStage } from "./sky/skyModel";
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
 * lies in cloud shadow, as a texture at low resolution: `shadedHaze` takes
 * it out. `depth` is the scene's depth texture, the rest the scene camera's;
 * `resolutionScale` the clouds', of the drawing buffer.
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
  // under which they fade out (see cloudShadow in environment).
  const shadows = low.shape.z
    .greaterThan(0)
    .or(mid.shape.z.greaterThan(0))
    .and(overcast.lessThan(0.99));

  const march = Fn(() => {
    const lost = float(0).toVar();

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

        lost.addAssign(
          through.sub(beyond).mul(float(1).sub(cloudShadowMap.sample(p)))
        );
        through.assign(beyond);
      });

      // No haze is drawn around a followed vehicle; none to take back.
      lost.mulAssign(
        float(1)
          .sub(overcast)
          .mul(sky.select(float(1), outsideClearing(world)))
      );
    });

    return vec4(lost, 0, 0, 1);
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
 * sun's glow in the haze that `shadow` (see hazeShadow) found in cloud
 * shadow.
 */
export function shadedHaze(
  color,
  shadow,
  {
    cameraWorld,
    projectionInverse,
  }: { cameraWorld: any; projectionInverse: any }
): any {
  const view = getViewPosition(screenUV, float(0.5), projectionInverse);
  const direction = normalize(cameraWorld.mul(vec4(view, 0)).xyz);

  // The sun's share of the haze's glow, as the fog on every material has
  // it (hazeColor): the sky model's from its fourth stage.
  const lobe = hazeGlowToward(dot(direction, sunDirection), 0.6);

  const glow =
    skyStage() >= 4 ? hazeSunRadiance(direction).add(lobe.mul(moonlit)) : lobe;

  return max(color.sub(glow.mul(shadow.r)), 0);
}
