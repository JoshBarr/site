import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RGBAFormat,
} from "three/webgpu";
import { float, pow, smoothstep, texture, uniform } from "three/tsl";
import { RADAR_SIZE, RADAR_SPAN } from "../../../lib/radarGrid";

// Where it's raining, from the rain radar and the rain gauges, stored as a
// share of the hardest rate anywhere. Rain falls in proportion to it, and
// where it's measurably raining the low cloud closes into a deck over it,
// so a shower over the Hutt leaves the city dry under broken cloud.
//
// The radar says where: its newest scan, carried on downwind by how far its
// showers moved between the last two, since it's ten minutes or more old by
// the time it's seen. The gauges say how hard: the radar's rates are scaled
// to agree with them overall, and near each gauge what it measured over and
// above (or under) what the radar saw there in the same half hour is added
// back, so a gauge in rain the radar's beam passes over still rains, and
// an echo over a dry gauge doesn't. Away from the gauges, out at sea, it's
// the radar's alone.
//
// With only gauges, each place goes by those nearest it, blended over a few
// kilometres. With neither, the share's 1 everywhere, and the forecast's
// rate falls wherever the clouds are.

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

/**
 * With the radar, what a gauge adds reaches this far, m (a Gaussian's
 * width): twice the blend, past which the radar knows better than a bucket
 * a valley away.
 */
const REACH = 4000;

/** A gauge whose weight is under e to minus this is left out of a blend. */
const NEGLIGIBLE = 20;

/** Measured rain below this is dry, mm/h: a stray tip, or dew. */
const MEASURED_THRESHOLD = 0.3;

/** The deck closes from this rate to the next, mm/h. */
const DECK_FROM = 0.3;
const DECK_TO = 1.2;

/**
 * The radar's rates are scaled to the gauges' when both have caught this
 * much between them, mm/h summed over the gauges, at three or more: with
 * less, the ratio's noise. By no more than BIAS_MOST either way: a radar's
 * rain is within a few times the truth, or it isn't rain.
 */
const BIAS_FROM = 2;
const BIAS_MOST = 3;

/** A scan older than this is no use, ms: the gauges alone do better. */
const RADAR_STALE = 40 * 60_000;

/** A scan's carried on by no more than this long of its showers' drift, ms. */
const AHEAD = 25 * 60_000;

/** A new scan's faded to over this long, ms: the last one's guess was close. */
const FADE = 20_000;

/** The field's redrawn when its showers have drifted this far, m: a quarter texel. */
const NUDGE = SPAN / SIZE / 4;

/**
 * The share's worked out again when the hardest rate's fallen to this much
 * of what it was, or risen: between, the texture's as good as it was.
 */
const HOLD = 0.7;

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

/** A radar scan: when, and each cell's rate (lib/radarGrid.ts), mm/h. */
export interface RadarRates {
  time: number;
  rates: Float32Array;
}

/** The radar's scans, oldest first, and the moment the field's for. */
export interface RadarSeen {
  scans: RadarRates[];
  /** The scene's time, epoch ms. */
  now: number;
  /**
   * How showers drift when the scans can't say, m/s (x east, z south): the
   * wind aloft.
   */
  drift?: [number, number];
}

/** Extinction goes as rate^0.63 (./rain.ts), and drops' count about so. */
const SHARE_POWER = 0.63;

/** Each texel's rate as it's shown, mm/h. */
const shown = new Float32Array(SIZE * SIZE);

/**
 * What the gauges say of each texel, mm/h: its rate, or with the radar,
 * what to add to the radar's.
 */
const gauged = new Float32Array(SIZE * SIZE);

/** The scan the field's drawn from, if any, and how it's read. */
let scan: {
  time: number;
  rates: Float32Array;
  /** The radar's rates times this agree with the gauges'. */
  bias: number;
  /** How its showers drift, m/s. */
  velocity: [number, number];
} | null = null;

/** How far the scan was carried when the field was last drawn, m. */
let carried: [number, number] = [0, 0];

/** The field before the newest scan came, fading out from then (wall ms). */
let fading: { from: Float32Array; since: number } | null = null;

/** The rate the texture's shares are of, mm/h. */
let scale = 0;

/** What the field last came to: see setRainField. */
let hardest: number | null = null;

