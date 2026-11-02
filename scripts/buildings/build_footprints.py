"""
Heights for the OpenStreetMap building footprints over the terrain's level 5
region, for build_tiles.mjs to extrude where the council's 3D models stop
(Porirua, the Hutt, Wainuiomata).

New Zealand's OSM buildings are mostly LINZ's NZ Building Outlines,
imported. Each footprint's height is a high percentile of the lidar canopy
height model inside it (the trees build's, DSM less DEM at 2m): pitched
roofs come out between eaves and ridge, and the edge samples, which mix in
the ground around, count for little.

Run the trees build first: its canopy height tiles are reused.

Output: .cache/buildings/footprints.json
  {"buildings": [[osm id, height m, [e, n, e, n, ...]], ...]}
  rings in NZTM, outer only, not closed

Usage:
  .venv-terrain/bin/python -I scripts/buildings/build_footprints.py
"""

import importlib.util
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
from affine import Affine
from rasterio.crs import CRS
from rasterio.features import rasterize
from rasterio.warp import transform

ROOT_DIR = Path(__file__).resolve().parents[2]
OUT = ROOT_DIR / ".cache" / "buildings" / "footprints.json"

_spec = importlib.util.spec_from_file_location(
    "trees", ROOT_DIR / "scripts" / "trees" / "build_trees.py"
)
trees = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(trees)
terrain = trees.terrain

# Share of a footprint's samples under its height.
PERCENTILE = 0.75
# Lower than this, there's no building there in the lidar (demolished, or
# not built yet), metres.
MIN_HEIGHT = 2.0
# Footprints covering fewer samples (4m² each) than this are left out.
MIN_SAMPLES = 2


def footprints():
    """(OSM id, ring in lon/lat) for every building way and multipolygon outer."""
    found = []
    for element in terrain.osm_elements("osm_buildings", terrain.OSM_BUILDINGS_QUERY):
        points = [(p["lon"], p["lat"]) for p in element.get("geometry", [])]
        if element["type"] == "way" and len(points) >= 4 and points[0] == points[-1]:
            found.append((element["id"], points[:-1]))
    for element in terrain.osm_elements("osm_building_relations", trees.OSM_BUILDING_RELATIONS_QUERY):
        ways = [
            [(p["lon"], p["lat"]) for p in member["geometry"]]
            for member in element.get("members", [])
            if member["type"] == "way" and member.get("role") == "outer" and member.get("geometry")
        ]
        for ring in terrain.stitch(ways):
            if len(ring) >= 4 and ring[0] == ring[-1]:
                found.append((element["id"], ring[:-1]))
    return found


def main():
    shapes = footprints()
    # One projection call for every point.
    lons = [x for _, ring in shapes for x, _ in ring]
    lats = [y for _, ring in shapes for _, y in ring]
    es, ns = transform(CRS.from_epsg(4326), CRS.from_epsg(2193), lons, lats)
    es, ns = np.array(es), np.array(ns)
    print(f"  {len(shapes)} footprints")

    rw, _, _, rn = terrain.root_bounds()
    size = terrain.tile_size(trees.TILE_LEVEL)
    land = set(trees.tiles())
    by_tile = defaultdict(list)
    start = 0
    for osm_id, ring in shapes:
        end = start + len(ring)
        e, n = es[start:end], ns[start:end]
        start = end
        tile = (int((e.mean() - rw) // size), int((rn - n.mean()) // size))
        if tile in land:
            by_tile[tile].append((osm_id, e, n))

    grid, _, _ = trees.tree_grid()
    out = []
    for tx, ty in sorted(by_tile):
        chm, window = trees.chm_tile(tx, ty)
        buildings = by_tile[(tx, ty)]
        labels = rasterize(
            [
                ({"type": "Polygon", "coordinates": [list(zip(e, n))]}, k + 1)
                for k, (_, e, n) in enumerate(buildings)
            ],
            out_shape=chm.shape,
            transform=grid * Affine.translation(window[1].start, window[0].start),
            dtype=np.int32,
        )
        inside = labels > 0
        label, value = labels[inside], chm[inside]
        order = np.lexsort((value, label))
        label, value = label[order], value[order]
        ids, first, counts = np.unique(label, return_index=True, return_counts=True)
        heights = value[first + np.minimum((counts * PERCENTILE).astype(int), counts - 1)]
        for k, count, height in zip(ids, counts, heights):
            if count < MIN_SAMPLES or height < MIN_HEIGHT:
                continue
            osm_id, e, n = buildings[k - 1]
            ring = np.round(np.column_stack([e, n]).ravel(), 2).tolist()
            out.append([osm_id, round(float(height), 1), ring])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(
            {
                "attribution": "OpenStreetMap contributors (ODbL), from LINZ NZ Building Outlines; heights from LINZ LiDAR (CC BY 4.0)",
                "buildings": out,
            },
            f,
            separators=(",", ":"),
        )
    print(f"  {len(out)} with heights, {OUT.stat().st_size / 1e6:.1f}MB")


if __name__ == "__main__":
    main()
