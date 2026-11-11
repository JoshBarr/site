// The daytime sky as the air makes it: sunlight scattered once on its way
// down, by the air itself (Rayleigh) and by the haze in it (Mie), worked out
// on a round Earth so it holds through sunset and twilight. Luminance only:
// the scene is grey. Everything's relative to the sun above the air, 1.
//
// It gives the scene one account of the light where it had a handful of
// constants: how strong the sun is through the air at its height, how much
// the sky adds and from where, and what the haze glows with.

const EARTH = 6_371_000;

/** Above this, m, there's too little air to count. */
const TOP = 60_000;

/**
 * The air's scattering at sea level, per metre, weighted by how bright the
 * eye finds each colour (5.8, 13.5 and 33.1e-6 for red, green and blue), and
 * the height it thins by e over, m.
 */
const AIR = 1.33e-5;
const AIR_HEIGHT = 8000;

/** Of the light the haze takes out of a ray, the share it scatters on. */
const HAZE_ALBEDO = 0.92;

/**
 * How forward the haze scatters (Henyey-Greenstein's g), as the scene's haze
 * glows toward the sun.
 */
export const HAZE_FORWARD = 0.7;

/** Of the light landing on it, what the land and sea send back up. */
const GROUND = 0.1;

// The table: for each direction, by its height above the horizon and how far
// round from the sun it is, how much sunlight the air and the haze along it
// scatter toward the eye, each less its phase function (which is sharp
// toward the sun, where the table's coarse), and how much they'd scatter of
// an even light.

/** Directions across the table: round from the sun's bearing to opposite. */
export const BEARINGS = 16;

/**
 * And up it, from the horizon to overhead, closer together near the horizon,
 * where the sky changes fastest: row j is (j / (ELEVATIONS - 1))² of the way.
 */
export const ELEVATIONS = 32;

/** Values a direction: air, haze, even light, and one spare. */
export const CHANNELS = 4;

/** Steps along each direction's ray. */
const STEPS = 24;

// How much air a ray passes, from a height in a direction, comes up at
// every step of every direction. For air that thins by e every H metres, it's
// what a level path would pass at the ray's start, H·exp(-h / H) a metre,
// times a factor (Chapman's function) that depends on the ray's slant and
// only a little on the height: 1 straight up, about 35 along the horizon.
// One over it is nearly a straight line in the slant's cosine, so a small
// table of that, read between its entries, is close.

const SLANTS = 33;
const HEIGHTS = 12;

interface Columns {
  /** The height air thins by e over, m. */
  scale: number;
  /** One over the factor, by height then by the slant's cosine, 0..1. */
  inverse: Float32Array;
}

/** A ray's height, m, `distance` along it from `height` at slant `cosine`. */
function heightAlong(height: number, cosine: number, distance: number) {
  const r = EARTH + height;

  return (
    Math.sqrt(r * r + 2 * r * cosine * distance + distance * distance) - EARTH
  );
}

function columnsFor(scale: number): Columns {
  const inverse = new Float32Array(HEIGHTS * SLANTS);
  const steps = 96;

  for (let i = 0; i < HEIGHTS; i++) {
    const height = TOP * (i / (HEIGHTS - 1)) ** 2;
    const r = EARTH + height;
    // Twelve scale heights up there's nothing left.
    const top = r + 12 * scale;

    for (let j = 0; j < SLANTS; j++) {
      const cosine = j / (SLANTS - 1);

      const reach =
        -r * cosine + Math.sqrt(r * r * cosine * cosine + top * top - r * r);

      let sum = 0;

      for (let k = 0; k < steps; k++) {
        const distance = (reach * (k + 0.5)) / steps;

        sum += Math.exp(
          -(heightAlong(height, cosine, distance) - height) / scale
        );
      }

      inverse[i * SLANTS + j] = scale / ((sum * reach) / steps);
    }
  }

  return { scale, inverse };
}

/**
 * The air a ray passes from `height` up at slant `cosine` (0 level, 1
 * straight up), as metres of sea-level air.
 */