/** A scan's rate at x, z (world), mm/h: bilinear, dry past its edges. */
function radarAt(rates: Float32Array, x: number, z: number) {
  const u = ((x + RADAR_SPAN / 2) / RADAR_SPAN) * RADAR_SIZE - 0.5;
  const v = ((z + RADAR_SPAN / 2) / RADAR_SPAN) * RADAR_SIZE - 0.5;
  const i = Math.floor(u);
  const j = Math.floor(v);

  if (i < -1 || j < -1 || i >= RADAR_SIZE || j >= RADAR_SIZE) return 0;

  const fu = u - i;
  const fv = v - j;
  const left = i >= 0;
  const right = i + 1 < RADAR_SIZE;
  const at = j * RADAR_SIZE + i;
  let top = 0;
  let bottom = 0;

  if (j >= 0) {
    top = (left ? rates[at] * (1 - fu) : 0) + (right ? rates[at + 1] * fu : 0);
  }

  if (j + 1 < RADAR_SIZE) {
    bottom =
      (left ? rates[at + RADAR_SIZE] * (1 - fu) : 0) +
      (right ? rates[at + RADAR_SIZE + 1] * fu : 0);
  }

  return top * (1 - fv) + bottom * fv;
}

/** The scans are matched at half their size: 2 km a cell. */
const COARSE = RADAR_SIZE / 2;

/**
 * Showers are looked for this many coarse cells either way: 16 km in a
 * frame's ten minutes, a hundred kilometres an hour.
 */
const SEARCH = 8;

/** Fewer coarse cells of rain than this in a scan, and there's nothing to follow. */
const WET_CELLS = 12;

/** The scans must be this alike at their best fit (0..1), or it's no fit. */
const ALIKE = 0.5;

/** Showers faster than this aren't believed, m/s. */
const FASTEST = 35;

/** A scan at half size, by the root of its rate, so cores don't drown the rest. */
function coarse(rates: Float32Array) {
  const out = new Float32Array(COARSE * COARSE);

  for (let j = 0; j < COARSE; j++) {
    for (let i = 0; i < COARSE; i++) {
      const at = j * 2 * RADAR_SIZE + i * 2;

      const mean =
        (rates[at] +
          rates[at + 1] +
          rates[at + RADAR_SIZE] +
          rates[at + RADAR_SIZE + 1]) /
        4;

      out[j * COARSE + i] = mean >= MEASURED_THRESHOLD ? Math.sqrt(mean) : 0;
    }
  }

  return out;
}

/**
 * How far the rain moved from one scan to the next, m (x east, z south):
 * the shift at which they're most alike, to a fraction of a cell. Null if
 * either has too little rain to tell, or they're not alike anywhere.
 */
export function radarMotion(
  before: Float32Array,
  after: Float32Array
): [number, number] | null {
  const a = coarse(before);
  const b = coarse(after);

  // Only the first's wet cells count toward a fit.
  const wet: number[] = [];

  a.forEach((value, k) => {
    if (value > 0) wet.push(k);
  });

  if (
    wet.length < WET_CELLS ||
    b.filter((value) => value > 0).length < WET_CELLS
  ) {
    return null;
  }

  // The second's squares summed from the corner, for any rectangle's sum.
  const stride = COARSE + 1;
  const summed = new Float64Array(stride * stride);

  for (let j = 0; j < COARSE; j++) {
    for (let i = 0; i < COARSE; i++) {
      summed[(j + 1) * stride + i + 1] =
        b[j * COARSE + i] ** 2 +
        summed[j * stride + i + 1] +
        summed[(j + 1) * stride + i] -
        summed[j * stride + i];
    }
  }

  const span = 2 * SEARCH + 1;
  const scores = new Float32Array(span * span);
  let best = -1;

  // As alike, the shorter move's the likelier.
  const fit = (k: number) =>
    scores[k] -
    1e-3 * Math.hypot((k % span) - SEARCH, Math.floor(k / span) - SEARCH);

  for (let dz = -SEARCH; dz <= SEARCH; dz++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      let dot = 0;
      let own = 0;

      for (const k of wet) {
        const i = (k % COARSE) + dx;
        const j = Math.floor(k / COARSE) + dz;

        if (i < 0 || j < 0 || i >= COARSE || j >= COARSE) continue;
        dot += a[k] * b[j * COARSE + i];
        own += a[k] * a[k];
      }

      // The second's, where the first shifted lies over it.
      const i0 = Math.max(dx, 0);
      const i1 = Math.min(COARSE + dx, COARSE);
      const j0 = Math.max(dz, 0);
      const j1 = Math.min(COARSE + dz, COARSE);

      const others =
        summed[j1 * stride + i1] -
        summed[j0 * stride + i1] -
        summed[j1 * stride + i0] +
        summed[j0 * stride + i0];

      const at = (dz + SEARCH) * span + dx + SEARCH;

      scores[at] = own > 0 && others > 0 ? dot / Math.sqrt(own * others) : 0;

      if (best < 0 || fit(at) > fit(best)) best = at;
    }
  }

  if (scores[best] < ALIKE) return null;

  const bx = (best % span) - SEARCH;
  const bz = Math.floor(best / span) - SEARCH;

  /** Where between cells a parabola through three scores peaks, ±0.5. */
  const peak = (low: number, mid: number, high: number) => {
    const curve = low - 2 * mid + high;

    return curve < 0
      ? Math.min(Math.max((0.5 * (low - high)) / curve, -0.5), 0.5)
      : 0;
  };

  const fx =
    Math.abs(bx) < SEARCH
      ? peak(scores[best - 1], scores[best], scores[best + 1])
      : 0;

  const fz =
    Math.abs(bz) < SEARCH
      ? peak(scores[best - span], scores[best], scores[best + span])
      : 0;

  const cell = RADAR_SPAN / COARSE;

  return [(bx + fx) * cell, (bz + fz) * cell];
}

