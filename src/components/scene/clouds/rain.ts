import { DataTexture, Vector2, Vector3 } from "three/webgpu";
import { float, max, mix, smoothstep, uniform } from "three/tsl";
import { overcast } from "../environment";
import { Conditions, windVector } from "../weather";
import type { CloudLayerUniforms } from "./density";
import {
  coverageMap,
  coverageMapAt,
  LOW_ANGLE,
  sampleStepped,
} from "./coverage";
import { rainAt, rainDeck, rainShare } from "./rainField";

// Rain falls from the low cloud: from the thick of each cloud, and from all
// of an overcast deck, blowing downwind as it falls. Seen far off it's grey
// shafts (in the cloud march), and up close, streaks (see drops).

export function createRainUniforms() {
  return {
    /** Extinction per metre where it's falling hardest. 0 when it isn't. */
    extinction: uniform(0),
    /** Fall speed of a typical drop, m/s. */
    fall: uniform(5),
    /** Wind the drops fall through, m/s (x east, z south). */
    wind: uniform(new Vector2()),
  };
}

export type RainUniforms = ReturnType<typeof createRainUniforms>;

/**
 * Median-volume drop diameter for a rain rate in mm/h, mm. Marshall–Palmer:
 * D0 = 3.67 / Λ, with Λ = 4.1 R^-0.21 per mm.
 */
function dropDiameter(rate: number) {
  return 0.895 * Math.pow(Math.max(rate, 0.01), 0.21);
}

/** Terminal fall speed of a drop that size, m/s (Atlas et al., 1973). */
function fallSpeed(diameter: number) {
  return Math.max(9.65 - 10.3 * Math.exp(-0.6 * diameter), 0.5);
}

/**
 * Extinction through rain of a rate in mm/h, per metre: about 0.25 R^0.63
 * per km, so 5 mm/h cuts visibility to about 6 km.
 */
function rainExtinction(rate: number) {
  return rate > 0 ? 2.5e-4 * Math.pow(rate, 0.63) : 0;
}

/** How much of the drop budget a rate draws: drizzle is sparse, a downpour all of it. */
export function dropFraction(rate: number) {
  return rate > 0 ? 1 - Math.exp(-rate / 4) : 0;
}

export function applyRain(conditions: Conditions, rain: RainUniforms) {
  const rate = Math.max(conditions.precipitation, 0);
  rain.extinction.value = rainExtinction(rate);
  rain.fall.value = fallSpeed(dropDiameter(rate));
  const [x, z] = windVector(conditions.wind.speed, conditions.wind.direction);
  rain.wind.value.set(x, z);
}

/**
 * Rain thickens over this far below the cloud base, so shafts don't begin at
 * a line, nor fill the view when it's skimming along the base, m.
 */
const FADE_IN = 300;

/** The coverage map again, this small, for streaks within a shaft, m. */
const STREAK_SCALE = 1800;

/**
 * How hard it's raining at p, 0..1 of the rate. Traced back along the drops'
 * slant to the low cloud's base: it rains from the middle of each cloud
 * region, not its ragged edges, and everywhere under an overcast deck or
 * the deck the gauges close over the rain (./rainField.ts), as hard as
 * they measured it there. Some clouds rain harder than others, and
 * unevenly, which the slant draws out into streaks. In a march, `step` is
 * how far apart its samples are, m (see coverageMap).
 */
export function rainfall(
  weather: DataTexture,
  low: CloudLayerUniforms,
  rain: RainUniforms,
  p,
  step: any = null
) {
  const base = low.shape.x;
  const fallen = max(base.sub(p.y), 0);
  const source = p.xz.sub(rain.wind.div(rain.fall).mul(fallen));

  const { broad, map } = coverageMap(
    weather,
    source,
    low.offset,
    LOW_ANGLE,
    step
  );

  const threshold = float(1).sub(low.shape.z);
  const raining = smoothstep(threshold, threshold.add(0.15), map);

  const streaks = sampleStepped(
    weather,
    source.add(low.offset),
    STREAK_SCALE,
    step
  ).r;

  return max(raining, overcast, rainDeck(source))
    .mul(rainShare(source))
    .mul(mix(0.5, 1, broad.g))
    .mul(mix(0.35, 1.3, streaks))
    .mul(smoothstep(base.add(50), base.sub(FADE_IN), p.y));
}

function smoothstepTo(from: number, to: number, x: number) {
  const t = Math.min(Math.max((x - from) / (to - from), 0), 1);

  return t * t * (3 - 2 * t);
}

/**
 * rainfall, worked out on the CPU at one point, less the streaks within a
 * shaft: how hard it's raining on the camera.
 */
export function rainfallAt(
  weather: DataTexture,
  low: CloudLayerUniforms,
  rain: RainUniforms,
  p: Vector3
) {
  const base = low.shape.value.x;
  const fallen = Math.max(base - p.y, 0);
  const slant = fallen / rain.fall.value;
  const x = p.x - rain.wind.value.x * slant;
  const z = p.z - rain.wind.value.y * slant;

  const { broad, map } = coverageMapAt(
    weather,
    x,
    z,
    low.offset.value,
    LOW_ANGLE
  );

  const threshold = 1 - low.shape.value.z;
  const raining = smoothstepTo(threshold, threshold + 0.15, map);
  const { share, deck } = rainAt(x, z);

  return (
    Math.max(raining, overcast.value, deck) *
    share *
    (0.5 + 0.5 * broad.g) *
    smoothstepTo(base + 50, base - FADE_IN, p.y)
  );
}