function columnUp({ scale, inverse }: Columns, height: number, cosine: number) {
  const row = Math.sqrt(Math.min(Math.max(height / TOP, 0), 1)) * (HEIGHTS - 1);
  const i = Math.min(Math.floor(row), HEIGHTS - 2);
  const column = Math.min(Math.max(cosine, 0), 1) * (SLANTS - 1);
  const j = Math.min(Math.floor(column), SLANTS - 2);
  const u = row - i;
  const v = column - j;
  const at = i * SLANTS + j;

  const factor =
    (inverse[at] * (1 - v) + inverse[at + 1] * v) * (1 - u) +
    (inverse[at + SLANTS] * (1 - v) + inverse[at + SLANTS + 1] * v) * u;

  return (scale * Math.exp(-height / scale)) / factor;
}

/**
 * The same for any slant: one that dips below level passes its lowest point
 * and climbs out again, unless the ground's in the way (Infinity).
 */
function column(columns: Columns, height: number, cosine: number) {
  if (cosine >= 0) return columnUp(columns, height, cosine);

  const lowest =
    (EARTH + height) * Math.sqrt(Math.max(1 - cosine * cosine, 0)) - EARTH;

  if (lowest < 0) return Infinity;

  return 2 * columnUp(columns, lowest, 0) - columnUp(columns, height, -cosine);
}

const air = columnsFor(AIR_HEIGHT);

/** The haze's columns, by the height it thins over: it's seldom changed. */
const hazes = new Map<number, Columns>();

function hazeColumns(scale: number) {
  let columns = hazes.get(scale);

  if (!columns) {
    columns = columnsFor(scale);
    hazes.set(scale, columns);
  }

  return columns;
}

/** The air the sky's worked out through. */
export interface Air {
  /** The haze's extinction at sea level, per metre (see ../haze.ts). */
  haze: number;
  /** The height it thins by e over, m. */
  hazeHeight: number;
}

export interface SkyLight {
  /**
   * BEARINGS × ELEVATIONS × CHANNELS, by elevation then bearing: (air's
   * scattering, haze's, both of an even light, 0) along each direction.
   */
  table: Float32Array;
  /** The sun's light through the air, of what it is above it. */
  sun: number;
  /** The sky's light on level ground, as a share of the sun above the air. */
  sky: number;
  /**
   * The even light the air and haze are lit by besides the sun (the sky
   * around them, and the ground), as radiance: what `table`'s third value
   * scatters.
   */
  around: number;
}

/** The air's phase function, by the cosine of the angle from the sun. */
export const airPhase = (cosine: number) =>
  (3 / (16 * Math.PI)) * (1 + cosine * cosine);

/** The haze's (Henyey-Greenstein). */
export function hazePhase(cosine: number) {
  const g = HAZE_FORWARD;

  return (
    (1 - g * g) / (4 * Math.PI * Math.pow(1 + g * g - 2 * g * cosine, 1.5))
  );
}

/** The sun's disc is half a degree across: it sets over this, radians. */
const DISC = (0.27 * Math.PI) / 180;

/** Elevation of the table's row `j`, radians. */
const elevationOf = (j: number) => (Math.PI / 2) * (j / (ELEVATIONS - 1)) ** 2;

/**
 * The sky with the sun `altitude` degrees up (or down: the sky's lit for a
 * while after it sets) through `air`.
 */
