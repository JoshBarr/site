// Initial ocean spectrum for the FFT simulation (Tessendorf 2001), using a
// JONSWAP energy spectrum with Mitsuyasu directional spreading. Computed on
// the CPU whenever conditions change; the GPU only animates it.
//
// The longest cascade holds two seas in one: the open sea, as the wave buoy
// off Baring Head measures it (or as the wind over a long fetch would raise
// it, when the buoy's not heard from), and under it the sea the wind makes
// of a harbour's few kilometres. What's built is the taller of the two,
// wave by wave; `open` says how much of it is the open sea's alone, which
// the surface scales back where the land's in the way (./shelter.ts).

const G = 9.81;

/** A sea's waves in open water. */
export interface Sea {
  /** Significant height, m. */
  height: number;
  /** Period of the dominant waves, s. */
  period: number;
  /** Degrees clockwise from north: where they come from. */
  direction: number;
}

export interface OceanConditions {
  /** Metres per second at 10m. */
  windSpeed: number;
  /** Degrees, meteorological: the direction the wind blows from. */
  windDirection: number;
  /** Metres of open water upwind. */
  fetch: number;
  /** 0..1: narrows spreading toward long-travelled, aligned swell. */
  swell: number;
  /**
   * The open sea as it's measured. Left out, it's the wind's over `fetch`.
   */
  sea?: Sea | null;
}

/**
 * The longest stretch of water the wind has to itself inside the harbour,
 * m: Petone to the entrance. Its sea is what's left where the open sea's
 * shut out.
 */
const HARBOUR_FETCH = 12_000;

/**
 * The periods a measured sea's drawn with, s. Shorter, and its waves are
 * the finer cascades', which the wind already fills; longer, and fewer
 * than two of them fit the longest cascade's patch.
 */
const SHORTEST = 3.6;
const LONGEST = 14;

/**
 * A sea's height over its wavelength: a wind sea still being raised is
 * this steep or more, swell that's run from far off this or less.
 */
const WIND_SEA = 0.03;
const SWELL = 0.012;

/** JONSWAP's peak for a wind sea, and how much sharper swell's is. */
const PEAKED = 3.3;
const SWELL_PEAKED = 7;

/** `swell` for swell itself: its crests long and all one way. */
const SWELL_NARROW = 1.4;

/** Wellington's prevailing northerly, moderate. */
export const DEFAULT_CONDITIONS: OceanConditions = {
  windSpeed: 7,
  windDirection: 340,
  fetch: 60000,
  swell: 0.3,
};

export interface Cascade {
  /** Patch size in metres. */
  size: number;
  /** Wavenumber band this cascade owns, so cascades don't double up. */
  kMin: number;
  kMax: number;
}

/** Patch sizes chosen so the tiles don't line up with each other. */
export function createCascades(sizes: number[]): Cascade[] {
  // Each cascade hands off to the next a few wavelengths above its own
  // fundamental, where the smaller patch resolves those waves well.
  const boundaries = sizes.map((size) => ((2 * Math.PI) / size) * 6);

  return sizes.map((size, i) => ({
    size,
    kMin: i === 0 ? 0 : boundaries[i],
    kMax: i === sizes.length - 1 ? Infinity : boundaries[i + 1],
  }));
}

/** The spectrum's peak angular frequency, rad/s. */
function peakOmega(windSpeed: number, fetch: number) {
  return 22 * Math.pow((G * G) / (windSpeed * fetch), 1 / 3);
}

/** Period of the dominant waves, seconds. */
export function peakPeriod({ windSpeed, fetch }: OceanConditions) {
  return (2 * Math.PI) / peakOmega(Math.max(windSpeed, 0.5), fetch);
}

/**
 * Significant wave height, metres: fetch-limited JONSWAP growth, no more than
 * a fully developed sea.
 */
export function significantHeight({ windSpeed, fetch }: OceanConditions) {
  const u = Math.max(windSpeed, 0.5);

  return Math.min(0.0016 * u * Math.sqrt(fetch / G), (0.21 * u * u) / G);
}

/**
 * The camera's headroom over the sea, m: the open sea's significant height,
 * measured if it is, or else the wind's.
 */
export function openHeight(conditions: OceanConditions) {
  return conditions.sea
    ? Math.max(
        conditions.sea.height,
        significantHeight({ ...conditions, fetch: HARBOUR_FETCH })
      )
    : significantHeight(conditions);
}

