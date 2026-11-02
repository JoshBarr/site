"""
Find the trees in the terrain's high-detail core, for instancing in the scene.

Source: LINZ national 1m DSM (the surface, canopy and roofs included), less
the terrain build's DEM mosaic at its finest level: a canopy height model at
2m. Building footprints from OpenStreetMap (the terrain build's cache) are
cut out, then each crown is a local maximum of the smoothed canopy, its
radius from the watershed around it.

Output (public/trees/):
  manifest.json        world frame, encoding, per-tile counts
  {x}/{y}.bin          one TILE_LEVEL tile's trees, in random order, so a
                       prefix is an even thinning of the whole tile

Also caches the canopy's cover on the terrain's land cover grid, which the
terrain's landcover step folds into its forest channel: far off, where the
trees thin out, the ground beneath reads as wooded.

Run the terrain build first (its level 7 mosaic and OSM caches are reused),
then its landcover step again after this.

Usage:
  .venv-terrain/bin/python -I scripts/trees/build_trees.py fetch
  .venv-terrain/bin/python -I scripts/trees/build_trees.py
  .venv-terrain/bin/python -I scripts/terrain/build_tiles.py landcover
"""

import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import MergeAlg, Resampling
from rasterio.features import rasterize
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import reproject
from rasterio.windows import from_bounds as window_from_bounds
from scipy import ndimage

ROOT_DIR = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT_DIR / "public" / "trees"
CACHE_DIR = ROOT_DIR / ".cache" / "trees"

_spec = importlib.util.spec_from_file_location(
    "terrain", ROOT_DIR / "scripts" / "terrain" / "build_tiles.py"
)
terrain = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(terrain)

CRS_NZTM = rasterio.crs.CRS.from_epsg(2193)
DSM_SOURCE = "https://nz-elevation.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dsm_1m/2193"
# The terrain's finest level: 2m samples over the core.
LEVEL = terrain.MAX_LEVEL


def open_dsm_sources(bounds):
    sources = []
    for name in terrain.sheets_for(bounds):
        try:
            sources.append(rasterio.open(f"{DSM_SOURCE}/{name}.tiff"))
            print(f"  source {name}")
        except rasterio.errors.RasterioIOError:
            pass
    return sources


def read_dsm():
    """The DSM on the DEM mosaic's grid (NODATA where there's none)."""
    cache = CACHE_DIR / f"dsm_{LEVEL}.npy"
    if cache.exists():
        return np.load(cache, mmap_mode="r")
    grid, (rows, cols) = terrain.level_grid(LEVEL)
    res = grid.a
    west, north = grid.c, grid.f
    bounds = (west, north - rows * res, west + cols * res, north)
    with rasterio.Env(**terrain.GDAL_ENV):
        sources = open_dsm_sources(bounds)
        print(f"  reading DSM {cols}x{rows} @ {res:g}m")
        data, _ = merge(
            sources,
            bounds=bounds,
            res=res,
            nodata=terrain.NODATA,
            resampling=Resampling.average,
        )
    dsm = data[0].astype(np.float32)
    assert dsm.shape == (rows, cols), dsm.shape
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.save(cache, dsm)
    return dsm


# Trees are cut into tiles of this terrain level (1024m).
TILE_LEVEL = 6
# Crowns are found over each tile plus this margin, in samples, so the
# watershed doesn't stop at the tile's edge.
MARGIN = 16

# Canopy lower than this is shrubs, hedges, cars and fences, metres. The
# terrain's surface shades scrub.
MIN_HEIGHT = 3.0
# Taller is a crane, mast or glitch.
MAX_HEIGHT = 60.0
# Footprints are grown by this many samples, so eaves and walls go too.
BUILDING_DILATE = 1
# Smallest crown kept, in samples (4m² each).
MIN_CROWN = 2
# Canopy is rough; roofs, bridges, decks and stacked containers are smooth.
# Mean absolute Laplacian over a crown's upper half (its edge is a drop
# whatever it is), metres per sample².
MIN_ROUGHNESS = 0.6
# A crown's peak must top everything within this many samples, by height:
# (up to height m, radius). Bigger trees stand further apart.
PEAK_RADII = [(8.0, 1), (20.0, 2), (MAX_HEIGHT, 3)]
# Crowns spread no wider than this for their height (radius, m).
MAX_SPREAD = 0.6
MAX_RADIUS = 15.0

