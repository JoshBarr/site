import { useEffect, useMemo, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  HalfFloatType,
  RenderPipeline,
  Scene,
  Vector2,
  Vector3,
} from "three/webgpu";
import { mix, pass, rtt, select, texture, uniform, vec4 } from "three/tsl";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
import { cloudShadowMap, overcast } from "../environment";
import { nightGlow, setNightGlow } from "../glow";
import { depthOfField } from "../lens";
import { dithered } from "../dither";
import { quakeWarp } from "../quakes/glow";
import { tvScreen } from "../time/tv";
import { switchedOff } from "../stats";
import { Conditions, windVector } from "../weather";
import { isFrozen, sceneNow } from "../clock";
import {
  cloudField,
  pullFor,
  type SeenClouds,
  setCloudField,
} from "./cloudField";
import { CloudQuality, createCloudNode } from "./cloudNode";
import {
  CloudLayerUniforms,
  cloudLayers as layers,
  deckLid,
  cloudNoise,
  cloudsSeen,
  NOISE_SIZE,
  WEATHER_SIZE,
} from "./density";
import { shapesFor } from "./layers";
import { createDrops, DROP_REACH } from "./drops";
import {
  applyRain,
  createRainUniforms,
  dropFraction,
  rainfallAt,
} from "./rain";
import {
  PlacedGauge,
  type RadarRates,
  rainField,
  setRainField,
  stepRainField,
} from "./rainField";
import { cloudHistory } from "./temporal";
import { lensWetness, updateLensWetness, wetLens } from "./wetLens";
import { useRenderer } from "../renderer";
import { setSceneDepth } from "../sceneDepth";
import {
  overCloudsPass,
  setOverCloudsDepth,
  useOverClouds,
} from "../overClouds";
import { createGovernor } from "../governor";
import { hazeShadow, shadedHaze } from "../hazeShadow";
import { airGlow, glowInAir } from "../skyglow";
import { createHazeVolume } from "../hazeVolume";
import { meterSky, skyStage, stopDown } from "../sky/skyModel";
import { hasFirstViewLoaded } from "../loading";
import { sceneShown } from "../visibility";

/**
 * Clouds drift at the real wind speed times this. Real time reads as
 * almost still from a distance.
 */
const DRIFT_SPEED = 2;

/** Wind picks up and veers with height. */
const MID_SPEED = 1.6;
const CIRRUS_SPEED = 3;
const CIRRUS_VEER = 25;

/** How often the radar's showers are carried on downwind, ms. */
const RAIN_STEP = 1000;

/** Water on the lens in rain. Off until it looks like water. */
const WET_LENS = false;

/**
 * The finished frame as the canvas shows it: stopped down where the sky
 * model's glow ahead is bright (?sky=), then tone mapped and dithered.
 */
const shown = (frame) =>
  dithered(skyStage() ? vec4(frame.rgb.mul(stopDown), frame.a) : frame);

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

/** Which way the camera faces, each frame. */
const facing = new Vector3();

/** The haze's shares in shadow and in the sun, by the march (hazeShadow). */
function walkedHaze(view: Parameters<typeof hazeShadow>[0]) {
  const walked = hazeShadow(view);

  return { lost: walked.r, lit: walked.g };
}

/**
 * Sets the layers to the weather's (./layers.ts). Not `shown`, the sky's no
 * less overcast, but there's no cloud to see.
 */
function applyConditions(
  conditions: Conditions,
  shown: boolean,
  low: CloudLayerUniforms,
  mid: CloudLayerUniforms,
  cirrus: CloudLayerUniforms
) {
  const shapes = shapesFor(conditions, shown);

  overcast.value = shapes.overcast;
  deckLid.value = shown ? shapes.lid : 0;
  low.shape.value.set(...shapes.low);
  mid.shape.value.set(...shapes.mid);
  cirrus.shape.value.set(...shapes.cirrus);
}

