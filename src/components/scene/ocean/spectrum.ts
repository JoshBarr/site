// Initial ocean spectrum for the FFT simulation (Tessendorf 2001), using a
// JONSWAP energy spectrum with Mitsuyasu directional spreading. Computed on
// the CPU whenever conditions change; the GPU only animates it.

const G = 9.81;

export interface OceanConditions {
  /** Metres per second at 10m. */
  windSpeed: number;
  /** Degrees, meteorological: the direction the wind blows from. */
  windDirection: number;
  /** Metres of open water upwind. */
  fetch: number;
  /** 0..1: narrows spreading toward long-travelled, aligned swell. */
  swell: number;
}

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

function jonswap(omega: number, windSpeed: number, fetch: number) {
  const alpha = 0.076 * Math.pow((windSpeed * windSpeed) / (fetch * G), 0.22);
  const peak = peakOmega(windSpeed, fetch);
  const sigma = omega <= peak ? 0.07 : 0.09;

  const r = Math.exp(
    -((omega - peak) ** 2) / (2 * sigma * sigma * peak * peak)
  );

  return (
    ((alpha * G * G) / omega ** 5) *
    Math.exp(-1.25 * (peak / omega) ** 4) *
    Math.pow(3.3, r)
  );
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

  // Waves travel downwind. Bearing clockwise from north; north is -z.
  const bearing = ((conditions.windDirection + 180) * Math.PI) / 180;
  const windAngle = Math.atan2(-Math.cos(bearing), Math.sin(bearing));

  const count = n * n;
  const h0 = new Float32Array(cascades.length * count * 4);
  const waves = new Float32Array(cascades.length * count * 4);
  const amplitude = new Float32Array(count * 2);

  cascades.forEach((cascade, c) => {
    const random = gaussianRandom(seed * 7919 + c * 104729);
    const dk = (2 * Math.PI) / cascade.size;
    const base = c * count * 4;

    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const i = z * n + x;
        const kx = (x - n / 2) * dk;
        const kz = (z - n / 2) * dk;
        const k = Math.hypot(kx, kz);
        const omega = Math.sqrt(G * k);
        const [xi1, xi2] = random();

        waves.set([kx, kz, omega, k > 0 ? 1 / k : 0], base + i * 4);

        let a = 0;

        if (k > 1e-6 && k >= cascade.kMin && k < cascade.kMax) {
          const theta = Math.atan2(kz, kx) - windAngle;
          const dOmegaDk = G / (2 * omega);

          const energy =
            (jonswap(omega, windSpeed, conditions.fetch) *
              spreading(theta, omega, peak, conditions.swell) *
              dOmegaDk) /
            k;

          // h~(k) sums h0(k) and conj(h0(-k)), so each contributes half
          // the energy: E|h~|² = S(k) dk².
          a = Math.sqrt((energy * dk * dk) / 4);
        }

        amplitude[i * 2] = xi1 * a;
        amplitude[i * 2 + 1] = xi2 * a;
      }
    }

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

  return { h0, waves };
}
