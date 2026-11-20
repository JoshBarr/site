import { z } from "zod";
import { fromNztm } from "./cloudMap";
import { decodePng } from "./png";
import { RADAR_SIZE, RADAR_SPAN, type RadarScan, rateByte } from "./radarGrid";
import { readJson } from "./schemas";

// Where it's raining, as the rain radar sees it, through RainViewer's
// public API (https://www.rainviewer.com/api.html), no key, free for
// personal use with a credit: MetService's radars are in its composite,
// Wellington's among them. A frame every ten minutes, up within five of its
// time, as a picture coloured by reflectivity; the gauges (./rainGauges.ts)
// say how hard it's raining where they are, this says where, between them
// and out at sea.

const FRAMES = "https://api.rainviewer.com/public/weather-maps.json";

const TIMEOUT = 20_000;

/** NZTM of the map's centre: the terrain's root (as ./cloudMap.ts has it). */
const ORIGIN = [1748000, 5428000] as const;

/**
 * The picture asked for: as far in as the API goes, and its larger size,
 * centred on the map. 460 m a pixel here, 235 km across, so the grid's well
 * inside it.
 */
const ZOOM = 7;
const IMAGE = 512;

/** Its colours: "Universal Blue", the only scheme there is now. */
const SCHEME = 2;

/** Neither smoothed nor with snow in colours of its own. */
const OPTIONS = "0_0";

/**
 * Universal Blue's colour for each reflectivity from -10 dBZ to 75, RRGGBB
 * (rainviewer.com/files/rainviewer_api_colors_table.csv, its rain column).
 * Unsmoothed, a pixel's exactly one of them; 65 to 74 share white, and 75
 * and up green.
 */
const COLOURS =
  "63615966635a69665c6c685d6f6b5f726e617570627873647c75657f7867827b69" +
  "857d6a88806c8b826d8e856f9288719e9375aa9e79b6a97ec2b482cec087d2c48b" +
  "d6c88fdacc93ded09788ddee6cd1eb51c5e836bae51baee200a3e0009ad50091ca" +
  "0088bf007fb40077aa0070a300699c006295005b8e005588005180004e78004a70" +
  "004768ffee00ffe000ffd200ffc500ffb700ffaa00ff9f00ff9500ff8b00ff8100" +
  "ff4400f23600e62800d91b00cd0d00c10000a800008f00007600005d0000ffaaff" +
  "ff9fffff95ffff8bffff81ffff77ffff6cffff62ffff58ffff4effffffffffffff" +
  "ffffffffffffffffffffffffffffffffffffffffffffffff00ff00";

const FIRST_DBZ = -10;

/**
 * Echoes fainter than this are left out, dBZ: RainViewer's own colours turn
 * from a haze to blue here, and what's below is drizzle too light to see
 * (0.3 mm/h), sea clutter and insects as often as rain.
 */
const FAINT = 15;

/** Above this it's hail as much as rain, dBZ: 100 mm/h. */
const HAIL = 55;

/**
 * A reflectivity's rain rate, mm/h, by Marshall and Palmer's Z = 200 R^1.6:
 * what a radar's rain maps are made with, and within a factor of two or so
 * of the truth for most rain. The gauges set it right (the scene's rain
 * field).
 */
export function rateOf(dbz: number) {
  if (dbz < FAINT) return 0;

  return (10 ** (Math.min(dbz, HAIL) / 10) / 200) ** (1 / 1.6);
}

/** Each colour's rate, by its red, green and blue as one number. */
const RATES = new Map<number, number>();

for (let i = 0; i * 6 < COLOURS.length; i++) {
  const colour = parseInt(COLOURS.slice(i * 6, i * 6 + 6), 16);

  // Colours shared are their lowest reflectivity's.
  if (!RATES.has(colour)) RATES.set(colour, rateOf(FIRST_DBZ + i));
}

/**
 * This share of the pixels read in colours that aren't the scheme's, and
 * it's not the picture it's taken for: a notice, or new colours.
 */
const STRANGE = 0.01;

const frames = z.object({
  host: z.string(),
  radar: z.object({
    past: z.array(z.object({ time: z.number(), path: z.string() })),
  }),
});

async function get(url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": "joshbarr.com scene" },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!response.ok) throw new Error(`rainviewer: HTTP ${response.status}`);

  return response;
}

