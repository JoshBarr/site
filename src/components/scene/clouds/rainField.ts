import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RGBAFormat,
} from "three/webgpu";
import { float, pow, smoothstep, texture, uniform } from "three/tsl";

// Where it's raining, from the rain gauges: each place goes by the gauges
// nearest it, blended over a few kilometres, stored as a share of the
// hardest rate anywhere. Rain falls in proportion to it, and where it's
// measurably raining the low cloud closes into a deck over it, so a shower
// over the Hutt leaves the city dry under broken cloud. Without gauges the
// share's 1 everywhere, and the forecast's rate falls wherever the clouds
// are.

/** Texels a side: half a kilometre each. */
const SIZE = 128;

/** World metres the field spans, centred on the origin: the terrain's root. */
const SPAN = 65536;

/**
 * Gauges are blended by a Gaussian this wide, m: about the spacing of the
 * city's and the Hutt's, so neighbouring buckets' tips even out, while a
 * dry gauge a few kilometres from a wet one stays dry. Unlike inverse
 * distance, places far from every gauge go by the nearest, not the mean.
 */
const BLEND = 2000;

/** Measured rain below this is dry, mm/h: a stray tip, or dew. */
const MEASURED_THRESHOLD = 0.3;

/** The deck closes from this rate to the next, mm/h. */
const DECK_FROM = 0.3;
const DECK_TO = 1.2;

const data = new Uint8Array(SIZE * SIZE * 4).fill(255);
const field = new DataTexture(data, SIZE, SIZE, RGBAFormat);

Object.assign(field, {
  wrapS: ClampToEdgeWrapping,
  wrapT: ClampToEdgeWrapping,
  magFilter: LinearFilter,
  minFilter: LinearFilter,
  needsUpdate: true,
});

export const rainField = {
  texture: field,
  /** The hardest rate in the field, mm/h. */
  hardest: uniform(0),
  /** 1 to close the low cloud over the rain, 0 without gauges or clouds. */
  deck: uniform(0),
};

/** A gauge in world x/z, and its rate in mm/h. */
export interface PlacedGauge {
  x: number;
  z: number;
  rate: number;
}

/** Extinction goes as rate^0.63 (./rain.ts), and drops' count about so. */
const SHARE_POWER = 0.63;

/**
 * Fills the field from `gauges`, or with 1 everywhere for none. Returns the
 * hardest rate anywhere in it, mm/h: 0 if that's dry, null for no gauges.
 */
export function setRainField(gauges: PlacedGauge[] | null): number | null {
  if (!gauges?.length) {
    data.fill(255);
    field.needsUpdate = true;
    rainField.hardest.value = 0;

    return null;
  }

  const rates = new Float32Array(SIZE * SIZE);
  const distances = new Float64Array(gauges.length);
  let hardest = 0;

  for (let j = 0; j < SIZE; j++) {
    const z = -SPAN / 2 + ((j + 0.5) * SPAN) / SIZE;

    for (let i = 0; i < SIZE; i++) {
      const x = -SPAN / 2 + ((i + 0.5) * SPAN) / SIZE;
      let nearest = Infinity;

      gauges.forEach((gauge, g) => {
        distances[g] = (gauge.x - x) ** 2 + (gauge.z - z) ** 2;
        nearest = Math.min(nearest, distances[g]);
      });

      // Weighed against the nearest, so far from them all, they don't all
      // underflow to nothing.
      let weights = 0;
      let sum = 0;

      gauges.forEach((gauge, g) => {
        const w = Math.exp(-(distances[g] - nearest) / (2 * BLEND * BLEND));
        weights += w;
        sum += w * gauge.rate;
      });

      const rate = sum / weights;
      rates[j * SIZE + i] = rate;
      hardest = Math.max(hardest, rate);
    }
  }

  rates.forEach((rate, k) => {
    data.fill(
      hardest > 0 ? Math.round((rate / hardest) * 255) : 0,
      k * 4,
      k * 4 + 4
    );
  });

  field.needsUpdate = true;
  rainField.hardest.value = hardest;

  return hardest < MEASURED_THRESHOLD ? 0 : hardest;
}

const uvOf = (xz) => xz.add(SPAN / 2).div(SPAN);

/** The field at xz (world): the rate there over the hardest, 0..1. */
const fraction = (xz) => texture(field, uvOf(xz)).r;

/**
 * 0..1 at xz (world): how much of the hardest rain's extinction and drops
 * there are there.
 */
export const rainShare = (xz) => pow(fraction(xz), SHARE_POWER);

/** 0..1 at xz (world): how far the low cloud closes over the rain there. */
export const rainDeck = (xz) =>
  smoothstep(
    float(DECK_FROM),
    float(DECK_TO),
    fraction(xz).mul(rainField.hardest)
  ).mul(rainField.deck);

/** The field at x, z on the CPU, as the GPU samples it: bilinear, clamped. */
function fractionAt(x: number, z: number) {
  const clamp = (v: number) => Math.min(Math.max(v, 0), SIZE - 1);
  const u = ((x + SPAN / 2) / SPAN) * SIZE - 0.5;
  const v = ((z + SPAN / 2) / SPAN) * SIZE - 0.5;
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const fu = u - i0;
  const fv = v - j0;

  const at = (i: number, j: number) =>
    data[(clamp(j) * SIZE + clamp(i)) * 4] / 255;

  const top = at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu;
  const bottom = at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu;

  return top * (1 - fv) + bottom * fv;
}

function smoothstepTo(from: number, to: number, x: number) {
  const t = Math.min(Math.max((x - from) / (to - from), 0), 1);

  return t * t * (3 - 2 * t);
}

/** rainShare and rainDeck, worked out on the CPU at one point. */
export function rainAt(x: number, z: number) {
  const f = fractionAt(x, z);

  return {
    share: f ** SHARE_POWER,
    deck:
      smoothstepTo(DECK_FROM, DECK_TO, f * rainField.hardest.value) *
      rainField.deck.value,
  };
}
