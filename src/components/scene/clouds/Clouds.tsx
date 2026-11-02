import { useEffect, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { HalfFloatType, RenderPipeline, Scene } from "three/webgpu";
import { pass, rtt, uniform, vec4 } from "three/tsl";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
import { cloudShadowMap, overcast, overcastFor } from "../environment";
import { nightGlow, setNightGlow } from "../glow";
import { depthOfField } from "../lens";
import { Conditions, lowCloudBase, windVector } from "../weather";
import { CloudQuality, createCloudNode } from "./cloudNode";
import {
  CloudLayerUniforms,
  cloudLayers as layers,
  cloudNoise,
  NOISE_SIZE,
  WEATHER_SIZE,
} from "./density";
import { createDrops, DROP_REACH } from "./drops";
import {
  applyRain,
  createRainUniforms,
  dropFraction,
  rainfallAt,
} from "./rain";
import { lensWetness, updateLensWetness, wetLens } from "./wetLens";
import { useRenderer } from "../renderer";

/**
 * Clouds drift at the real wind speed times this. Real time reads as
 * almost still from a distance.
 */
const DRIFT_SPEED = 2;

/** Wind picks up and veers with height. */
const MID_SPEED = 1.6;
const CIRRUS_SPEED = 3;
const CIRRUS_VEER = 25;

/** Water on the lens in rain. Off until it looks like water. */
const WET_LENS = false;

/**
 * Fills the shared noise textures off the main thread. True once they hold
 * the noise.
 */
function useCloudNoise() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL("./noiseWorker.ts", import.meta.url));
    worker.onmessage = ({ data }) => {
      const { shape, weather, shapeData, weatherData } = cloudNoise;
      shapeData.set(data.shape);
      shape.needsUpdate = true;
      weatherData.set(data.weather);
      weather.needsUpdate = true;
      setReady(true);
      worker.terminate();
    };

    worker.postMessage({ size: NOISE_SIZE, weatherSize: WEATHER_SIZE });

    return () => worker.terminate();
  }, []);

  return ready;
}

/**
 * MetService gives total cover and a cloud base, not layers, so share the
 * cover out: low cloud sits on the reported base (often wrapping the hills),
 * cumulus above it, and a cirrus sheet that's nearly always faintly there.
 */
function applyConditions(
  conditions: Conditions,
  low: CloudLayerUniforms,
  mid: CloudLayerUniforms,
  cirrus: CloudLayerUniforms
) {
  const cover = Math.min(Math.max(conditions.cloudCover, 0), 1);
  overcast.value = overcastFor(cover);
  const base = lowCloudBase(conditions);
  // A full deck is thick; broken cloud is shallower.
  const lowTop = base + 250 + 600 * cover + 400 * overcast.value;
  low.shape.value.set(base, lowTop, cover * 0.95, 1);

  const midBase = Math.max(lowTop + 400, 1800);
  mid.shape.value.set(midBase, midBase + 900 + 1200 * cover, cover * 0.4, 0.8);

  // No cover at all is a clear sky, cirrus too.
  cirrus.shape.value.set(7500, cover > 0 ? 0.15 + 0.45 * cover : 0, 0, 0);
}

/**
 * Renders the scene, then volumetric clouds and their rain over it at reduced
 * resolution, and composites them, then the raindrops near the camera over
 * that. Takes over the frame from react-three-fiber. `night` (0..1) makes
 * lights glow, under the clouds.
 */