# Fractions of each tile's trees, cumulative, stored as separate files: a
# distant tile only fetches the first.
BANDS = [1 / 64, 1 / 16, 1 / 4, 1]

# Height and radius steps for the packed u8s, metres.
HEIGHT_STEP = 0.25
RADIUS_STEP = 0.1


def peaks(smooth, vegetation):
    """Local maxima of the smoothed canopy, the search radius by height."""
    found = np.zeros(smooth.shape, dtype=bool)
    lower = 0.0
    for upper, radius in PEAK_RADII:
        y, x = np.ogrid[-radius : radius + 1, -radius : radius + 1]
        footprint = x * x + y * y <= radius * radius + 0.5
        top = ndimage.maximum_filter(smooth, footprint=footprint, mode="nearest")
        band = (smooth >= lower) & (smooth < upper)
        found |= band & (smooth >= top) & vegetation
        lower = upper
    # Plateaus give several equal maxima: one peak per connected group.
    return ndimage.label(found, structure=np.ones((3, 3)))


def crowns(dem, dsm, buildings):
    """
    Trees in a window: (row, col, height, radius) arrays, rows and cols as
    fractional samples (crown centroids).
    """
    land = (dem > 0.3) & (dsm != terrain.NODATA) & (dem != terrain.NODATA)
    chm = np.where(land, dsm - dem, 0).astype(np.float32)
    chm[chm > MAX_HEIGHT] = 0
    smooth = ndimage.gaussian_filter(chm, 0.7)
    grown = ndimage.binary_dilation(buildings > 0, iterations=BUILDING_DILATE)
    vegetation = land & ~grown & (smooth >= MIN_HEIGHT)

    markers, count = peaks(smooth, vegetation)
    if not count:
        return None

    # Grow each peak down over the canopy it tops. (A background marker
    # would flood in over the canopy's edges, which are just as deep.)
    depth = np.clip((MAX_HEIGHT - smooth) * 100, 0, 65535).astype(np.uint16)
    basins = ndimage.watershed_ift(depth, markers.astype(np.int32))
    basins[~vegetation] = 0

    index = np.arange(1, count + 1)
    area = ndimage.sum_labels(np.ones_like(chm), basins, index)
    height = ndimage.maximum(smooth, basins, index)
    upper = smooth >= np.concatenate([[np.inf], height])[basins] * 0.5
    rough = ndimage.mean(np.abs(ndimage.laplace(chm)), np.where(upper, basins, 0), index)
    centre = np.array(ndimage.center_of_mass(np.ones_like(chm), basins, index)).reshape(-1, 2)

    keep = (area >= MIN_CROWN) & (rough >= MIN_ROUGHNESS)
    radius = np.sqrt(area * 4 / np.pi)
    radius = np.minimum(radius, np.minimum(height * MAX_SPREAD + 1, MAX_RADIUS))
    return centre[keep, 0], centre[keep, 1], height[keep], radius[keep]


# The terrain build only fetched building ways; multipolygon buildings (the
# stadium's ring of stands, big sheds) are relations.
OSM_BUILDING_RELATIONS_QUERY = """
[out:json][timeout:300][bbox:{s},{w},{n},{e}];
relation["building"];
out geom qt;
"""


def building_relations():
    """Rings in NZTM for each multipolygon building."""
    shapes = []
    for element in terrain.osm_elements("osm_building_relations", OSM_BUILDING_RELATIONS_QUERY):
        ways = [
            [(p["lon"], p["lat"]) for p in member["geometry"]]
            for member in element.get("members", [])
            if member["type"] == "way" and member.get("geometry")
        ]
        rings = [terrain.to_nztm(r) for r in terrain.stitch(ways) if len(r) >= 4]
        if rings:
            shapes.append((terrain.BUILDING, rings))
    return shapes


