import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RGBAFormat,
} from "three/webgpu";
import { float, mix, texture, uniform } from "three/tsl";

// Where the cloud is, as Himawari last saw it (src/lib/cloudMap.ts): how
// cloudy each kilometre of the map is. The cloud layers' cover (from the
// airport's METAR, or the forecast) is shared out by it, so the same
// amount of cloud piles onto the hills where the satellite saw it and
// leaves clear the sea where it didn't. It's static in the world, which
// suits cloud the hills make, and lags cloud blowing through; its pull
// fades as the scan ages. Without a map the share's 1 everywhere.

/** World metres the field spans, centred on the origin: the terrain's root. */
const SPAN = 65536;

/** Cells a side, as src/lib/cloudMap.ts's MAP_SIZE (not imported: Node's). */
export const FIELD_SIZE = 64;

/**
 * At most this much of the cover is shared out by the map: the rest stays
 * spread evenly, as the scan's coarse and some minutes old.
 */
const PULL = 0.85;

/** Scans this old, ms, pull fully; it fades out by FADED. */
const FRESH = 40 * 60_000;
const FADED = 2 * 3600_000;

/**
 * With the map's mean below this, it's taken as clear: a few bright pixels
 * don't gather all the cover into them.
 */
const LEAST_MEAN = 0.08;

export interface SeenClouds {
  /** When it was scanned, epoch ms. */
  time: number;
  /** FIELD_SIZE² bytes, how cloudy each cell is, rows from the north. */
  cells: Uint8Array;
}

const data = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4).fill(255);
const field = new DataTexture(data, FIELD_SIZE, FIELD_SIZE, RGBAFormat);

Object.assign(field, {
  wrapS: ClampToEdgeWrapping,
  wrapT: ClampToEdgeWrapping,
  magFilter: LinearFilter,
  minFilter: LinearFilter,
  needsUpdate: true,
});

export const cloudField = {
  texture: field,
  /** 0..1, how far the map shares the cover out: 0 without one. */
  pull: uniform(0),
  /** 1 / the map's mean, so the share averages 1 over the map. */
  boost: uniform(1),
};

/** How far a scan `age` ms old pulls, 0..PULL. */
export function pullFor(age: number) {
  const t = Math.min(Math.max((age - FRESH) / (FADED - FRESH), 0), 1);

  return PULL * (1 - t);
}

/**
 * Fills the field from what was `seen`, `age` ms before the scene's time;
 * null leaves it even. Returns the pull it's given.
 */
export function setCloudField(seen: SeenClouds | null, age = 0): number {
  if (!seen) {
    cloudField.pull.value = 0;

    return 0;
  }

  const { cells } = seen;
  let sum = 0;

  cells.forEach((value, k) => {
    data.fill(value, k * 4, k * 4 + 4);
    sum += value;
  });

  const mean = sum / cells.length / 255;

  field.needsUpdate = true;
  cloudField.boost.value = 1 / Math.max(mean, LEAST_MEAN);
  cloudField.pull.value = pullFor(age);

  return cloudField.pull.value;
}

const uvOf = (xz) => xz.add(SPAN / 2).div(SPAN);

/**
 * At xz (world): what the cover's multiplied by there, 0..boost, averaging
 * 1 over the map; 1 everywhere without one.
 */
export const cloudShare = (xz) =>
  mix(
    float(1),
    texture(field, uvOf(xz)).r.mul(cloudField.boost),
    cloudField.pull
  );
