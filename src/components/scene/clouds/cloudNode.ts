import { DataTexture } from "three/webgpu";
import {
  Break,
  Fn,
  If,
  Loop,
  dot,
  exp,
  float,
  fract,
  getViewPosition,
  max,
  min,
  mix,
  normalize,
  outputStruct,
  property,
  screenCoordinate,
  screenUV,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  overcast,
  sunDirection,
  sunIntensity,
  skyZenith,
  skyHorizon,
} from "../environment";
import { hazeColor, hazeTransmittance, phase } from "../haze";
import { cloudGlowAtNight, hazeGlowAtNight } from "../skyglow";
import {
  CloudLayerUniforms,
  deckLid,
  EXTINCTION,
  layerDensity,
  LOW_STYLE,
  MID_STYLE,
  remap,
  saturate,
} from "./density";
import { rainfall, RainUniforms } from "./rain";

export interface CloudQuality {
  /** Steps along the view ray. */
  steps: number;
  /** Steps toward the sun at each sample, for self-shadowing. */
  lightSteps: number;
  /** Render size relative to the canvas. */
  resolutionScale: number;
  /** Steps through the rain under the clouds. */
  rainSteps: number;
  /** Most raindrops drawn near the camera, in a downpour. */
  drops: number;
}

export const CLOUDS_DESKTOP: CloudQuality = {
  steps: 112,
  lightSteps: 4,
  resolutionScale: 0.5,
  rainSteps: 24,
  drops: 24000,
};

export const CLOUDS_MOBILE: CloudQuality = {
  steps: 64,
  lightSteps: 3,
  resolutionScale: 0.35,
  rainSteps: 12,
  drops: 9000,
};

const MAX_DISTANCE = 60000;
const MIN_STEP = 40;

/** Cloud fades out within this many metres of the camera. */
const NEAR_FADE = 600;

/** Step length as a fraction of distance from the camera. */
const STEP_GROWTH = 0.035;

/** Rain is marched this far; haze hides it beyond. */
const RAIN_DISTANCE = 25000;

/**
 * Rain shafts are lit by what gets under the cloud: a little darker than the
 * haze around them, so they read against a bright sky and lighter than hills.
 */
const RAIN_SHADE = 0.75;

/**
 * Raymarches the cloud layers for each screen pixel, stopping at the scene
 * depth. Writes two outputs: (scattered light, transmittance), to composite
 * with scene * a + rgb; and in r, how far off what it shows is, m (see
 * temporal), for a render target with two textures.
 */