def footprints(level):
    """
    1 where an OpenStreetMap building covers a level's sample. Multipolygon
    rings combine even-odd: they come in no particular order, so the first
    isn't necessarily the outer one (the terrain's mask fills a stadium's
    pitch and leaves its stands).
    """
    grid, shape = terrain.level_grid(level)
    mask = np.zeros(shape, dtype=np.uint8)
    simple = [
        ({"type": "Polygon", "coordinates": rings}, 1)
        for cls, rings in terrain.osm_shapes()
        if cls == terrain.BUILDING and len(rings) == 1
    ]
    rasterize(simple, out=mask, transform=grid)
    for cls, rings in terrain.osm_shapes() + building_relations():
        if cls != terrain.BUILDING or len(rings) == 1:
            continue
        w, s, e, n = (
            min(x for ring in rings for x, _ in ring),
            min(y for ring in rings for _, y in ring),
            max(x for ring in rings for x, _ in ring),
            max(y for ring in rings for _, y in ring),
        )
        window = window_from_bounds(w, s, e, n, grid).round_offsets().round_lengths()
        r0, c0 = max(window.row_off - 1, 0), max(window.col_off - 1, 0)
        r1 = min(window.row_off + window.height + 1, shape[0])
        c1 = min(window.col_off + window.width + 1, shape[1])
        if r1 <= r0 or c1 <= c0:
            continue
        count = rasterize(
            [({"type": "Polygon", "coordinates": [ring]}, 1) for ring in rings],
            out_shape=(r1 - r0, c1 - c0),
            transform=grid * Affine.translation(c0, r0),
            dtype=np.uint8,
            merge_alg=MergeAlg.add,
        )
        mask[r0:r1, c0:c1] |= (count % 2).astype(np.uint8)
    return mask


def port_yards(level):
    """
    1 over port yards: stacked containers and log piles stand as tall as
    trees, and the scene has its own containers there.
    """
    grid, shape = terrain.level_grid(level)
    mask = np.zeros(shape, dtype=np.uint8)
    yards = []
    for element in terrain.osm_elements("osm", terrain.OSM_QUERY):
        if element["type"] != "way" or element.get("tags", {}).get("industrial") != "port":
            continue
        points = [(p["lon"], p["lat"]) for p in element.get("geometry", [])]
        if len(points) >= 4 and points[0] == points[-1]:
            yards.append(({"type": "Polygon", "coordinates": [terrain.to_nztm(points)]}, 1))
    if yards:
        rasterize(yards, out=mask, transform=grid)
    return mask


def tile_bounds(tx, ty):
    """NZTM west and north edges, and size, of a TILE_LEVEL tile."""
    rw, _, _, rn = terrain.root_bounds()
    size = terrain.tile_size(TILE_LEVEL)
    return rw + tx * size, rn - ty * size, size


