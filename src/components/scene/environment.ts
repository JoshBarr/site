import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Vector3,
} from "three/webgpu";
import {
  BasicShadowFilter,
  float,
  mix,
  positionWorld,
  shadow,
  uniform,
} from "three/tsl";
import { createCloudShadowMap } from "./clouds/shadow";

// Scene-wide lighting state, shared by materials that shade themselves
// (water, later sky and clouds). The Sun component keeps these current.

/** Unit vector toward the sun (x east, y up, z south). */
export const sunDirection = uniform(new Vector3(0, 1, 0));
export const sunIntensity = uniform(1);

/** Sky colour at the horizon and overhead. Also the fog colour. */
export const skyHorizon = uniform(new Color("#3a3a3a"));
export const skyZenith = uniform(new Color("#0a0a0a"));

/**
 * How much of the sky's own light is left, 1 by day to NIGHT_SKY at night:
 * the sky and the haze it lights go dark, so the haze doesn't hang over the
 * night like a grey fog. The city's glow in it is added on top.
 */
export const skyBrightness = uniform(1);

const NIGHT_SKY = 0.3;

/** skyBrightness for `night`, 0 by day to 1 at night. */
export function skyBrightnessFor(night: number) {
  return 1 - (1 - NIGHT_SKY) * night;
}

/**
 * The sea's height, metres above mean sea level (the terrain's zero): the
 * tide, which ./ocean/tide.ts keeps current. The water, and whatever floats
 * on it, sit at this.
 */
export const seaLevel = uniform(0);

/**
 * 0..1: how close to a full grey lid the sky is. Closes the low cloud into a
 * deck and dims the sun.
 */
export const overcast = uniform(0);

/** Overcast amount for a cloud cover fraction: full cover reads as a lid. */
export function overcastFor(cloudCover: number) {
  const t = Math.min(Math.max((cloudCover - 0.7) / 0.3, 0), 1);

  return t * t * (3 - 2 * t);
}

/**
 * The sky's even light: the ambient light's intensity, for materials that
 * shade themselves.
 */
export const skylight = uniform(0.25);

/**
 * Skylight for a cloud cover fraction, 0 at night to 1 by day. A deck takes
 * the sun but spreads it into flat light from everywhere, so by day an
 * overcast sky lights the scene nearly as much as the sun did.
 */
export function skylightFor(cloudCover: number, daylight: number) {
  return 0.25 + overcastFor(cloudCover) * (0.3 + 0.6 * daylight);
}

/**
 * Of the sky's light, what comes back up off the ground: onto walls it's
 * half and half, onto undersides all there is.
 */
const GROUND_BOUNCE = 0.35;

/**
 * The sky as a light, at skylight's intensity: all of it on what faces up,
 * less on walls, and only the ground's bounce on what faces down. Lit evenly
 * from every side, an overcast city (when the sky is most of the light) had
 * no faces to it at all.
 */
export const skyDome = new HemisphereLight(
  new Color().setScalar(1),
  new Color().setScalar(GROUND_BOUNCE)
);

/**
 * Objects on this layer are seen only by the water's reflection camera, which
 * sees nothing else (bar the sky). Lets reflections use cheaper stand-ins.
 */
export const REFLECTION_LAYER = 1;

/** The shadow-casting stand-in for the terrain, seen only by shadow cameras. */
export const SHADOW_LAYER = 2;

/** Bumped when shadow casters change, so the shadow map can re-render. */
export const shadowCasters = { version: 0 };

/**
 * Small casters (towers, turbines) are too fine for the sun's map; they go on
 * this layer and into a finer map that follows the view (see nearShadow).
 */
export const NEAR_SHADOW_LAYER = 3;

/** The sun. Created here so its shadow can be shared (see sunShadow). */
export const sunLight = new DirectionalLight();

/**
 * The sun's shadow factor (1 lit, 0 shadowed). Lit materials get it through
 * the light; self-shaded ones like the water sample it directly. One node, so
 * one shadow map, rendered once.
 */
export const sunShadow = shadow(sunLight, sunLight.shadow);

/**
 * Filters a light's shadow with one hardware-filtered tap (the depth compare
 * samples bilinearly), not three's default five: the same edges in
 * screenshots, and about 2 ms less at 2160x1350 on an M1, since the terrain
 * and the water look both maps up at every pixel.
 */
function filterOnce(light: DirectionalLight) {
  // SAFETY: three's WebGPU ShadowNode reads shadow.filterNode before its
  // default filter (ShadowNode.js setupShadow); the types leave it out.
  const lightShadow = light.shadow as typeof light.shadow & {
    filterNode: typeof BasicShadowFilter;
  };

  lightShadow.filterNode = BasicShadowFilter;
}

filterOnce(sunLight);

/**
 * Stands in for the sun to cast the near shadow map. Never added to the
 * scene, so it lights nothing; whoever owns the casters aims and fits it.
 */
export const nearShadowLight = new DirectionalLight();

nearShadowLight.shadow.camera.layers.set(NEAR_SHADOW_LAYER);

nearShadowLight.shadow.autoUpdate = false;

// Once, empty, so it reads as lit until something fits it.
nearShadowLight.shadow.needsUpdate = true;

/** The near map's shadow factor, for lit and self-shaded materials alike. */
export const nearShadow = shadow(nearShadowLight, nearShadowLight.shadow);

filterOnce(nearShadowLight);

/**
 * The sun let through the clouds at a surface (1 clear, 0 shadowed). Under
 * an overcast deck the dimmed sun stands in for the even light through it,
 * so the shadows fade out as the deck closes.
 */
export const cloudShadowMap = createCloudShadowMap(sunDirection);

export const cloudShadow = mix(
  cloudShadowMap.sample(positionWorld),
  1,
  overcast
);

// Lit materials get all three; outside the near map's square it reads as lit.
// SAFETY: shadow() makes a float node, the light's shadow factor; it's typed
// as a ShadowNode, which TSL's operators don't take.
sunLight.shadow.shadowNode = float(sunShadow as any)
  .mul(nearShadow as any)
  .mul(cloudShadow);