/** How the newest scan's showers drift, m/s, by the one before it. */
function velocityOf(scans: RadarRates[], drift: [number, number]) {
  const [before, after] = scans.slice(-2);

  if (!after) return drift;

  const seconds = (after.time - before.time) / 1000;

  // Scans a frame or two apart: further, and the showers aren't the same.
  if (seconds < 240 || seconds > 1500) return drift;

  const moved = radarMotion(before.rates, after.rates);

  if (!moved) return drift;

  const velocity: [number, number] = [moved[0] / seconds, moved[1] / seconds];

  return Math.hypot(...velocity) <= FASTEST ? velocity : drift;
}

function smoothstepTo(from: number, to: number, x: number) {
  const t = Math.min(Math.max((x - from) / (to - from), 0), 1);

  return t * t * (3 - 2 * t);
}

/**
 * Draws the field for `now` (scene ms; `wall` for the fade), and says how
 * hard its hardest rain is: 0 if that's dry. `fresh` when what it's drawn
 * from is new, and its shares are of the hardest whatever that was.
 */
function draw(now: number, wall: number, fresh: boolean) {
  let dx = 0;
  let dz = 0;

  if (scan) {
    const ahead = Math.min(Math.max(now - scan.time, 0), AHEAD) / 1000;

    dx = scan.velocity[0] * ahead;
    dz = scan.velocity[1] * ahead;
  }

  let faded = 1;

  if (fading) {
    faded = smoothstepTo(0, FADE, wall - fading.since);

    if (faded >= 1) fading = null;
  }

  let most = 0;

  for (let j = 0; j < SIZE; j++) {
    const z = -SPAN / 2 + ((j + 0.5) * SPAN) / SIZE;

    for (let i = 0; i < SIZE; i++) {
      const k = j * SIZE + i;
      let rate = gauged[k];

      if (scan) {
        const x = -SPAN / 2 + ((i + 0.5) * SPAN) / SIZE;

        rate = Math.max(
          rate + scan.bias * radarAt(scan.rates, x - dx, z - dz),
          0
        );
      }

      if (fading) rate = fading.from[k] + (rate - fading.from[k]) * faded;
      shown[k] = rate;
      most = Math.max(most, rate);
    }
  }

  if (fresh || most > scale || most < scale * HOLD) scale = most;

  for (let k = 0; k < shown.length; k++) {
    data.fill(
      scale > 0 ? Math.round(Math.min(shown[k] / scale, 1) * 255) : 0,
      k * 4,
      k * 4 + 4
    );
  }

  field.needsUpdate = true;
  rainField.hardest.value = scale;
  carried = [dx, dz];
  hardest = scale < MEASURED_THRESHOLD ? 0 : scale;

  return hardest;
}

/**
 * Fills the field from `gauges` and what the `radar`'s seen, either or
 * both, or with 1 everywhere for neither. Returns the hardest rate anywhere
 * in it, mm/h: 0 if that's dry, null for neither. `wall` is the clock a new
 * scan's faded in by, ms.
 */
