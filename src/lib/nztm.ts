// NZTM2000 (EPSG:2193): transverse Mercator on GRS80, Krüger series. Mirrors
// toNztm in scripts/lib/geo.mjs, which the build scripts use.

const A = 6378137;
const F = 1 / 298.257222101;
const K0 = 0.9996;
const LON0 = (173 * Math.PI) / 180;
const FALSE_E = 1600000;
const FALSE_N = 10000000;

const n = F / (2 - F);
const e = Math.sqrt(F * (2 - F));
const radius = (A / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);

const alpha = [
  n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3,
  (13 / 48) * n ** 2 - (3 / 5) * n ** 3,
  (61 / 240) * n ** 3,
];

/** WGS84 latitude and longitude, degrees, to NZTM easting and northing. */
export function toNztm(lat: number, lon: number): [number, number] {
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
