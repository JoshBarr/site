import { z } from "zod";
import { sunPosition } from "../components/scene/sun";
import { toNztm } from "./nztm";
import { decodePng, type Image } from "./png";
import { readJson } from "./schemas";

// Where the cloud is over the map, as Himawari-9 sees it, through CIRA's
// SLIDER (https://slider.cira.colostate.edu), no key: the airport's METAR
// says how much cloud there is and how high, this says where, so it can sit
// on the hills and leave the harbour clear. By day its red visible band,
// half a kilometre a pixel and about 25 minutes behind; with the sun low or
// down, the CLAVR-x cloud mask, 2 km a pixel and about an hour behind.

const SLIDER = "https://slider.cira.colostate.edu/data";

const TIMEOUT = 20_000;

/** Cells a side of the map. */
export const MAP_SIZE = 64;

/**
 * NZTM of the map's centre, and how far it spans, m: the terrain's root
 * (public/terrain/manifest.json), as the scene's world is laid out.
 */
const ORIGIN = [1748000, 5428000] as const;
const SPAN = 65536;

/** Its tiles' size, pixels: 2^zoom of them across the full disk. */
const TILE = 688;

/**
 * Himawari's fixed grid at half a kilometre (its JMA HSD headers): scan
 * angle to column and line. SLIDER pads the 22000 to 22016 pixels at zoom 5;
 * the shift, fitted to the coast on clear days, is about that padding.
 */
const SUB_LONGITUDE = 140.7;
const CFAC = 81865099;
const OFFSET = 11000.5;
const SHIFT = { column: 5.5, line: 8 };
const FULL = 22000 + 16;

/** Low cloud's tops are taken to be this high, m, to undo the parallax. */
const CLOUD_TOP = 1500;

/** The visible band's used above this sun, degrees; the mask below. */
const VISIBLE_SUN = 20;

/**
 * The visible band's brightness from clear (sea's 20–55, land a little
 * brighter) to cloud (110 and up): SLIDER's evened for the sun's height.
 */
const CLEAR = 75;
const CLOUD = 135;

export type Product = "visible" | "mask";

const PRODUCTS: Record<
  Product,
  { name: string; zoom: number; cloud: (r: number, a: number) => number }
> = {
  visible: {
    name: "band_03",
    zoom: 5,
    cloud: (grey) => smoothstep(CLEAR, CLOUD, grey),
  },
  // Clear's left transparent; probably clear, probably cloudy and cloudy
  // are greys 55, 110 and 165.
  mask: {
    name: "cloud_mask_cira_clavr-x",
    zoom: 3,
    cloud: (grey, alpha) =>
      alpha < 128 || grey < 28 ? 0 : grey < 83 ? 0.2 : grey < 138 ? 0.7 : 1,
  },
};

export interface CloudMap {
  /** When the scan began, epoch ms. */
  time: number;
  product: Product;
  /**
   * MAP_SIZE² bytes, base64: how cloudy each cell is, 0–255, row by row
   * from the north, each west to east.
   */
  cells: string;
}

function smoothstep(from: number, to: number, x: number) {
  const t = Math.min(Math.max((x - from) / (to - from), 0), 1);

  return t * t * (3 - 2 * t);
}

/**
 * Where Himawari sees a point `height` m above latitude and longitude
 * (degrees): its pixel at the half-kilometre grid, as SLIDER lays it out.
 */
export function himawariPixel(lat: number, lon: number, height = 0) {
  const phi = (lat * Math.PI) / 180;
  const lambda = ((lon - SUB_LONGITUDE) * Math.PI) / 180;
  const c = Math.atan(0.993305616 * Math.tan(phi));

  const r =
    6356.7523 / Math.sqrt(1 - 0.00669438444 * Math.cos(c) ** 2) + height / 1000;

  const r1 = 42164 - r * Math.cos(c) * Math.cos(lambda);
  const r2 = -r * Math.cos(c) * Math.sin(lambda);
  const r3 = r * Math.sin(c);
  const x = (Math.atan(-r2 / r1) * 180) / Math.PI;
  const y = (Math.asin(-r3 / Math.hypot(r1, r2, r3)) * 180) / Math.PI;

  return {
    column: OFFSET + (x * CFAC) / 2 ** 16 + SHIFT.column,
    line: OFFSET + (y * CFAC) / 2 ** 16 + SHIFT.line,
  };
}

/** NZTM easting and northing back to latitude and longitude, degrees. */
function fromNztm(easting: number, northing: number): [number, number] {
  let lat = -41.3;
  let lon = 174.8;
  const step = 1e-5;

  // Newton's method on toNztm: a few steps from close by.
  for (let i = 0; i < 4; i++) {
    const [e0, n0] = toNztm(lat, lon);
    const [e1, n1] = toNztm(lat + step, lon);
    const [e2, n2] = toNztm(lat, lon + step);

    const [a, b, c, d] = [e1 - e0, e2 - e0, n1 - n0, n2 - n0].map(
      (v) => v / step
    );

    const det = a * d - b * c;
    const de = easting - e0;
    const dn = northing - n0;

    lat += (d * de - b * dn) / det;
    lon += (a * dn - c * de) / det;
  }

  return [lat, lon];
}