export function Clouds({
  conditions,
  quality,
  night = 0,
}: {
  conditions: Conditions;
  quality: CloudQuality;
  night?: number;
}) {
  const renderer = useRenderer();
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const noiseReady = useCloudNoise();

  const rain = useMemo(createRainUniforms, []);

  useEffect(() => {
    applyConditions(conditions, layers.low, layers.mid, layers.cirrus);
    applyRain(conditions, rain);
  }, [conditions, rain]);

  const raining = conditions.precipitation > 0;

  // Through dusk only the strength moves; the passes change at its ends.
  const dark = night > 0;
  useEffect(() => {
    setNightGlow(night);
  }, [night]);

  const { pipeline, glow, drops } = useMemo(() => {
    const pipeline = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const viewZ = scenePass.getViewZNode();
    const output = scenePass.getTextureNode("output");
    const glow = nightGlow(output, dark);
    const color = glow ? output.add(glow) : output;

    if (!noiseReady) {
      pipeline.outputNode = depthOfField(color, viewZ);

      return { pipeline, glow, drops: null };
    }

    const cloudNode = createCloudNode({
      depth: scenePass.getTextureNode("depth"),
      cameraPosition: uniform(camera.position),
      cameraWorld: uniform(camera.matrixWorld),
      projectionInverse: uniform(camera.projectionMatrixInverse),
      weather: cloudNoise.weather,
      ...layers,
      rain,
      quality,
      night: dark,
    });

    // Relative to CSS pixels: on a 2x display the march would otherwise do
    // four times the work for detail the softness of clouds doesn't need.
    const clouds = rtt(cloudNode, null, null, {
      type: HalfFloatType,
      resolutionScale: quality.resolutionScale / renderer.getPixelRatio(),
    });

    // Just enough blur to dissolve the march's jitter grain.
    const soft = gaussianBlur(clouds, 1, 0.4);

    const composite: any = depthOfField(
      vec4(color.rgb.mul(soft.a).add(soft.rgb), 1),
      viewZ
    );

    if (!raining) {
      pipeline.outputNode = composite;

      return { pipeline, glow, drops: null };
    }

    // Drops go over the clouds: from under them, they're in front.
    const drops = createDrops({
      weather: cloudNoise.weather,
      low: layers.low,
      rain,
      sceneDepth: scenePass.getTextureNode("depth"),
      count: quality.drops,
    });

    const rainScene = new Scene();
    rainScene.add(drops);
    const streaks = pass(rainScene, camera).getTextureNode("output");
    // And water on the lens over everything. What it bends into view is
    // blurred anyway, so it goes without the depth of field (and glow).
    const over = (under, layer) => under.mul(layer.a.oneMinus()).add(layer.rgb);

    if (!WET_LENS) {
      pipeline.outputNode = vec4(over(composite.rgb, streaks), 1);

      return { pipeline, glow, drops };
    }

    pipeline.outputNode = wetLens(
      vec4(over(composite.rgb, streaks), 1),
      (uv) => {
        const sky = clouds.sample(uv);

        return over(
          output.sample(uv).rgb.mul(sky.a).add(sky.rgb),
          streaks.sample(uv)
        );
      }
    );

    return { pipeline, glow, drops };
  }, [renderer, scene, camera, noiseReady, rain, quality, dark, raining]);

  useEffect(
    () => () => {
      pipeline.dispose();
      glow?.dispose();
      drops?.geometry.dispose();
      drops?.material.dispose();
    },
    [pipeline, glow, drops]
  );

  useEffect(() => {
    if (!drops) return;
    drops.geometry.instanceCount = Math.round(
      quality.drops * dropFraction(conditions.precipitation)
    );
  }, [drops, quality, conditions.precipitation]);

  useFrame((_, delta) => {
    const { speed, direction } = conditions.windAloft;

    const drift = (layer: CloudLayerUniforms, factor: number, veer = 0) => {
      const [vx, vz] = windVector(speed * factor, direction + veer);
      // Sampling at p + offset moves the pattern along -offset.
      layer.offset.value.x -= vx * delta * DRIFT_SPEED;
      layer.offset.value.y -= vz * delta * DRIFT_SPEED;
    };

    drift(layers.low, 1);
    drift(layers.mid, MID_SPEED);
    drift(layers.cirrus, CIRRUS_SPEED, CIRRUS_VEER);

    // Far enough above the cloud base there are no drops to see.
    if (drops) {
      drops.visible = camera.position.y - DROP_REACH < layers.low.shape.value.x;

      const onCamera = rainfallAt(
        cloudNoise.weather,
        layers.low,
        rain,
        camera.position
      );

      if (WET_LENS)
        updateLensWetness(
          camera,
          onCamera * dropFraction(conditions.precipitation),
          rain,
          delta
        );
    } else {
      lensWetness.value = 0;
    }

    cloudShadowMap.update(
      renderer,
      camera.position.x,
      camera.position.z,
      delta
    );
    pipeline.render();
  }, 1);

  return null;
}
