import {
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
  Vector3,
} from "three/webgpu";
import {
  exp,
  float,
  Fn,
  If,
  max,
  min,
  normalize,
  texture,
  uniform,
  varying,
  vec3,
} from "three/tsl";
import { switchedOff } from "./stats";
import { hazeDensity, hazeHeight, hazeTransmittance } from "./haze";
import {
  WINDOW_BRIGHTNESS,
  WINDOW_GLOW,
  windowLights,
  windowsLit,
} from "./buildings/material";

// Skyglow: the city's light thrown up into the haze over it, and onto the
// undersides of cloud. It comes from a coarse map of where the lit windows
// are, so it's there whatever the building tiles have loaded.

/** Light lands this far around where it's given out (Gaussian sigma), m. */
const SPREAD = 700;

/** It thins out above the city over this height, m. */
const REACH = 2000;

/**
 * Of the light given out per m² of ground, the haze sends this much back
 * toward the eye; streets and car parks add their share to the windows'.
 */
const HAZE_GLOW = 0.24;

/** And the cloud base, which is far whiter and denser. */
const CLOUD_GLOW = 0.4;

/** Wellington's street lights are LED now: a near-white, slightly cool glow. */
const COLOUR = vec3(0.92, 0.95, 1);

/** Samples along a ray, and the furthest they go, m. */
const STEPS = 5;
const MAX_DISTANCE = 20000;

/** Map cells across the terrain root: the finest building tiles'. */
const CELLS = 128;

const pixels = new Uint8Array(CELLS * CELLS);

const map = new DataTexture(pixels, CELLS, CELLS, RedFormat, UnsignedByteType);

map.magFilter = LinearFilter;

map.minFilter = LinearFilter;

map.needsUpdate = true;

const mapNode = texture(map);

/** World size of the map, which covers the terrain root, centred. */
const mapSize = uniform(1);

/** Windowed wall per m² of ground where the map reads 1. */
const mapPeak = uniform(0);

/**
 * Fills the map from building tiles' windowed wall: tiles are on a grid
 * `grid` across `size` metres, by column and row.
 */
export function setCityLights(
  size: number,
  grid: number,
  tiles: { x: number; y: number; windowWall: number }[]
) {
  const cell = size / CELLS;
  const density = new Float32Array(CELLS * CELLS);

  for (const { x, y, windowWall } of tiles) {
    const cx = Math.floor((x * CELLS) / grid);
    const cy = Math.floor((y * CELLS) / grid);
    // Spread evenly over the cells a coarser tile covers.
    const span = Math.max(CELLS / grid, 1);

    for (let j = 0; j < span; j++) {
      for (let i = 0; i < span; i++) {
        density[(cy + j) * CELLS + cx + i] +=
          windowWall / (span * span * cell * cell);
      }
    }
  }

  const blurred = blur(density, CELLS, SPREAD / cell);
  const peak = blurred.reduce((a, b) => Math.max(a, b), 1e-6);

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.round((blurred[i] / peak) * 255);
  }

  map.needsUpdate = true;
  mapSize.value = size;
  mapPeak.value = peak;
}

/** Separable Gaussian blur of a square grid. */
function blur(grid: Float32Array, cells: number, sigma: number) {
  const radius = Math.ceil(sigma * 3);

  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma))
  );

  const total = kernel.reduce((a, b) => a + b);

  const pass = (from: Float32Array, horizontal: boolean) => {
    const to = new Float32Array(from.length);

    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        let sum = 0;

        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? x + k : x;
          const sy = horizontal ? y : y + k;

          if (sx < 0 || sy < 0 || sx >= cells || sy >= cells) continue;
          sum += from[sy * cells + sx] * kernel[k + radius];
        }

        to[y * cells + x] = sum / total;
      }
    }

    return to;
  };

  return pass(pass(grid, true), false);
}

/**
 * A ground under its floodlights (events/Stadium.tsx): world x and z, and
 * how bright against the city at its brightest, with every window lit.
 */
export const floodlitGround = uniform(new Vector3());

/** Its light lands this far around it (Gaussian sigma), m. */
const FLOODLIT_SPREAD = 250;