def build():
    dem = np.load(terrain.CACHE_DIR / f"mosaic_{LEVEL}.npy", mmap_mode="r")
    dsm = read_dsm()
    print("  footprints")
    built = footprints(LEVEL) | port_yards(LEVEL)
    grid, (rows, cols) = terrain.level_grid(LEVEL)
    res = grid.a
    # Sample centres: column c is at west + (c + 0.5) * res.
    west0, north0 = grid.c, grid.f

    x0, x1, y0, y1 = terrain.level_tile_range(LEVEL)
    shift = LEVEL - TILE_LEVEL
    tiles = []
    total_trees = 0
    total_bytes = 0
    for ty in range(y0 >> shift, ((y1 - 1) >> shift) + 1):
        for tx in range(x0 >> shift, ((x1 - 1) >> shift) + 1):
            west, north, size = tile_bounds(tx, ty)
            c0 = int(round((west - west0) / res)) - MARGIN
            r0 = int(round((north0 - north) / res)) - MARGIN
            n = int(round(size / res)) + 2 * MARGIN
            window = (
                slice(max(r0, 0), min(r0 + n, rows)),
                slice(max(c0, 0), min(c0 + n, cols)),
            )
            found = crowns(
                np.array(dem[window]), np.array(dsm[window]), built[window]
            )
            if found is None:
                continue
            row, col, height, radius = found
            east = west0 + (col + window[1].start + 0.5) * res
            south = north0 - (row + window[0].start + 0.5) * res
            inside = (east >= west) & (east < west + size) & (south <= north) & (south > north - size)
            if not inside.any():
                continue
            east, south, height, radius = east[inside], south[inside], height[inside], radius[inside]
            # Ground under each crown's centre, nearest sample.
            gr = np.clip(np.round((north0 - south) / res - 0.5).astype(int), 0, rows - 1)
            gc = np.clip(np.round((east - west0) / res - 0.5).astype(int), 0, cols - 1)
            ground = np.asarray(dem[gr, gc], dtype=np.float32)

            # Weighted random order (Efraimidis-Spirakis), by crown area: any
            # prefix is an even thinning that favours the big trees.
            rng = np.random.default_rng(tx * 7919 + ty)
            key = rng.random(len(east)) ** (1 / np.maximum(radius * radius, 0.1))
            order = np.argsort(-key)
            east, south, height, radius, ground = (
                a[order] for a in (east, south, height, radius, ground)
            )

            packed = np.empty((len(east), 4), dtype=np.uint16)
            packed[:, 0] = np.round((east - west) / size * 65535)
            packed[:, 1] = np.round((north - south) / size * 65535)
            packed[:, 2] = np.clip(np.round((ground + terrain.OFFSET) * terrain.SCALE), 0, 65535)
            h = np.clip(np.round(height / HEIGHT_STEP), 0, 255).astype(np.uint16)
            r = np.clip(np.round(radius / RADIUS_STEP), 0, 255).astype(np.uint16)
            packed[:, 3] = (h << 8) | r

            count = len(packed)
            start = 0
            for band, fraction in enumerate(BANDS):
                end = band_end(count, fraction)
                if end > start:
                    path = OUT_DIR / str(band) / str(tx) / f"{ty}.bin"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(packed[start:end].tobytes())
                    total_bytes += (end - start) * 8
                start = end
            tiles.append([
                tx, ty, count,
                round(float(ground.min()), 1), round(float(ground.max()), 1),
                round(float(height.max()), 1),
            ])
            total_trees += count
        print(f"  row {ty}: {total_trees} trees, {total_bytes / 1e6:.1f}MB")

    manifest = {
        "attribution": "LINZ LiDAR 1m DSM and DEM (CC BY 4.0)",
        "origin": list(terrain.ORIGIN),
        "rootSize": terrain.ROOT_SIZE,
        "level": TILE_LEVEL,
        "bands": BANDS,
        "encoding": {
            "ground": {"offset": terrain.OFFSET, "scale": terrain.SCALE},
            "heightStep": HEIGHT_STEP,
            "radiusStep": RADIUS_STEP,
        },
        # [x, y, count, minGround, maxGround, maxHeight]
        "tiles": tiles,
    }
    with open(OUT_DIR / "manifest.json", "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    print(f"total {total_trees} trees, {len(tiles)} tiles, {total_bytes / 1e6:.1f}MB")
    canopy_cover(dem, dsm, built)


def canopy_cover(dem, dsm, built):
    """
    Share of each land cover texel under canopy, cached for the terrain's
    landcover step. Zero outside the core.
    """
    rows, cols = dem.shape
    canopy = np.zeros((rows, cols), dtype=np.uint8)
    # In strips: the whole core at once is a few GB of temporaries.
    for r0 in range(0, rows, 1024):
        rs = slice(r0, min(r0 + 1024, rows))
        a = np.asarray(dem[rs], dtype=np.float32)
        b = np.asarray(dsm[rs], dtype=np.float32)
        land = (a > 0.3) & (a != terrain.NODATA) & (b != terrain.NODATA)
        height = np.where(land, b - a, 0)
        canopy[rs] = (height >= MIN_HEIGHT) & (height <= MAX_HEIGHT) & (built[rs] == 0)

    w, s, e, n = terrain.LANDCOVER_BOUNDS
    res = terrain.LANDCOVER_RES
    out = np.zeros((round((n - s) / res), round((e - w) / res)), dtype=np.float32)
    grid, _ = terrain.level_grid(LEVEL)
    reproject(
        source=canopy.astype(np.float32),
        destination=out,
        src_transform=grid,
        src_crs=CRS_NZTM,
        dst_transform=from_origin(w, n, res, res),
        dst_crs=CRS_NZTM,
        resampling=Resampling.average,
        src_nodata=None,
        dst_nodata=0,
    )
    np.save(CACHE_DIR / "canopy.npy", out)
    print(f"  canopy cover {out.shape[1]}x{out.shape[0]}, {out.mean():.1%} of the land cover map")


def band_end(count, fraction):
    """Index after a band's last tree. Must match the client."""
    return min(count, int(np.ceil(count * fraction)))


def main():
    if sys.argv[1:] == ["fetch"]:
        read_dsm()
        return
    build()


if __name__ == "__main__":
    main()