/** JONSWAP's shape about `peak`, without its scale. */
function peaked(omega: number, peak: number, sharpness: number) {
  const sigma = omega <= peak ? 0.07 : 0.09;

  const r = Math.exp(
    -((omega - peak) ** 2) / (2 * sigma * sigma * peak * peak)
  );

  return (
    (1 / omega ** 5) *
    Math.exp(-1.25 * (peak / omega) ** 4) *
    Math.pow(sharpness, r)
  );
}

function jonswap(omega: number, windSpeed: number, fetch: number) {
  const alpha = 0.076 * Math.pow((windSpeed * windSpeed) / (fetch * G), 0.22);

  return alpha * G * G * peaked(omega, peakOmega(windSpeed, fetch), PEAKED);
}

const smoothstep = (from: number, to: number, x: number) => {
  const t = Math.min(Math.max((x - from) / (to - from), 0), 1);

  return t * t * (3 - 2 * t);
};

/**
 * How a measured sea's drawn: its peak, how sharp that is and how narrowly
 * its waves keep to their direction, by how far it's come (0 a wind sea, 1
 * swell), which its steepness tells.
 */
function seaShape(sea: Sea, swell: number) {
  const period = Math.min(Math.max(sea.period, SHORTEST), LONGEST);
  const length = (G * period * period) / (2 * Math.PI);
  const travelled = 1 - smoothstep(SWELL, WIND_SEA, sea.height / length);

  return {
    period,
    peak: (2 * Math.PI) / period,
    sharpness: PEAKED + (SWELL_PEAKED - PEAKED) * travelled,
    narrow: swell + (SWELL_NARROW - swell) * travelled,
  };
}

/** Where waves from `direction` (degrees) head, as an angle in the xz plane. */
function heading(direction: number) {
  // Bearing clockwise from north; north is -z.
  const bearing = ((direction + 180) * Math.PI) / 180;

  return Math.atan2(-Math.cos(bearing), Math.sin(bearing));
}

/** Normalisation for cos^2s(θ/2) spreading, as a polynomial fit. */
function spreadNormalisation(s: number) {
  if (s < 5) {
    return (
      -0.000564 * s ** 4 + 0.00776 * s ** 3 - 0.044 * s ** 2 + 0.192 * s + 0.163
    );
  }

  return (
    -4.8e-8 * s ** 4 +
    1.07e-5 * s ** 3 -
    9.53e-4 * s ** 2 +
    5.9e-2 * s +
    3.93e-1
  );
}

function spreading(theta: number, omega: number, peak: number, swell: number) {
  let s =
    omega > peak
      ? 9.77 * Math.pow(Math.abs(omega / peak), -2.5)
      : 6.97 * Math.pow(Math.abs(omega / peak), 5);

  s += 16 * Math.tanh(Math.min(peak / omega, 20)) * swell * swell;

  return (
    spreadNormalisation(s) * Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s)
  );
}

/** Seeded so the sea doesn't reshuffle when the wind changes. */
function gaussianRandom(seed: number) {
  let state = seed >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return () => {
    const u = Math.max(next(), 1e-12);
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));

    return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
  };
}

export interface Spectrum {
  /** Per sample: h0(k).re, h0(k).im, conj(h0(-k)).re, conj(h0(-k)).im */
  h0: Float32Array;
  /** Per sample: kx, kz, ω, 1/|k| */
  waves: Float32Array;
  /**
   * 0..1: how much of the longest cascade's energy is the open sea's alone,
   * over the harbour's own. Where the open sea's shut out, that much goes.
   */
  open: number;
  /** Degrees: where the open sea comes from. */
  from: number;
  /** The open sea's dominant wavelength, m. */
  length: number;
  /**
   * Per cascade, how far its surface's spread or squeeze (the jacobian,
   * less 1) strays, as a standard deviation: the same as its slope's, as
   * the choppiness stands at 1. What's far out at its tail is a whitecap.
   */
  folding: number[];
}

/**
 * Builds the spectrum for every cascade, laid out [cascade][z][x] with the
 * zero frequency at (n/2, n/2).
 */