/** The city's light reaching world point p from below, per m², as a grey. */
export function cityLightAt(p) {
  const uv = p.xz.div(mapSize).add(0.5);
  const fromGround = p.xz.sub(floodlitGround.xy);

  const floodlit = floodlitGround.z.mul(
    exp(fromGround.dot(fromGround).div(-2 * FLOODLIT_SPREAD * FLOODLIT_SPREAD))
  );

  return mapNode
    .sample(uv)
    .r.mul(windowsLit)
    .add(floodlit)
    .mul(mapPeak)
    .mul(windowLights)
    .mul(WINDOW_GLOW * WINDOW_BRIGHTNESS)
    .mul(exp(max(p.y, 0).div(-REACH)));
}

/** The same, in its colour. */
const cityLight = (p) => COLOUR.mul(cityLightAt(p));

/**
 * 1 while the haze's glow comes from the haze volume (hazeVolume.ts), which
 * sums the city's light along each of its rays and hands it to the frame as
 * it's put together: surfaces then leave it out of their fog.
 */
export const glowInAir = uniform(0);

/**
 * The haze's glow from the volume's sum along a pixel's ray: the city's
 * light at each stretch of haze, by the share of the frame's light that
 * stretch scatters in.
 */
export const airGlow = (sum) => COLOUR.mul(sum).mul(HAZE_GLOW);

/** What the city's light adds to a cloud at p, lit from below. */
function cloudGlow(p) {
  return cityLight(p).mul(CLOUD_GLOW);
}

/**
 * The haze's glow from the city along a ray, averaged over the haze it
 * passes through: in-scattering to add to the fog's colour, as it's mixed in
 * by the fog's amount.
 */
function hazeGlow(from, to) {
  const ray = to.sub(from);
  const length = min(ray.length(), MAX_DISTANCE);
  const direction = normalize(ray);
  let sum: any = vec3(0);
  let weights: any = float(1e-12);

  for (let i = 0; i < STEPS; i++) {
    const p = from.add(direction.mul(length.mul((i + 0.5) / STEPS)));

    const weight = hazeDensity
      .mul(exp(max(p.y, 0).div(hazeHeight).negate()))
      .mul(hazeTransmittance(from, p));

    sum = sum.add(cityLight(p).mul(weight));
    weights = weights.add(weight);
  }

  return sum.div(weights).mul(HAZE_GLOW);
}

/**
 * `glow()` while the lights are on, else black. Branching on them, rather
 * than adding the glow only at night, means dusk recompiles nothing, and by
 * day the glow costs nothing.
 */
function whileLit(glow: () => any) {
  return Fn(() => {
    const lit = vec3(0).toVar();

    If(windowLights.greaterThan(0), () => {
      lit.assign(glow());
    });

    return lit;
  })();
}

/**
 * hazeGlow, skipped while the lights are off. For what's on screen, `seen`
 * says what: a mesh's own surface (in its fog), or the sky behind them all,
 * which three draws over the whole frame first. Five steps through the haze
 * at every pixel of both was the night's largest cost, some 3 ms of the
 * overview's frame on an M1. So where there's a haze volume it's left to
 * that (glowInAir), and otherwise a surface's is worked out at each vertex
 * and spread across the triangle, the glow being a few hundred metres soft.
 * The sea's mirror is drawn from under the sea, where the volume doesn't
 * look: there it's as without one. (?off=airglow for no volume,
 * ?off=vertexglow for surfaces by the pixel.)
 */
export function hazeGlowAtNight(from, to, seen?: "surface" | "sky") {
  const glow = () => hazeGlow(from, to);

  if (!seen || (seen === "sky" && switchedOff("airsky"))) return whileLit(glow);

  const lit = Fn(() => {
    const lit = vec3(0).toVar();

    If(
      windowLights
        .greaterThan(0)
        .and(glowInAir.lessThan(0.5).or(from.y.lessThan(0))),
      () => {
        lit.assign(glow());
      }
    );

    return lit;
  })();

  return seen === "sky" || switchedOff("vertexglow") ? lit : varying(lit);
}

/** cloudGlow, skipped while the lights are off. */
export const cloudGlowAtNight = (p) => whileLit(() => cloudGlow(p));