export function setRainField(
  gauges: PlacedGauge[] | null,
  radar: RadarSeen | null = null,
  wall = performance.now()
): number | null {
  const newest = radar?.scans.at(-1);

  // The radar's scans and its newest, if that's new enough to go by.
  const seen =
    radar && newest && radar.now - newest.time < RADAR_STALE
      ? { ...radar, newest }
      : null;

  if (!gauges?.length && !seen) {
    data.fill(255);
    field.needsUpdate = true;
    rainField.hardest.value = 0;
    scan = null;
    fading = null;
    scale = 0;
    hardest = null;

    return null;
  }

  const measured = gauges ?? [];

  /** What's blended from each gauge: its rate, or what to add to the radar's. */
  let values = measured.map(({ rate }) => rate);

  if (seen) {
    // A newer scan's faded to from the field as it was.
    if (scan && scan.time !== seen.newest.time) {
      fading = { from: shown.slice(), since: wall };
    }

    // What the radar saw at each gauge over the half hour its rate's over.
    const echoes = measured.map(
      ({ x, z }) =>
        seen.scans.reduce((sum, { rates }) => sum + radarAt(rates, x, z), 0) /
        seen.scans.length
    );

    const caught = values.reduce((sum, rate) => sum + rate, 0);
    const echoed = echoes.reduce((sum, rate) => sum + rate, 0);

    const bias =
      measured.length >= 3 && caught >= BIAS_FROM && echoed >= BIAS_FROM
        ? Math.min(Math.max(caught / echoed, 1 / BIAS_MOST), BIAS_MOST)
        : 1;

    values = values.map((rate, g) => rate - bias * echoes[g]);

    scan = {
      time: seen.newest.time,
      rates: seen.newest.rates,
      bias,
      // A dry scan has nothing to carry on, or to draw again for.
      velocity: seen.newest.rates.some((rate) => rate > 0)
        ? velocityOf(seen.scans, seen.drift ?? [0, 0])
        : [0, 0],
    };
  } else {
    scan = null;
    fading = null;
  }

  if (!measured.length) gauged.fill(0);
  else {
    const count = measured.length;
    const xs = Float64Array.from(measured, ({ x }) => x);
    const zs = Float64Array.from(measured, ({ z }) => z);
    const distances = new Float64Array(count);

    for (let j = 0; j < SIZE; j++) {
      const z = -SPAN / 2 + ((j + 0.5) * SPAN) / SIZE;

      for (let i = 0; i < SIZE; i++) {
        const x = -SPAN / 2 + ((i + 0.5) * SPAN) / SIZE;
        let nearest = Infinity;

        for (let g = 0; g < count; g++) {
          const d = (xs[g] - x) ** 2 + (zs[g] - z) ** 2;

          distances[g] = d;

          if (d < nearest) nearest = d;
        }

        // Weighed against the nearest, so far from them all, they don't all
        // underflow to nothing.
        let weights = 0;
        let sum = 0;

        for (let g = 0; g < count; g++) {
          const beyond = (distances[g] - nearest) / (2 * BLEND * BLEND);

          // Past a few widths further off than the nearest, a gauge weighs
          // nothing: most of them, most places.
          if (beyond > NEGLIGIBLE) continue;

          const w = Math.exp(-beyond);

          weights += w;
          sum += w * values[g];
        }

        // With the radar, the gauges only speak for the ground near them.
        gauged[j * SIZE + i] =
          (sum / weights) *
          (seen ? Math.exp(-nearest / (2 * REACH * REACH)) : 1);
      }
    }
  }

  return draw(radar?.now ?? 0, wall, true);
}

/**
 * Carries the radar's showers on to `now` (the scene's time, epoch ms), if
 * they've drifted far enough to see, or a new scan's still fading in.
 * Returns the hardest rate, as setRainField does.
 */
export function stepRainField(now: number, wall = performance.now()) {
  if (!scan) return hardest;

  const ahead = Math.min(Math.max(now - scan.time, 0), AHEAD) / 1000;

  const drifted = Math.hypot(
    scan.velocity[0] * ahead - carried[0],
    scan.velocity[1] * ahead - carried[1]
  );

  return fading || drifted >= NUDGE ? draw(now, wall, false) : hardest;
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