export function buildSpectrum(
  n: number,
  cascades: Cascade[],
  conditions: OceanConditions,
  seed = 1
): Spectrum {
  const windSpeed = Math.max(conditions.windSpeed, 0.5);
  const peak = peakOmega(windSpeed, conditions.fetch);

  // Waves travel downwind.
  const windAngle = heading(conditions.windDirection);

  const { sea } = conditions;
  const shape = sea ? seaShape(sea, conditions.swell) : null;
  const seaAngle = sea ? heading(sea.direction) : windAngle;

  const count = n * n;
  const h0 = new Float32Array(cascades.length * count * 4);
  const waves = new Float32Array(cascades.length * count * 4);
  const amplitude = new Float32Array(count * 2);
  // Each sample's energy: what a harbour would have, and the open sea's.
  const sheltered = new Float64Array(count);
  const exposed = new Float64Array(count);
  const xi = new Float64Array(count * 2);
  let open = 0;
  const folding: number[] = [];

  cascades.forEach((cascade, c) => {
    const random = gaussianRandom(seed * 7919 + c * 104729);
    const dk = (2 * Math.PI) / cascade.size;
    const base = c * count * 4;
    // The cascade the open sea's in: the others are the wind's, wherever.
    const longest = c === 0;

    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const i = z * n + x;
        const kx = (x - n / 2) * dk;
        const kz = (z - n / 2) * dk;
        const k = Math.hypot(kx, kz);
        const omega = Math.sqrt(G * k);

        xi.set(random(), i * 2);
        waves.set([kx, kz, omega, k > 0 ? 1 / k : 0], base + i * 4);
        sheltered[i] = exposed[i] = 0;

        if (k > 1e-6 && k >= cascade.kMin && k < cascade.kMax) {
          const angle = Math.atan2(kz, kx);
          // Per unit of wavenumber, from per unit of frequency.
          const perK = G / (2 * omega) / k;

          const windSea =
            jonswap(omega, windSpeed, conditions.fetch) *
            spreading(angle - windAngle, omega, peak, conditions.swell) *
            perK;

          if (!longest) {
            sheltered[i] = windSea;
          } else {
            // The same sea, without the waves a harbour's too short to raise.
            sheltered[i] =
              jonswap(omega, windSpeed, conditions.fetch) <=
              jonswap(omega, windSpeed, HARBOUR_FETCH)
                ? windSea
                : jonswap(omega, windSpeed, HARBOUR_FETCH) *
                  spreading(angle - windAngle, omega, peak, conditions.swell) *
                  perK;

            exposed[i] = shape
              ? peaked(omega, shape.peak, shape.sharpness) *
                spreading(angle - seaAngle, omega, shape.peak, shape.narrow) *
                perK
              : windSea;
          }
        }
      }
    }

    // How much of each sample's energy the dice gave it: 1 on average.
    const dealt = (i: number) => (xi[i * 2] ** 2 + xi[i * 2 + 1] ** 2) / 2;
    let scale = 1;

    if (longest && sea) {
      // A measured sea is as high as it was measured: its handful of long
      // waves, as the dice fell, add up to its significant height.
      let drawn = 0;

      for (let i = 0; i < count; i++) drawn += dealt(i) * exposed[i] * dk * dk;

      scale = drawn > 0 ? (sea.height / 4) ** 2 / drawn : 0;
    }

    let harbours = 0;
    let beyond = 0;
    let squeeze = 0;

    for (let i = 0; i < count; i++) {
      const energy = Math.max(sheltered[i], exposed[i] * scale);

      // h~(k) sums h0(k) and conj(h0(-k)), so each contributes half
      // the energy: E|h~|² = S(k) dk².
      const a = Math.sqrt((energy * dk * dk) / 4);

      amplitude[i * 2] = xi[i * 2] * a;
      amplitude[i * 2 + 1] = xi[i * 2 + 1] * a;

      // Each wave's squeeze is k times its height.
      const k2 = waves[base + i * 4] ** 2 + waves[base + i * 4 + 1] ** 2;
      squeeze += 2 * dealt(i) * 2 * a * a * k2;

      harbours += dealt(i) * sheltered[i];
      beyond += dealt(i) * (energy - sheltered[i]);
    }

    if (longest) open = beyond > 0 ? beyond / (harbours + beyond) : 0;
    folding.push(Math.sqrt(squeeze));

    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const i = z * n + x;
        const mirror = ((n - z) % n) * n + ((n - x) % n);
        h0.set(
          [
            amplitude[i * 2],
            amplitude[i * 2 + 1],
            amplitude[mirror * 2],
            -amplitude[mirror * 2 + 1],
          ],
          base + i * 4
        );
      }
    }
  });

  const period = shape?.period ?? (2 * Math.PI) / peak;

  return {
    h0,
    waves,
    open,
    from: sea?.direction ?? conditions.windDirection,
    length: (G * period * period) / (2 * Math.PI),
    folding,
  };
}