export function createCloudNode({
  depth,
  cameraPosition,
  cameraWorld,
  projectionInverse,
  weather,
  low,
  mid,
  cirrus,
  rain,
  quality,
  offset = float(0),
}: {
  depth: any;
  cameraPosition: any;
  cameraWorld: any;
  projectionInverse: any;
  weather: DataTexture;
  low: CloudLayerUniforms;
  mid: CloudLayerUniforms;
  /** (altitude, coverage, -, -) and drift for the high sheet. */
  cirrus: CloudLayerUniforms;
  /** Falls from the low layer. */
  rain: RainUniforms;
  quality: CloudQuality;
  /**
   * Added to the start's jitter, 0..1 of a step. Changed each frame, the
   * frames average out (see temporal).
   */
  offset?: any;
}) {
  const density = (p, cheap = false) =>
    layerDensity(p, low, LOW_STYLE, { lid: deckLid, cheap }).add(
      layerDensity(p, mid, MID_STYLE, { cheap })
    );

  // Set by the march, written to the second output.
  const distance = property("float", "cloudDistance");

  const march = Fn(() => {
    // Ray from the camera through this pixel, as far as the scene goes.
    const sceneDepth = depth.sample(screenUV).r;
    const view = getViewPosition(screenUV, sceneDepth, projectionInverse);
    const world = cameraWorld.mul(vec4(view, 1)).xyz;
    const toScene = world.sub(cameraPosition);
    const direction = normalize(toScene);
    const sky = sceneDepth.greaterThanEqual(0.99999);
    const sceneDistance = sky.select(float(MAX_DISTANCE), toScene.length());

    // Clip the ray to the slab holding the volumetric layers.
    const bottom = min(low.shape.x, mid.shape.x);
    const top = max(low.shape.y, mid.shape.y);

    const safeY = direction.y
      .abs()
      .lessThan(1e-4)
      .select(float(1e-4), direction.y);

    const tBottom = bottom.sub(cameraPosition.y).div(safeY);
    const tTop = top.sub(cameraPosition.y).div(safeY);
    const tNear = max(min(tBottom, tTop), 0);
    const tFar = min(max(tBottom, tTop), min(sceneDistance, MAX_DISTANCE));

    const scattered = vec3(0).toVar();
    const transmittance = float(1).toVar();
    const firstHit = float(-1).toVar();
    // Distance into the cloud, weighted by how much each step shows.
    const depthSum = float(0).toVar();

    // Interleaved gradient noise jitters the start to trade banding for grain.
    const jitter = fract(
      dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))
        .mul(52.9829189)
        .add(offset)
    );

    const cosine = dot(direction, sunDirection);
    // Bright forward lobe for silver linings, gentle back lobe.
    const cloudPhase = mix(phase(cosine, 0.6), phase(cosine, -0.25), 0.35);
    // Phase functions integrate to 1 over the sphere (isotropic ≈ 0.08), so
    // the sun needs a big radiance for sunlit cloud to read as white.
    const sunLight = sunIntensity.mul(28);

    If(tFar.greaterThan(tNear), () => {
      // Steps grow with distance: fine near the camera, coarse far away
      // where haze hides the difference.
      const stepFor = (distance) => max(distance.mul(STEP_GROWTH), MIN_STEP);
      const t = tNear.toVar();
      const dt = stepFor(tNear).toVar();
      t.addAssign(dt.mul(jitter));

      Loop(quality.steps, () => {
        If(t.greaterThan(tFar).or(transmittance.lessThan(0.01)), () => {
          Break();
        });

        const p = cameraPosition.add(direction.mul(t));

        // Thin out right around the camera so it never sits in a white wall,
        // and toward the end of the march so the layer has no hard horizon.
        const d = density(p)
          .mul(smoothstep(NEAR_FADE * 0.25, NEAR_FADE, t))
          .mul(smoothstep(MAX_DISTANCE, MAX_DISTANCE * 0.6, t));

        If(d.greaterThan(0.001), () => {
          If(firstHit.lessThan(0), () => {
            firstHit.assign(t);
          });

          // Optical depth toward the sun, in growing steps.
          const toSun = float(0).toVar();
          let stride = 40;

          for (let i = 0; i < quality.lightSteps; i++) {
            const q = p.add(sunDirection.mul(stride * (i + 0.5)));
            toSun.addAssign(density(q, true).mul(stride));
            stride *= 2;
          }

          const sunTransmittance = exp(toSun.mul(-EXTINCTION));
          // Dark edges on the sunny side of dense cloud ("powder").
          const powder = float(1).sub(exp(toSun.mul(-EXTINCTION * 2)));

          const direct = sunTransmittance
            .mul(mix(1, powder, 0.5))
            .mul(cloudPhase)
            .mul(sunLight);

          // Sky light, brighter toward the tops. Under a deck, the sun
          // scattered many times through it lights the whole layer evenly,
          // where the march above sees it spent at the top.
          const height = saturate(p.y.sub(bottom).div(top.sub(bottom)));

          const ambient = mix(skyHorizon, skyZenith.mul(3), height)
            .mul(1.4)
            .add(overcast.mul(sunIntensity).mul(1.2));

          // At night the city lights the base; it's spent a little way in.
          const below = float(1).sub(height);

          const luminance = vec3(direct)
            .add(ambient)
            .add(cloudGlowAtNight(p).mul(below.mul(below)));

          const sigma = d.mul(EXTINCTION);
          const step = exp(sigma.mul(dt).negate());
          // Energy-conserving: light scattered over the step, attenuated.
          const shown = float(1).sub(step).mul(transmittance);
          scattered.addAssign(luminance.mul(shown));
          depthSum.addAssign(t.mul(shown));
          transmittance.mulAssign(step);
        });

        t.addAssign(dt);
        dt.assign(stepFor(t));
      });
    });

    const cloudOpacity = float(1).sub(transmittance).toVar();
    // Where there's no cloud to speak of: the scene, or the cirrus.
    const behind = sceneDistance.toVar();

    // Cirrus: a thin textured sheet high above, behind everything else.
    const cirrusHeight = cirrus.shape.x;
    If(
      sky.and(direction.y.greaterThan(0.01)).and(cirrus.shape.y.greaterThan(0)),
      () => {
        const tc = cirrusHeight.sub(cameraPosition.y).div(direction.y);
        const pc = cameraPosition.add(direction.mul(tc));
        behind.assign(min(tc, MAX_DISTANCE));
        // Stretched along the wind for streaks.
        const uv = pc.xz.add(cirrus.offset).div(vec2(70000, 22000));
        const streaks = texture(weather, uv).g;
        const wisps = texture(weather, uv.mul(5.3)).r;

        const amount = saturate(
          remap(
            streaks.mul(0.7).add(wisps.mul(0.3)),
            float(1).sub(cirrus.shape.y),
            float(1),
            float(0),
            float(1)
          )
        ).mul(0.55);

        const lum = vec3(phase(cosine, 0.5).mul(sunLight).mul(0.5)).add(
          skyHorizon.mul(1.6)
        );

        // Fade toward the horizon, where the sheet is very far away.
        const fadeOut = smoothstep(0.01, 0.15, direction.y);
        const alpha = amount.mul(fadeOut);
        scattered.addAssign(lum.mul(alpha).mul(transmittance));
        transmittance.mulAssign(float(1).sub(alpha));
      }
    );

    // Haze between the camera and the clouds.
    If(firstHit.greaterThan(0), () => {
      const hit = cameraPosition.add(direction.mul(firstHit));

      // The boundary-layer haze is thin at cloud height, but distant cloud
      // still melts into the horizon glow, softening the deck's eye-level edge.
      const clear = hazeTransmittance(cameraPosition, hit).mul(
        float(1).sub(smoothstep(15000, 85000, firstHit).mul(0.8))
      );

      const haze = hazeColor(direction).add(
        hazeGlowAtNight(cameraPosition, hit)
      );

      scattered.assign(
        scattered
          .mul(clear)
          .add(haze.mul(float(1).sub(clear)).mul(float(1).sub(transmittance)))
      );
    });

    // Rain shafts, from the low cloud's base down to the sea or the ground.
    // Samples bunch toward the camera, where the shafts are big on screen.
    If(rain.extinction.greaterThan(0), () => {
      const tBase = low.shape.x.sub(cameraPosition.y).div(safeY);
      const tSea = cameraPosition.y.negate().div(safeY);
      const r0 = max(min(tBase, tSea), 0);
      const r1 = min(max(tBase, tSea), min(sceneDistance, RAIN_DISTANCE));

      If(r1.greaterThan(r0), () => {
        const span = r1.sub(r0);
        const depth = float(0).toVar();
        Loop(quality.rainSteps, ({ i }) => {
          // t = r0 + span·u², so dt = 2·span·u·du.
          const u = float(i).add(jitter).div(quality.rainSteps);

          const p = cameraPosition.add(
            direction.mul(r0.add(span.mul(u.mul(u))))
          );

          const dt = span.mul(u).mul(2 / quality.rainSteps);
          // Haze hides far-off rain: count what shows through it.
          depth.addAssign(
            rainfall(weather, low, rain, p)
              .mul(hazeTransmittance(cameraPosition, p))
              .mul(dt)
          );
        });
        const through = exp(depth.mul(rain.extinction).negate());

        const light = hazeColor(direction).add(
          hazeGlowAtNight(cameraPosition, cameraPosition.add(direction.mul(r1)))
        );

        const shaft = light.mul(RAIN_SHADE).mul(float(1).sub(through));

        // From under the cloud the rain is in front of it; from above,
        // behind.
        const under = cameraPosition.y.lessThan(low.shape.x);
        scattered.assign(
          under.select(
            shaft.add(scattered.mul(through)),
            scattered.add(shaft.mul(transmittance))
          )
        );
        transmittance.mulAssign(through);
      });
    });

    distance.assign(
      cloudOpacity.greaterThan(0.02).select(depthSum.div(cloudOpacity), behind)
    );

    return vec4(scattered, transmittance);
  })();

  return outputStruct(march, vec4(distance, 0, 0, 1));
}