/**
 * Renders the scene, then volumetric clouds and their rain over it at reduced
 * resolution, and composites them, then the raindrops near the camera over
 * that. Takes over the frame from react-three-fiber. `night` (0..1) makes
 * lights glow, under the clouds. `hidden` leaves the cloud and rain out, the
 * light still as dull as the cover makes it, for looking down through them.
 * With `gauges` or the `radar`'s scans, the rain's where and as hard as
 * they measure it (./rainField.ts), whatever the forecast says; without,
 * it's the forecast's.
 * With what the satellite `seen`, the cloud's where it saw it
 * (./cloudField.ts).
 */
export function Clouds({
  conditions: forecast,
  gauges = null,
  radar = null,
  seen = null,
  quality,
  night = 0,
  hidden = false,
}: {
  conditions: Conditions;
  gauges?: PlacedGauge[] | null;
  radar?: RadarRates[] | null;
  seen?: SeenClouds | null;
  quality: CloudQuality;
  night?: number;
  hidden?: boolean;
}) {
  const renderer = useRenderer();
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  // Drawing every frame it can, not ticking over while it's hidden.
  const flatOut = useThree((state) => state.frameloop === "always");
  const noiseReady = useCloudNoise();
  const governor = useMemo(createGovernor, []);

  const rain = useMemo(createRainUniforms, []);

  // A shared texture too; its pull fades as the scan ages.
  useEffect(() => {
    if (!seen) {
      setCloudField(null);

      return;
    }

    setCloudField(seen, sceneNow() - seen.time);

    const timer = setInterval(() => {
      cloudField.pull.value = pullFor(sceneNow() - seen.time);
    }, 60_000);

    return () => clearInterval(timer);
  }, [seen]);

  // The field's a shared texture, filled as the gauges and the radar's
  // scans change. Showers with no scans to follow drift on the wind aloft.
  const { speed: aloft, direction: aloftFrom } = forecast.windAloft;

  const filled = useMemo(() => {
    const [x, z] = windVector(aloft, aloftFrom);

    return {
      hardest: setRainField(
        gauges,
        radar && { scans: radar, now: sceneNow(), drift: [x, z] }
      ),
    };
  }, [gauges, radar, aloft, aloftFrom]);

  // Between scans the radar's showers drift on, a little at a time: the
  // hardest rate changes as they cross the map's edge.
  const [drifted, setDrifted] = useState<{
    of: typeof filled;
    hardest: number | null;
  } | null>(null);

  useEffect(() => {
    if (!radar) return;

    const timer = setInterval(() => {
      const hardest = stepRainField(sceneNow());

      setDrifted((last) =>
        last?.of === filled && last.hardest === hardest
          ? last
          : { of: filled, hardest }
      );
    }, RAIN_STEP);

    return () => clearInterval(timer);
  }, [filled, radar]);

  const measured = drifted?.of === filled ? drifted.hardest : filled.hardest;

  const conditions = useMemo(
    () =>
      measured === null ? forecast : { ...forecast, precipitation: measured },
    [forecast, measured]
  );

  useEffect(() => {
    applyConditions(conditions, !hidden, layers.low, layers.mid, layers.cirrus);
    applyRain(hidden ? { ...conditions, precipitation: 0 } : conditions, rain);
    rainField.deck.value = !hidden && measured ? 1 : 0;
  }, [conditions, rain, hidden, measured]);

  const raining = !hidden && conditions.precipitation > 0;
  const overlaid = useOverClouds();

  // Through dusk only the strength moves; the passes change at its ends.
  const dark = night > 0;
  useEffect(() => {
    setNightGlow(night);
  }, [night]);

  // The city's glow in the haze, from the haze's volume (see skyglow).
  const inAir = useMemo(() => !switchedOff("airglow"), []);

  const { scenePass, pipeline, glow, history, drops, tv, volume } =
    useMemo(() => {
      const pipeline = new RenderPipeline(renderer);
      // Tone mapped and dithered by hand, as its last node (see dithered).
      pipeline.outputColorTransform = false;
      const scenePass = pass(scene, camera);
      const depth = scenePass.getTextureNode("depth");
      const output = scenePass.getTextureNode("output");
      const glow = nightGlow(output, dark);

      // What's drawn over the clouds (../overClouds.ts), last: in front of
      // them, but with no depth of its own for them to stop at.
      let lay = (under) => under;

      if (overlaid) {
        setOverCloudsDepth(scenePass.getTexture("depth"));

        const above = overCloudsPass(camera);

        lay = (under) =>
          vec4(under.rgb.mul(above.a.oneMinus()).add(above.rgb), 1);
      }

      // Bent where a quake's wave is passing.
      const seen = output.sample(quakeWarp(depth, camera));
      const color = glow ? seen.add(glow) : seen;

      if (!noiseReady || switchedOff("clouds")) {
        const tv = tvScreen(lay(depthOfField(color, depth)));
        pipeline.outputNode = shown(tv.node);

        return {
          scenePass,
          pipeline,
          glow,
          history: null,
          drops: null,
          tv,
          volume: null,
        };
      }

      const offset = uniform(0);
      const accumulated = !switchedOff("cloudhistory");

      // A quarter of the march's pixels a frame, the rest kept from the
      // history: which of each four, set by the history as it goes.
      const sub =
        accumulated && !switchedOff("cloudquarter")
          ? uniform(new Vector2())
          : null;

      const cloudNode = createCloudNode({
        depth: scenePass.getTextureNode("depth"),
        cameraPosition: uniform(camera.position),
        cameraWorld: uniform(camera.matrixWorld),
        projectionInverse: uniform(camera.projectionMatrixInverse),
        weather: cloudNoise.weather,
        ...layers,
        rain,
        quality,
        offset,
        sub,
      });

      // Relative to CSS pixels: on a 2x display the march would otherwise do
      // four times the work for detail the softness of clouds doesn't need.
      // A second texture for how far off the cloud is.
      const clouds = rtt(cloudNode, null, null, {
        type: HalfFloatType,
        resolutionScale:
          (quality.resolutionScale / renderer.getPixelRatio()) *
          (sub ? 0.5 : 1),
        count: 2,
      });

      const history = accumulated
        ? cloudHistory(
            clouds,
            texture(clouds.renderTarget!.textures[1]),
            camera,
            offset,
            sub
          )
        : null;

      // The haze in the clouds' shadows goes dark, before they're laid over.
      const eye = {
        cameraPosition: uniform(camera.position),
        cameraWorld: uniform(camera.matrixWorld),
        projectionInverse: uniform(camera.projectionMatrixInverse),
      };

      const webgpu =
        "isWebGPUBackend" in renderer.backend &&
        renderer.backend.isWebGPUBackend === true;

      // From a volume over the view where there's compute to fill it
      // (?off=froxels for the march it replaced, as the WebGL fallback has).
      const volume =
        webgpu && !switchedOff("hazeshadow") && !switchedOff("froxels")
          ? createHazeVolume(eye)
          : null;

      const air = volume?.sample(depth);

      const shaded: typeof color.rgb = switchedOff("hazeshadow")
        ? color.rgb
        : shadedHaze(
            color.rgb,
            air && volume
              ? { ...air, rays: volume.rays }
              : walkedHaze({
                  depth,
                  ...eye,
                  resolutionScale:
                    quality.resolutionScale / renderer.getPixelRatio(),
                }),
            { depth, ...eye }
          );

      // And lit by the city at night, where the volume sums that up too.
      const lit: typeof color.rgb =
        air && inAir ? shaded.add(airGlow(air.glow)) : shaded;

      // Just enough blur to dissolve the march's jitter grain.
      const settled = history?.getTextureNode() ?? clouds;
      const soft = gaussianBlur(settled, 1, 0.4);

      // Faded out by cloudsSeen; not drawn at all once it's 0.
      const cloudy = lit.mul(soft.a).add(soft.rgb);

      const composite: any = depthOfField(
        vec4(
          select(cloudsSeen.greaterThan(0), mix(lit, cloudy, cloudsSeen), lit),
          1
        ),
        depth
      );

      if (!raining) {
        const tv = tvScreen(lay(composite));
        pipeline.outputNode = shown(tv.node);

        return { scenePass, pipeline, glow, history, drops: null, tv, volume };
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

      // Soft-edged and at least a couple of pixels wide: no MSAA needed.
      const streaks = pass(rainScene, camera, { samples: 0 }).getTextureNode(
        "output"
      );

      // And water on the lens over everything. What it bends into view is
      // blurred anyway, so it goes without the depth of field (and glow).
      const over = (under, layer) =>
        under.mul(layer.a.oneMinus()).add(layer.rgb);

      if (!WET_LENS) {
        const tv = tvScreen(vec4(over(lay(composite).rgb, streaks), 1));
        pipeline.outputNode = shown(tv.node);

        return { scenePass, pipeline, glow, history, drops, tv, volume };
      }

      const tv = tvScreen(
        wetLens(vec4(over(lay(composite).rgb, streaks), 1), (uv) => {
          const sky = settled.sample(uv);

          return over(
            output.sample(uv).rgb.mul(sky.a).add(sky.rgb),
            streaks.sample(uv)
          );
        })
      );

      pipeline.outputNode = shown(tv.node);

      return { scenePass, pipeline, glow, history, drops, tv, volume };
    }, [
      renderer,
      scene,
      camera,
      noiseReady,
      rain,
      quality,
      dark,
      raining,
      inAir,
      overlaid,
    ]);

  // For reading back what's in front of what.
  useEffect(() => {
    setSceneDepth(scenePass.getTexture("depth"));

    return () => setSceneDepth(null);
  }, [scenePass]);

  useEffect(
    () => () => {
      glowInAir.value = 0;
      pipeline.dispose();
      tv.dispose();
      glow?.dispose();
      history?.dispose();
      volume?.dispose();
      drops?.geometry.dispose();
      drops?.material.dispose();
    },
    [pipeline, tv, glow, history, drops, volume]
  );

  useEffect(() => {
    if (!drops) return;
    drops.geometry.instanceCount = Math.round(
      quality.drops * dropFraction(conditions.precipitation)
    );
  }, [drops, quality, conditions.precipitation]);

  useFrame((_, delta) => {
    const { speed, direction } = conditions.windAloft;

    // Held still (?freeze), so shots of the same view can be compared.
    const held = isFrozen();

    const drift = (layer: CloudLayerUniforms, factor: number, veer = 0) => {
      if (held) return;
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
    tv.update(delta);
    meterSky(camera.getWorldDirection(facing), delta);

    // The scene's own pass, smaller when frames run late (see governor).
    // The clouds, the lens and the dither keep the canvas's size: they read
    // it by where on screen, not by pixel.
    const scale = governor.frame(
      delta,
      flatOut && sceneShown() && hasFirstViewLoaded()
    );

    if (scale !== scenePass.getResolutionScale()) {
      scenePass.setResolutionScale(scale);
    }

    // The haze's volume, for the camera as this frame draws it: three
    // doesn't work its matrix out until the scene's drawn.
    if (volume) {
      camera.updateMatrixWorld();

      const filled = volume.update(
        renderer,
        scenePass.getTexture("depth"),
        scenePass.renderTarget.width,
        scenePass.renderTarget.height
      );

      glowInAir.value = filled && inAir ? 1 : 0;
    } else {
      glowInAir.value = 0;
    }

    pipeline.render();
  }, 1);

  return null;
}
