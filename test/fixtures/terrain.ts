import {
  type TerrainManifest,
  TileIndex,
} from "../../src/components/scene/terrain/manifest";

/**
 * A terrain index with its origin at NZTM 0, 0, so world x is the easting
 * and z the northing turned round: for layers that only need its frame.
 */
export function originIndex() {
  const manifest: TerrainManifest = {
    crs: "EPSG:2193",
    origin: [0, 0],
    rootSize: 1000,
    tileCells: 256,
    apron: 1,
    encoding: { offset: 0, scale: 1 },
    levels: [{ level: 0, resolution: 4, range: [0, 1, 0, 1], tiles: [] }],
  };

  return new TileIndex(manifest);
}