/** Where latitude and longitude fall on the web's Mercator at ZOOM, pixels. */
function mercator(lat: number, lon: number): [number, number] {
  const across = IMAGE * 2 ** ZOOM;
  const phi = (lat * Math.PI) / 180;

  return [
    ((lon + 180) / 360) * across,
    ((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * across,
  ];
}

/** The map's centre, as the picture's asked for. */
const [CENTRE_LAT, CENTRE_LON] = fromNztm(ORIGIN[0], ORIGIN[1]).map((degrees) =>
  Number(degrees.toFixed(4))
);

/** Intervals a side of the lattice the grid's placed on the picture by. */
const LATTICE = 16;

/**
 * Where points across the grid fall in the picture, pixels: worked out on
 * a lattice 8 km apart, between which the two projections are as good as
 * straight.
 */
let latticePixels: Float64Array | null = null;

function onPicture() {
  if (latticePixels) return latticePixels;

  const [centreX, centreY] = mercator(CENTRE_LAT, CENTRE_LON);

  latticePixels = new Float64Array((LATTICE + 1) ** 2 * 2);

  for (let j = 0; j <= LATTICE; j++) {
    for (let i = 0; i <= LATTICE; i++) {
      const x = -RADAR_SPAN / 2 + (i / LATTICE) * RADAR_SPAN;
      const z = -RADAR_SPAN / 2 + (j / LATTICE) * RADAR_SPAN;
      const [px, py] = mercator(...fromNztm(ORIGIN[0] + x, ORIGIN[1] - z));

      // The picture's middle is the point asked for (measured against the
      // API's own tiles: within half a pixel).
      latticePixels.set(
        [px - centreX + IMAGE / 2, py - centreY + IMAGE / 2],
        (j * (LATTICE + 1) + i) * 2
      );
    }
  }

  return latticePixels;
}

/** The picture's pixel under a point u, v across the grid, each 0..1. */
function pixelAt(u: number, v: number): [number, number] {
  const lattice = onPicture();
  const i = Math.min(Math.floor(u * LATTICE), LATTICE - 1);
  const j = Math.min(Math.floor(v * LATTICE), LATTICE - 1);
  const fu = u * LATTICE - i;
  const fv = v * LATTICE - j;

  const at = (di: number, dj: number, axis: number) =>
    lattice[((j + dj) * (LATTICE + 1) + i + di) * 2 + axis];

  const blend = (axis: number) =>
    (at(0, 0, axis) * (1 - fu) + at(1, 0, axis) * fu) * (1 - fv) +
    (at(0, 1, axis) * (1 - fu) + at(1, 1, axis) * fu) * fv;

  return [Math.floor(blend(0)), Math.floor(blend(1))];
}

/** Points a side each cell's rate is averaged over: the pixels under it. */
const TAPS = 2;

/**
 * The rain over the map in RainViewer's newest frame, or null if it's no
 * newer than the one at `since` (epoch ms). Throws if the picture isn't the
 * one expected.
 */
export async function fetchRadar(since = -Infinity): Promise<RadarScan | null> {
  const { host, radar } = await readJson(
    await get(FRAMES),
    frames,
    "rainviewer"
  );

  const newest = radar.past.reduce<(typeof radar.past)[number] | null>(
    (best, frame) => (!best || frame.time > best.time ? frame : best),
    null
  );

  if (!newest) throw new Error("rainviewer: no frames");

  const time = newest.time * 1000;

  if (time <= since) return null;

  // The API says where its pictures are; only its own hosts are asked.
  const at = new URL(newest.path, host);

  if (
    at.protocol !== "https:" ||
    !/(^|\.)rainviewer\.com$/.test(at.hostname) ||
    !at.pathname.startsWith("/v2/radar/")
  ) {
    throw new Error(`rainviewer: unexpected host or path, ${at.href}`);
  }

  const response = await get(
    `${at.origin}${at.pathname}/${IMAGE}/${ZOOM}/${CENTRE_LAT}/${CENTRE_LON}/${SCHEME}/${OPTIONS}.png`
  );

  const image = decodePng(new Uint8Array(await response.arrayBuffer()));

  if (image.width !== IMAGE || image.height !== IMAGE) {
    throw new Error(
      `rainviewer: a picture ${image.width} by ${image.height}, not ${IMAGE}`
    );
  }

  const cells = new Uint8Array(RADAR_SIZE * RADAR_SIZE);
  let strange = 0;

  for (let j = 0; j < RADAR_SIZE; j++) {
    for (let i = 0; i < RADAR_SIZE; i++) {
      let sum = 0;

      for (let tap = 0; tap < TAPS * TAPS; tap++) {
        const [x, y] = pixelAt(
          (i + ((tap % TAPS) + 0.5) / TAPS) / RADAR_SIZE,
          (j + (Math.floor(tap / TAPS) + 0.5) / TAPS) / RADAR_SIZE
        );

        const pixel = (y * IMAGE + x) * 4;

        // Clear's transparent.
        if (image.rgba[pixel + 3] === 0) continue;

        const rate = RATES.get(
          (image.rgba[pixel] << 16) |
            (image.rgba[pixel + 1] << 8) |
            image.rgba[pixel + 2]
        );

        if (rate === undefined) strange++;
        else sum += rate;
      }

      cells[j * RADAR_SIZE + i] = rateByte(sum / (TAPS * TAPS));
    }
  }

  if (strange > STRANGE * cells.length * TAPS * TAPS) {
    throw new Error(
      "rainviewer: a picture in colours that aren't its scheme's"
    );
  }

  return { time, cells: Buffer.from(cells).toString("base64") };
}
