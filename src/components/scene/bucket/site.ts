// Where the Bucket Fountain stands in Cuba Mall, from OpenStreetMap
// (© OpenStreetMap contributors, ODbL): the fountain is node 175059306, its
// pool way 1098446979, and the mall way 5181977. The ground's the terrain's
// bare-earth DEM (scripts/lib/geo.mjs createGroundSampler) at the node,
// before the terrain's vertical scale: the paving's within 0.2 m of it for
// ten metres round.

/** The fountain, NZTM2000 easting and northing. */
export const SITE: readonly [number, number] = [1748732.95, 5427280.39];

/** Bare ground at the fountain, m above sea level. */
export const GROUND = 7.41;

/**
 * Cuba Mall's bearing here, degrees from north: it runs NNE from Ghuznee
 * Street toward Dixon Street, and the fountain and its pool are set square
 * to it.
 */
export const MALL_BEARING = 23.6;

/**
 * The pool's edge, OSM's outline, m east and north of SITE: a stepped
 * shape down the middle of the mall, about 8 m long and 3–5 m across.
 */
export const POOL: readonly [east: number, north: number][] = [
  [-1.2, 2.7],
  [-2.7, -0.8],
  [-1.4, -1.3],
  [-1.8, -2.2],
  [-0.1, -2.9],
  [-0.7, -4.5],
  [-1.5, -4.2],
  [-2.0, -5.4],
  [0.4, -6.4],
  [2.7, -0.9],
  [1.0, -0.2],
  [1.7, 1.4],
];

const b = (MALL_BEARING * Math.PI) / 180;

/**
 * East and north of SITE to the fountain's own frame: x across the mall
 * (toward ESE), z down it (toward SSW), as the model's built. The model's
 * turned by `-bearing` about y to stand in the world (x east, z south).
 */
export function toLocal(east: number, north: number): [number, number] {
  return [
    east * Math.cos(b) - north * Math.sin(b),
    -east * Math.sin(b) - north * Math.cos(b),
  ];
}

/** The fountain's frame to the world's directions (x east, z south). */
export function toWorld(x: number, z: number): [number, number] {
  return [x * Math.cos(b) - z * Math.sin(b), x * Math.sin(b) + z * Math.cos(b)];
}

/** The turn about y that stands the fountain's frame in the world. */
export const YAW = -b;