export function skyLight(
  altitude: number,
  { haze, hazeHeight }: Air
): SkyLight {
  const mist = hazeColumns(hazeHeight);
  const up = (altitude * Math.PI) / 180;
  const sunX = Math.cos(up);
  const sunY = Math.sin(up);

  /** Optical depth from `height` toward where the slant's `cosine` is. */
  const depth = (height: number, cosine: number) => {
    const through = column(air, height, cosine);

    // Behind the Earth, whatever the haze.
    if (through === Infinity) return Infinity;

    return AIR * through + haze * column(mist, height, cosine);
  };

  const table = new Float32Array(BEARINGS * ELEVATIONS * CHANNELS);

  for (let j = 0; j < ELEVATIONS; j++) {
    const elevation = elevationOf(j);
    const rise = Math.sin(elevation);
    const run = Math.cos(elevation);

    // To where the ray leaves the air.
    const reach =
      -EARTH * rise +
      Math.sqrt(EARTH * EARTH * rise * rise + TOP * TOP + 2 * EARTH * TOP);

    for (let i = 0; i < BEARINGS; i++) {
      const bearing = (Math.PI * i) / (BEARINGS - 1);
      const dx = run * Math.cos(bearing);
      const dz = run * Math.sin(bearing);
      let through = 1;
      let fromAir = 0;
      let fromHaze = 0;
      let even = 0;
      let last = 0;

      for (let k = 0; k < STEPS; k++) {
        // Short steps first, where the haze is.
        const next = reach * ((k + 1) / STEPS) ** 3;
        const middle = (last + next) / 2;
        const length = next - last;

        last = next;

        // From the Earth's centre, the eye being on its surface.
        const x = dx * middle;
        const y = EARTH + rise * middle;
        const z = dz * middle;
        const r = Math.sqrt(x * x + y * y + z * z);
        const height = Math.max(r - EARTH, 0);

        const byAir = AIR * Math.exp(-height / AIR_HEIGHT);
        const byHaze = haze * Math.exp(-height / hazeHeight);
        const taken = byAir + byHaze;

        if (taken * length < 1e-9) continue;

        // What the step scatters toward the eye of what reaches it, and
        // what's left of that by the time it gets here.
        const kept = Math.exp(-taken * length);
        const shown = (through * (1 - kept)) / taken;

        through *= kept;

        const sunCosine = (x * sunX + y * sunY) / r;
        const lit = Math.exp(-depth(height, sunCosine));

        fromAir += byAir * lit * shown;
        fromHaze += byHaze * HAZE_ALBEDO * lit * shown;
        even += (byAir + byHaze * HAZE_ALBEDO) * shown;
      }

      const at = (j * BEARINGS + i) * CHANNELS;

      table[at] = fromAir;
      table[at + 1] = fromHaze;
      table[at + 2] = even;
    }
  }

  // The sun through the air, fading as its disc crosses the horizon.
  const above = Math.min(Math.max((up + DISC) / (2 * DISC), 0), 1);
  const sun = above * Math.exp(-depth(0, Math.max(sunY, 0)));

  // What the sky sheds on level ground: its radiance times the sine of its
  // elevation, over the dome. The table's rows aren't evenly spaced.
  let once = 0;
  let evenly = 0;

  for (let j = 0; j < ELEVATIONS; j++) {
    const elevation = elevationOf(j);

    const span =
      (elevationOf(Math.min(j + 1, ELEVATIONS - 1)) -
        elevationOf(Math.max(j - 1, 0))) /
      2;

    const solid = Math.cos(elevation) * Math.sin(elevation) * span;

    for (let i = 0; i < BEARINGS; i++) {
      const bearing = (Math.PI * i) / (BEARINGS - 1);

      // Both sides of the sun; the end columns are half a step each.
      const width =
        ((i === 0 || i === BEARINGS - 1 ? 1 : 2) * Math.PI) / (BEARINGS - 1);

      const cosine =
        Math.cos(elevation) * Math.cos(bearing) * sunX +
        Math.sin(elevation) * sunY;

      const at = (j * BEARINGS + i) * CHANNELS;

      once +=
        (table[at] * airPhase(cosine) + table[at + 1] * hazePhase(cosine)) *
        solid *
        width;

      evenly += table[at + 2] * solid * width;
    }
  }

  // Light scattered more than once, roughly: the air's lit too by the sky
  // around it and the ground under it, evenly. The sky's own share of that
  // comes back round, so it's solved for: sky = once + around · evenly, and
  // around = ((1 + GROUND) · sky + GROUND · the sun on the ground) / 2π.
  const ground = GROUND * sun * Math.max(sunY, 0);
  const back = ((1 + GROUND) * evenly) / (2 * Math.PI);
  const sky = (once + (ground * evenly) / (2 * Math.PI)) / (1 - back);
  const around = ((1 + GROUND) * sky + ground) / (2 * Math.PI);

  return { table, sun, sky, around };
}

/** The sky's radiance toward a row and column of `light`'s table. */
export function radianceAt(
  light: SkyLight,
  altitude: number,
  row: number,
  bearing: number
) {
  const up = (altitude * Math.PI) / 180;
  const elevation = elevationOf(row);
  const round = (Math.PI * bearing) / (BEARINGS - 1);

  const cosine =
    Math.cos(elevation) * Math.cos(round) * Math.cos(up) +
    Math.sin(elevation) * Math.sin(up);

  const at = (row * BEARINGS + bearing) * CHANNELS;

  return (
    light.table[at] * airPhase(cosine) +
    light.table[at + 1] * hazePhase(cosine) +
    light.table[at + 2] * light.around
  );
}
