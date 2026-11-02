import { useEffect, useState } from "react";
import { nztmToWorld, TERRAIN_URL, TileIndex } from "../terrain/manifest";

/**
 * Steps a push off land takes at most: the field's slope is ~1, so few, but
 * a hull in a slip may be pushed off one side, then the other, then its end.
 */
const PUSH_STEPS = 8;
/** Most points along a hull kept off the shore. */
const MAX_SAMPLES = 16;
/** Pushed this far past where it needs to be, so it lands clear, not on it. */
const PUSH_SLACK = 0.25;
/** Smallest step along a course, metres: the field's own precision. */
const MIN_STEP = 2;

/**
 * Signed distance to the shore from the terrain build's shore.png, metres,
 * positive at sea, in the world frame. Saturates a few tens of metres either
 * side; outside its bounds is open sea.
 */
export class Shore {
  private readonly values: Uint8Array;
  private readonly width: number;
  private readonly height: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly res: number;
  private readonly unit: number;
  /** As far as the field reaches, either way. */
  readonly range: number;

  constructor(
    index: TileIndex,
    values: Uint8Array,
    { origin, resolution, size, unit }: NonNullable<
      TileIndex["manifest"]["shore"]
    >
  ) {
    this.values = values;
    [this.width, this.height] = size;
    [this.x0, this.z0] = nztmToWorld(index.manifest, ...origin);
    this.res = resolution;
    this.unit = unit;
    this.range = 127 * unit;
  }

  /** Bilinear between samples. */
  distance(x: number, z: number) {
    const u = (x - this.x0) / this.res;
    const v = (z - this.z0) / this.res;
    if (u < 0 || v < 0 || u > this.width - 1 || v > this.height - 1) {
      return this.range;
    }
    const i = Math.min(Math.floor(u), this.width - 2);
    const j = Math.min(Math.floor(v), this.height - 2);
    const fu = u - i;
    const fv = v - j;
    const at = j * this.width + i;
    const { values, width } = this;
    const top = values[at] + (values[at + 1] - values[at]) * fu;
    const bottom =
      values[at + width] + (values[at + width + 1] - values[at + width]) * fu;
    return (top + (bottom - top) * fv - 128) * this.unit;
  }

  /**
   * Where to put (x, z) so it's at least `clearance` out to sea: the nearest
   * such place, or as near as a narrow channel allows. With `half`, it's the
   * middle of a line that far either way along the unit (dx, dz), a hull's
   * keel, and all of the line is kept off. Null if some of it is still
   * aground: too far inland to say where the sea is.
   */
  toWater(
    x: number,
    z: number,
    clearance = 0,
    dx = 0,
    dz = 0,
    half = 0
  ): [number, number] | null {
    const n = Math.min(
      Math.ceil((2 * half) / Math.max(clearance, MIN_STEP)),
      MAX_SAMPLES
    );
    // The point along the line nearest the shore: [distance, x, z].
    const nearest = (cx: number, cz: number) => {
      let least: [number, number, number] = [Infinity, cx, cz];
      for (let k = 0; k <= n; k++) {
        const s = n > 0 ? -half + (2 * half * k) / n : 0;
        const px = cx + dx * s;
        const pz = cz + dz * s;
        const d = this.distance(px, pz);
        if (d < least[0]) least = [d, px, pz];
      }
      return least;
    };
    let [d, px, pz] = nearest(x, z);
    // Across a channel narrower than the clearance it can overshoot: keep the
    // furthest from either side.
    let best: [number, number, number] = [x, z, d];
    for (let step = 0; step < PUSH_STEPS && d < clearance; step++) {
      const e = this.res / 2;
      const gx = this.distance(px + e, pz) - this.distance(px - e, pz);
      const gz = this.distance(px, pz + e) - this.distance(px, pz - e);
      const slope = Math.hypot(gx, gz);
      // Flat: saturated, deep inland.
      if (slope < 1e-6) break;
      const push = clearance - d + PUSH_SLACK;
      x += (gx / slope) * push;
      z += (gz / slope) * push;
      [d, px, pz] = nearest(x, z);
      if (d > best[2]) best = [x, z, d];
    }
    return best[2] >= 0 ? [best[0], best[1]] : null;
  }

  /**
   * How far from (x, z) along the unit direction (dx, dz), up to `max`, before
   * coming closer to the shore than `clearance`, or than it starts, if that's
   * closer: so a ship can always leave a berth, but not run aground.
   */
  reach(
    x: number,
    z: number,
    dx: number,
    dz: number,
    max: number,
    clearance = 0
  ) {
    const limit = Math.min(
      Math.max(this.distance(x, z) - MIN_STEP, 0),
      clearance
    );
    // Steps as far as the shore is, past the limit: it can't be nearer.
    let t = 0;
    let d = this.distance(x, z);
    while (t < max) {
      const next = Math.min(t + Math.max(d - limit, MIN_STEP), max);
      d = this.distance(x + dx * next, z + dz * next);
      if (d < limit) return t;
      t = next;
    }
    return max;
  }
}

async function loadShore(index: TileIndex) {
  const { shore } = index.manifest;
  if (!shore) throw new Error("terrain manifest has no shore");
  const url = `${TERRAIN_URL}/shore.png`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  // Distances, not colours: they must arrive untouched.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const values = new Uint8Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = rgba[i * 4];
  return new Shore(index, values, shore);
}

/** The shore, once loaded; null until then, or if it can't be. */
export function useShore(index: TileIndex) {
  const [shore, setShore] = useState<Shore | null>(null);
  useEffect(() => {
    let stopped = false;
    loadShore(index).then(
      (loaded) => !stopped && setShore(loaded),
      (e) => console.error("[shore]", e)
    );
    return () => {
      stopped = true;
    };
  }, [index]);
  return shore;
}
