// Shared by the scene's build scripts: NZTM projection and ground heights
// from the terrain tiles.

import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// --- NZTM2000 (EPSG:2193): transverse Mercator on GRS80, Krüger series. ---

const A = 6378137;
const F = 1 / 298.257222101;
const K0 = 0.9996;
const LON0 = (173 * Math.PI) / 180;
const FALSE_E = 1600000;
const FALSE_N = 10000000;

export function toNztm(lat, lon) {
  const n = F / (2 - F);
  const e = Math.sqrt(F * (2 - F));
  const radius = (A / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  const alpha = [
    n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3,
    (13 / 48) * n ** 2 - (3 / 5) * n ** 3,
    (61 / 240) * n ** 3,
  ];

  const phi = (lat * Math.PI) / 180;
  const dLon = (lon * Math.PI) / 180 - LON0;
  const t = Math.sinh(
    Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi))
  );
  const xi0 = Math.atan2(t, Math.cos(dLon));
  const eta0 = Math.atanh(Math.sin(dLon) / Math.sqrt(1 + t * t));

  let xi = xi0;
  let eta = eta0;
  alpha.forEach((a, i) => {
    const j = 2 * (i + 1);
    xi += a * Math.sin(j * xi0) * Math.cosh(j * eta0);
    eta += a * Math.cos(j * xi0) * Math.sinh(j * eta0);
  });

  return [FALSE_E + K0 * radius * eta, FALSE_N + K0 * radius * xi];
}

/** Web Mercator (EPSG:3857) metres to latitude and longitude, degrees. */
export function fromWebMercator(x, y) {
  const R = 6378137;
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lat, lon];
}

// --- Ground height from the finest terrain tile covering a point. ---

/**
 * Bare-earth DEM heights (metres, unscaled) read from the terrain tiles in
 * `terrainDir`, so run build_tiles.py first. Returns undefined off the map.
 */
export async function createGroundSampler(terrainDir) {
  const manifest = JSON.parse(
    await readFile(path.join(terrainDir, "manifest.json"), "utf8")
  );
  const { origin, rootSize, tileCells, apron, encoding } = manifest;
  const levels = manifest.levels.map((l) => l.level).sort((a, b) => b - a);
  const tiles = new Map();

  const loadTile = (level, x, y) => {
    const key = `${level}/${x}/${y}`;
    if (!tiles.has(key)) {
      tiles.set(
        key,
        sharp(path.join(terrainDir, `${key}.webp`))
          .raw()
          .toBuffer({ resolveWithObject: true })
          .catch(() => null)
      );
    }
    return tiles.get(key);
  };

  async function groundHeight(easting, northing) {
    // World frame: x east, z south, from the manifest origin.
    const wx = easting - origin[0] + rootSize / 2;
    const wz = -(northing - origin[1]) + rootSize / 2;

    for (const level of levels) {
      const size = rootSize / 2 ** level;
      const tx = Math.floor(wx / size);
      const ty = Math.floor(wz / size);
      const tile = await loadTile(level, tx, ty);
      if (!tile) continue;

      const { data, info } = tile;
      const height = (i, j) => {
        const p = (j * info.width + i) * info.channels;
        return (
          ((data[p] << 8) | data[p + 1]) / encoding.scale - encoding.offset
        );
      };
      const u = ((wx - tx * size) / size) * tileCells + apron;
      const v = ((wz - ty * size) / size) * tileCells + apron;
      const i = Math.floor(u);
      const j = Math.floor(v);
      const fu = u - i;
      const fv = v - j;
      const top = height(i, j) * (1 - fu) + height(i + 1, j) * fu;
      const bottom = height(i, j + 1) * (1 - fu) + height(i + 1, j + 1) * fu;
      return top * (1 - fv) + bottom * fv;
    }
    return undefined;
  }

  return { manifest, groundHeight };
}