/** Each cell's centre on the half-kilometre grid, for cloud at CLOUD_TOP. */
let cellPixels: { column: number; line: number }[] | null = null;

function cellsOnGrid() {
  cellPixels ??= Array.from({ length: MAP_SIZE * MAP_SIZE }, (_, k) => {
    const x = -SPAN / 2 + ((k % MAP_SIZE) + 0.5) * (SPAN / MAP_SIZE);
    const z = -SPAN / 2 + (Math.floor(k / MAP_SIZE) + 0.5) * (SPAN / MAP_SIZE);
    const [lat, lon] = fromNztm(ORIGIN[0] + x, ORIGIN[1] - z);

    return himawariPixel(lat, lon, CLOUD_TOP);
  });

  return cellPixels;
}

const latestTimes = z.object({ timestamps_int: z.array(z.number()) });

/** A SLIDER time, YYYYMMDDhhmmss UTC, as epoch ms. */
const fromStamp = (stamp: string) =>
  Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)),
    Number(stamp.slice(10, 12)),
    Number(stamp.slice(12, 14))
  );

async function get(url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": "joshbarr.com scene" },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`slider: HTTP ${response.status}`);

  return response;
}

/** The product's newest scan, YYYYMMDDhhmmss. */
async function newestScan(name: string) {
  const response = await get(
    `${SLIDER}/json/himawari/full_disk/${name}/latest_times.json`
  );

  const { timestamps_int: times } = await readJson(
    response,
    latestTimes,
    "slider"
  );

  const newest = Math.max(...times);

  if (!Number.isFinite(newest)) throw new Error("slider: no scans");

  return String(newest);
}

/** Which product's right for the sky at `time`: visible with the sun up. */
export const productAt = (time: number): Product =>
  sunPosition(new Date(time)).altitude >= VISIBLE_SUN ? "visible" : "mask";

/**
 * The cloud over the map in the newest scan, as of `now` (epoch ms), or
 * null if it's no newer than the scan at `since`.
 */
export async function fetchCloudMap(
  now = Date.now(),
  since = -Infinity
): Promise<CloudMap | null> {
  const product = productAt(now);
  const { name, zoom, cloud } = PRODUCTS[product];
  const stamp = await newestScan(name);
  const time = fromStamp(stamp);

  if (time <= since) return null;

  const scale = (TILE * 2 ** zoom) / FULL;

  const pixels = cellsOnGrid().map(({ column, line }) => ({
    x: column * scale,
    y: line * scale,
  }));

  // The tiles under the map: one, mostly.
  const tiles = new Map<string, Promise<Image>>();

  const keyOf = (row: number, column: number) =>
    `${String(row).padStart(3, "0")}_${String(column).padStart(3, "0")}`;

  const day = `${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp.slice(6, 8)}`;

  const want = (x: number, y: number) => {
    const key = keyOf(Math.floor(y / TILE), Math.floor(x / TILE));

    if (!tiles.has(key)) {
      tiles.set(
        key,
        get(
          `${SLIDER}/imagery/${day}/himawari---full_disk/${name}/${stamp}/${String(zoom).padStart(2, "0")}/${key}.png`
        )
          .then((response) => response.arrayBuffer())
          .then((buffer) => decodePng(new Uint8Array(buffer)))
      );
    }
  };

  for (const { x, y } of pixels) {
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      want(Math.floor(x - 0.5) + dx, Math.floor(y - 0.5) + dy);
    }
  }

  const decoded = new Map<string, Image>();

  await Promise.all(
    [...tiles].map(async ([key, tile]) => decoded.set(key, await tile))
  );

  /** How cloudy the pixel at x, y (whole) is, 0..1. */
  const cloudAt = (x: number, y: number) => {
    const row = Math.floor(y / TILE);
    const column = Math.floor(x / TILE);

    const image = decoded.get(keyOf(row, column));

    if (!image) return 0;

    const i =
      (Math.min(y - row * TILE, image.height - 1) * image.width +
        Math.min(x - column * TILE, image.width - 1)) *
      4;

    return cloud(image.rgba[i], image.rgba[i + 3]);
  };

  const cells = new Uint8Array(pixels.length);

  pixels.forEach(({ x, y }, k) => {
    // Bilinear, between pixel centres.
    const u = x - 0.5;
    const v = y - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;

    const top = cloudAt(i, j) * (1 - fu) + cloudAt(i + 1, j) * fu;
    const bottom = cloudAt(i, j + 1) * (1 - fu) + cloudAt(i + 1, j + 1) * fu;

    cells[k] = Math.round((top * (1 - fv) + bottom * fv) * 255);
  });

  return { time, product, cells: Buffer.from(cells).toString("base64") };
}
