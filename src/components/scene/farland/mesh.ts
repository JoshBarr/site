import { nztmToWorld, type TerrainManifest } from "../terrain/manifest";

// The far land's mesh, as scripts/farland/build_farland.py writes it to
// public/farland/land.bin (little-endian, as every browser's typed arrays
// are):
//   uint32 x 5     vertices, triangles, west, north (NZTM, m), cell (m)
//   int16 x 3 each vertex: column east of west, row south of north, height (m)
//   uint16 x 3     each triangle, the farthest from the scene first

const FAR_LAND_URL = "/farland/land.bin";

/**
 * The mesh's eastern edge, an NZTM easting (EAST in the build script): all
 * the land west of it is the South Island's. The terrain's root reaches
 * 9 km past it, over the tip of Arapawa Island and the Brothers, which it
 * leaves to the mesh (see `sunk` in ../terrain/Terrain.tsx).
 */
export const FAR_LAND_EAST = 1724000;

/** The header's uint32s, and a vertex's int16s. */
const HEADER = 5;
const VERTEX = 3;

export interface FarLandMesh {
  /**
   * Each vertex's world x, height above sea level (m, as surveyed: no
   * vertical scale, on a flat Earth) and world z.
   */
  positions: Float32Array;
  /** Three to a triangle, anticlockwise from above, the farthest first. */
  indices: Uint16Array;
}

/** land.bin's mesh, in the world `manifest` lays out. */
export function parseFarLand(
  data: ArrayBuffer,
  manifest: TerrainManifest
): FarLandMesh {
  const [vertices, triangles, west, north, cell] = new Uint32Array(
    data,
    0,
    HEADER
  );

  const start = HEADER * Uint32Array.BYTES_PER_ELEMENT;
  const packed = new Int16Array(data, start, vertices * VERTEX);

  const indices = new Uint16Array(
    data,
    start + packed.byteLength,
    triangles * 3
  );

  const positions = new Float32Array(vertices * 3);

  for (let i = 0; i < vertices; i++) {
    const [column, row, height] = packed.subarray(i * VERTEX, (i + 1) * VERTEX);

    const [x, z] = nztmToWorld(
      manifest,
      west + column * cell,
      north - row * cell
    );

    positions.set([x, height, z], i * 3);
  }

  // A copy: the file's buffer can go.
  return { positions, indices: indices.slice() };
}

export async function loadFarLand(manifest: TerrainManifest) {
  const response = await fetch(FAR_LAND_URL);

  if (!response.ok) throw new Error(`far land: HTTP ${response.status}`);

  return parseFarLand(await response.arrayBuffer(), manifest);
}
