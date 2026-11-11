"""
Heights for the OpenStreetMap building footprints over the terrain's level 5
region, for build_tiles.mjs to extrude where the council's 3D models stop
(Porirua, the Hutt, Wainuiomata).

New Zealand's OSM buildings are mostly LINZ's NZ Building Outlines,
imported. Each footprint's height is a high percentile of the lidar canopy
height model inside it (the trees build's, DSM less DEM at 2m): pitched
roofs come out between eaves and ridge, and the edge samples, which mix in
the ground around, count for little.

A footprint under a tree reads the tree: a garden shed under a 25m macrocarpa
came out a 25m pillar. So the lidar is believed only where the ground around
a footprint drops away from its roof, as a building's does and canopy over
it doesn't, and the footprint is no more slender than real towers are (or,
if it is, its tagged levels or a flat roof back the height up). Otherwise it
gets a guess for its size, or from its levels.

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
from scipy import ndimage

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
# The ring of samples just outside a footprint, this many wide (2m each).
RING = 2
# Share of the ring whose height is taken as the ground around it.
RING_PERCENTILE = 0.2
# A footprint is under canopy when the ground around it is this much of its
# height or more.
COVERED = 0.6
# Taller than this many times its width (√area), a footprint is suspect too:
# sheds under trees reach 11. Real towers reach 2.4, and are believed when
# their tagged levels allow the height, or their roof is flat: its low
# samples (a quarter of them) within this share of the height, over at least
# this many samples.
MAX_SLENDER = 2.5
FLAT_ROOF = 0.85
FLAT_SAMPLES = 12
# Storey and roof heights, m: a guess from building:levels, and the most a
# storey can be (CBD offices, with plant on the roof) for a height to agree
# with them.
STOREY = 3.2
ROOF = 1.5
MAX_STOREY = 4.5
MAX_ROOF = 6.0


def guess_height(area, levels):
    """A height for a footprint the lidar can't see, m."""
    if levels:
        return levels * STOREY + ROOF
    # Sheds and garages, then houses.
    return 2.6 if area < 40 else 3.2 if area < 80 else 6.0


def levels_of(tags):
    try:
        levels = float(tags.get("building:levels", ""))
    except ValueError:
        return None
    return levels if 0 < levels < 100 else None


def believed(height, low, count, ground, area, levels):
    """
    The footprint's height, or a guess when the lidar saw something else:
    `low` is its samples' lower quartile, `ground` the ring around it.
    """
    if height < MIN_HEIGHT or ground >= height * COVERED:
        return height if height < MIN_HEIGHT else guess_height(area, levels)
    if height <= MAX_SLENDER * np.sqrt(area):
        return height
    if levels:
        agrees = height <= levels * MAX_STOREY + MAX_ROOF
    else:
        agrees = count >= FLAT_SAMPLES and low >= height * FLAT_ROOF
    return height if agrees else guess_height(area, levels)


def footprints():
    """
    (OSM id, ring in lon/lat, levels or None) for every building way and
    multipolygon outer.
    """
    found = []
    for element in terrain.osm_elements("osm_buildings", terrain.OSM_BUILDINGS_QUERY):
        points = [(p["lon"], p["lat"]) for p in element.get("geometry", [])]
        if element["type"] == "way" and len(points) >= 4 and points[0] == points[-1]:
            found.append((element["id"], points[:-1], levels_of(element.get("tags", {}))))
    for element in terrain.osm_elements("osm_building_relations", trees.OSM_BUILDING_RELATIONS_QUERY):
        ways = [
            [(p["lon"], p["lat"]) for p in member["geometry"]]
            for member in element.get("members", [])
            if member["type"] == "way" and member.get("role") == "outer" and member.get("geometry")
        ]
        for ring in terrain.stitch(ways):
            if len(ring) >= 4 and ring[0] == ring[-1]:
                found.append((element["id"], ring[:-1], levels_of(element.get("tags", {}))))
    return found


def main():
    shapes = footprints()
    # One projection call for every point.
    lons = [x for _, ring, _ in shapes for x, _ in ring]
    lats = [y for _, ring, _ in shapes for _, y in ring]
    es, ns = transform(CRS.from_epsg(4326), CRS.from_epsg(2193), lons, lats)
    es, ns = np.array(es), np.array(ns)
    print(f"  {len(shapes)} footprints")

    rw, _, _, rn = terrain.root_bounds()
    size = terrain.tile_size(trees.TILE_LEVEL)
    land = set(trees.tiles())
    by_tile = defaultdict(list)
    start = 0
    for osm_id, ring, levels in shapes:
        end = start + len(ring)
        e, n = es[start:end], ns[start:end]
        start = end
        tile = (int((e.mean() - rw) // size), int((rn - n.mean()) // size))
        if tile in land:
            by_tile[tile].append((osm_id, e, n, levels))

    grid, _, _ = trees.tree_grid()
    out = []
    guessed = 0
    for tx, ty in sorted(by_tile):
        chm, window = trees.chm_tile(tx, ty)
        buildings = by_tile[(tx, ty)]
        labels = rasterize(
            [
                ({"type": "Polygon", "coordinates": [list(zip(e, n))]}, k + 1)
                for k, (_, e, n, _) in enumerate(buildings)
            ],
            out_shape=chm.shape,
            transform=grid * Affine.translation(window[1].start, window[0].start),
            dtype=np.int32,
        )
        inside = labels > 0
        ids, heights, counts = percentiles(labels, inside, chm, PERCENTILE)
        _, lows, _ = percentiles(labels, inside, chm, 0.25)
        # Each footprint's ring, outside every footprint; where rings meet,
        # the higher label's wins.
        around = ndimage.grey_dilation(labels, size=2 * RING + 1)
        around[inside] = 0
        ring_ids, grounds, _ = percentiles(around, around > 0, chm, RING_PERCENTILE)
        ground_of = dict(zip(ring_ids.tolist(), grounds.tolist()))
        for k, count, height, low in zip(ids, counts, heights, lows):
            if count < MIN_SAMPLES:
                continue
            osm_id, e, n, levels = buildings[k - 1]
            area = 0.5 * abs(np.dot(e, np.roll(n, 1)) - np.dot(n, np.roll(e, 1)))
            # A footprint ringed by others has no ground of its own to check.
            ground = ground_of.get(int(k), 0.0)
            height = float(height)
            seen = believed(height, float(low), int(count), ground, area, levels)
            if seen < MIN_HEIGHT:
                continue
            guessed += seen != height
            ring = np.round(np.column_stack([e, n]).ravel(), 2).tolist()
            out.append([osm_id, round(seen, 1), ring])

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
    print(f"  {len(out)} with heights ({guessed} guessed), {OUT.stat().st_size / 1e6:.1f}MB")


def percentiles(labels, where, values, share):
    """Each label's value at that share of its sorted samples: ids, values, counts."""
    label, value = labels[where], values[where]
    order = np.lexsort((value, label))
    label, value = label[order], value[order]
    ids, first, counts = np.unique(label, return_index=True, return_counts=True)
    return ids, value[first + np.minimum((counts * share).astype(int), counts - 1)], counts


if __name__ == "__main__":
    main()
