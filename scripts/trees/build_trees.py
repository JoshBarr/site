"""
Find the trees over the terrain's level 5 region (Porirua, the Hutt, the
city, Wainuiomata, the Mākara coast), for instancing in the scene.

Source: LINZ national 1m DSM (the surface, canopy and roofs included), less
the national 1m DEM: a canopy height model at 2m. Over the terrain's
high-detail core that's its level 7 mosaic and a cached DSM on the same grid;
elsewhere both are fetched a tile at a time, in parallel, and their
difference cached. Building footprints from OpenStreetMap (the terrain
build's cache) are cut out, and the scene's own towers, turbines and
lighthouses with the blades the lidar caught mid-turn, then each crown is a local maximum of the
smoothed canopy, its radius from the watershed around it.

Each tree's ground is the published terrain's under it, from the finest
level there, so trunks stand on the 8m terrain as well as the 2m.

Output (public/trees/):
  manifest.json        world frame, encoding, per-tile counts
  {x}/{y}.bin          one TILE_LEVEL tile's trees, in random order, so a
                       prefix is an even thinning of the whole tile

Also caches the canopy's cover on the terrain's land cover grid, which the
terrain's landcover step folds into its forest channel: far off, where the
trees thin out, the ground beneath reads as wooded.

Run the terrain build first (its mosaics and OSM caches are reused), then
its landcover step again after this.

Usage:
  .venv-terrain/bin/python -I scripts/trees/build_trees.py fetch
  .venv-terrain/bin/python -I scripts/trees/build_trees.py
  .venv-terrain/bin/python -I scripts/terrain/build_tiles.py landcover
"""

import importlib.util
import json
import re
import sys
from concurrent.futures import ProcessPoolExecutor
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
CHM_DIR = CACHE_DIR / "chm"
SITES_TS = ROOT_DIR / "src" / "components" / "scene" / "landmarks" / "sites.ts"

_spec = importlib.util.spec_from_file_location(
    "terrain", ROOT_DIR / "scripts" / "terrain" / "build_tiles.py"
)
terrain = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(terrain)

CRS_NZTM = rasterio.crs.CRS.from_epsg(2193)
DSM_SOURCE = "https://nz-elevation.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dsm_1m/2193"
# The terrain's finest level: 2m samples over the core.
LEVEL = terrain.MAX_LEVEL
# Trees cover this level's region, on LEVEL's sample grid.
REGION_LEVEL = 5
# Parallel tile fetches outside the core.
WORKERS = 6


def tree_grid():
    """
    Transform and shape of the 2m grid over REGION_LEVEL's region, sample for
    sample in line with the level 7 mosaic, and the mosaic's (row, col) in it.
    """
    x0, x1, y0, y1 = terrain.level_tile_range(REGION_LEVEL)
    shift = LEVEL - REGION_LEVEL
    res = terrain.resolution(LEVEL)
    size = terrain.tile_size(LEVEL)
    rw, _, _, rn = terrain.root_bounds()
    west = rw + (x0 << shift) * size - terrain.APRON * res - res / 2
    north = rn - (y0 << shift) * size + terrain.APRON * res + res / 2
    shape = (
        ((y1 - y0) << shift) * terrain.TILE_CELLS + 1 + 2 * terrain.APRON,
        ((x1 - x0) << shift) * terrain.TILE_CELLS + 1 + 2 * terrain.APRON,
    )
    cx0, _, cy0, _ = terrain.level_tile_range(LEVEL)
    core = (
        (cy0 - (y0 << shift)) * terrain.TILE_CELLS,
        (cx0 - (x0 << shift)) * terrain.TILE_CELLS,
    )
    return from_origin(west, north, res, res), shape, core


def open_sources(source, bounds):
    sources = []
    for name in terrain.sheets_for(bounds):
        try:
            sources.append(rasterio.open(f"{source}/{name}.tiff"))
            print(f"  source {name}")
        except rasterio.errors.RasterioIOError:
            pass
    return sources


def read_dsm():
    """The DSM on the level 7 mosaic's grid (NODATA where there's none)."""
    cache = CACHE_DIR / f"dsm_{LEVEL}.npy"
    if cache.exists():
        return np.load(cache, mmap_mode="r")
    grid, (rows, cols) = terrain.level_grid(LEVEL)
    res = grid.a
    west, north = grid.c, grid.f
    bounds = (west, north - rows * res, west + cols * res, north)
    with rasterio.Env(**terrain.GDAL_ENV):
        sources = open_sources(DSM_SOURCE, bounds)
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
# Cached canopy heights are in these steps, metres, as u16.
CHM_STEP = 0.01
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

# The scene draws these landmarks itself (src/components/scene/landmarks/),
# by their export in sites.ts: (footprint, rotor) radii in m. Everything is
# cleared over the footprint (with the turbines' towers and nacelles, the
# lidar caught the blades: tall "trees" in a ring out to the rotor's tips),
# and canopy taller than BLADE_CLEAR over the rotor's sweep.
LANDMARKS = {
    "WEST_WIND": (8.0, 41.2 + 6),
    "MILL_CREEK": (8.0, 41.2 + 6),
    "BROOKLYN": (8.0, 22.0 + 6),
    "KAUKAU": (12.0, 0),
    "MT_VICTORIA": (6.0, 0),
    "PENCARROW": (6.0, 0),
    "PENCARROW_LOWER": (6.0, 0),
    "BARING_HEAD": (6.0, 0),
    "POINT_HALSWELL": (6.0, 0),
}
# Blades are smoothed into the canopy much lower than they stand (their tips
# pass 27 m up at the lowest), metres.
BLADE_CLEAR = 12.0
# A blade is a line a sample or two wide, its edges lower: they're cleared
# this many samples out from it.
BLADE_GROW = 2

# Fractions of each tile's trees, cumulative, stored as separate files: a
# distant tile only fetches the first.
BANDS = [1 / 64, 1 / 16, 1 / 4, 1]

# Height and radius steps for the packed u8s, metres.
HEIGHT_STEP = 0.25
RADIUS_STEP = 0.1


def canopy_height(dem, dsm):
    """Surface above ground, metres; 0 over sea, gaps and anything too tall."""
    land = (dem > 0.3) & (dsm != terrain.NODATA) & (dem != terrain.NODATA)
    chm = np.where(land, dsm - dem, 0).astype(np.float32)
    chm[(chm > MAX_HEIGHT) | (chm < 0)] = 0
    return chm


def landmark_sites():
    """(easting, northing, footprint, rotor) for each landmark in LANDMARKS."""
    sites = []
    for name, body in re.findall(r"export const (\w+)[^=]*= (\[.*?\]);", SITES_TS.read_text(), re.S):
        if name not in LANDMARKS:
            continue
        for e, n in re.findall(r"\[\s*([\d.]+),\s*([\d.]+),\s*-?[\d.]+\s*\]", body):
            sites.append((float(e), float(n), *LANDMARKS[name]))
    missing = set(LANDMARKS) - set(re.findall(r"export const (\w+)", SITES_TS.read_text()))
    if missing:
        raise SystemExit(f"no sites for {sorted(missing)} in {SITES_TS}")
    return sites


def clear_landmarks(chm, window, grid, sites):
    """Zero the canopy at the landmarks in a window of the tree grid, in place."""
    res = grid.a
    for east, north, footprint, rotor in sites:
        reach = max(footprint, rotor)
        # Sample (r, c) is centred at west + (c + 0.5) * res.
        c = (east - grid.c) / res - 0.5 - window[1].start
        r = (grid.f - north) / res - 0.5 - window[0].start
        r0, r1 = max(int(r - reach / res), 0), min(int(r + reach / res) + 2, chm.shape[0])
        c0, c1 = max(int(c - reach / res), 0), min(int(c + reach / res) + 2, chm.shape[1])
        if r1 <= r0 or c1 <= c0:
            continue
        rr, cc = np.ogrid[r0:r1, c0:c1]
        distance = np.hypot(rr - r, cc - c) * res
        patch = chm[r0:r1, c0:c1]
        blade = (distance <= rotor) & (patch > BLADE_CLEAR)
        if blade.any():
            blade = ndimage.binary_dilation(blade, iterations=BLADE_GROW) & (distance <= rotor)
        patch[(distance <= footprint) | blade] = 0


def tiles():
    """TILE_LEVEL tiles over the region with any land, from the level 5 mosaic."""
    x0, x1, y0, y1 = terrain.level_tile_range(REGION_LEVEL)
    coarse = np.load(terrain.CACHE_DIR / f"mosaic_{REGION_LEVEL}.npy", mmap_mode="r")
    shift = TILE_LEVEL - REGION_LEVEL
    cells = terrain.TILE_CELLS >> shift
    found = []
    for ty in range(y0 << shift, y1 << shift):
        for tx in range(x0 << shift, x1 << shift):
            r = (ty - (y0 << shift)) * cells + terrain.APRON
            c = (tx - (x0 << shift)) * cells + terrain.APRON
            if (coarse[r : r + cells + 1, c : c + cells + 1] > 0.3).any():
                found.append((tx, ty))
    return found


def tile_window(tx, ty):
    """A tile and its margin on the tree grid, clipped, as (rows, cols) slices."""
    grid, (rows, cols), _ = tree_grid()
    west, north, size = tile_bounds(tx, ty)
    res = grid.a
    c0 = int(round((west - grid.c) / res)) - MARGIN
    r0 = int(round((grid.f - north) / res)) - MARGIN
    n = int(round(size / res)) + 2 * MARGIN
    return (
        slice(max(r0, 0), min(r0 + n, rows)),
        slice(max(c0, 0), min(c0 + n, cols)),
    )


def in_core(window):
    _, _, (cr, cc) = tree_grid()
    rows, cols = np.load(terrain.CACHE_DIR / f"mosaic_{LEVEL}.npy", mmap_mode="r").shape
    return (
        window[0].start >= cr and window[0].stop <= cr + rows
        and window[1].start >= cc and window[1].stop <= cc + cols
    )


def chm_path(tx, ty):
    return CHM_DIR / f"{tx}_{ty}.npy"


_core = None


def chm_tile(tx, ty):
    """Canopy heights over a tile and its margin, and the window they cover."""
    global _core
    window = tile_window(tx, ty)
    if in_core(window):
        if _core is None:
            _core = (
                np.load(terrain.CACHE_DIR / f"mosaic_{LEVEL}.npy", mmap_mode="r"),
                read_dsm(),
            )
        _, _, (cr, cc) = tree_grid()
        local = (
            slice(window[0].start - cr, window[0].stop - cr),
            slice(window[1].start - cc, window[1].stop - cc),
        )
        dem, dsm = _core
        return canopy_height(np.array(dem[local]), np.array(dsm[local])), window
    return np.load(chm_path(tx, ty)).astype(np.float32) * CHM_STEP, window


_sources = {}


def _fetch_tile(tile):
    """Worker: fetch one tile's DEM and DSM and cache their difference."""
    tx, ty = tile
    grid, _, _ = tree_grid()
    window = tile_window(tx, ty)
    res = grid.a
    west = grid.c + window[1].start * res
    north = grid.f - window[0].start * res
    rows = window[0].stop - window[0].start
    cols = window[1].stop - window[1].start
    bounds = (west, north - rows * res, west + cols * res, north)
    layers = []
    with rasterio.Env(**terrain.GDAL_ENV):
        for source in (terrain.SOURCE, DSM_SOURCE):
            datasets = []
            for name in terrain.sheets_for(bounds):
                key = (source, name)
                if key not in _sources:
                    try:
                        _sources[key] = rasterio.open(f"{source}/{name}.tiff")
                    except rasterio.errors.RasterioIOError:
                        _sources[key] = None
                if _sources[key] is not None:
                    datasets.append(_sources[key])
            if not datasets:
                return tile
            data, _ = merge(
                datasets, bounds=bounds, res=res, nodata=terrain.NODATA, resampling=Resampling.average
            )
            layers.append(data[0].astype(np.float32))
    assert layers[0].shape == (rows, cols), layers[0].shape
    chm = canopy_height(*layers)
    np.save(chm_path(tx, ty), np.round(chm / CHM_STEP).astype(np.uint16))
    return tile


def fetch():
    """Caches the core's DSM, then every other tile's canopy heights."""
    read_dsm()
    CHM_DIR.mkdir(parents=True, exist_ok=True)
    missing = [
        (tx, ty) for tx, ty in tiles()
        if not in_core(tile_window(tx, ty)) and not chm_path(tx, ty).exists()
    ]
    print(f"  fetching {len(missing)} tiles")
    with ProcessPoolExecutor(WORKERS) as pool:
        for done, _ in enumerate(pool.map(_fetch_tile, missing), 1):
            if done % 20 == 0 or done == len(missing):
                print(f"  {done}/{len(missing)}")


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


def crowns(chm, buildings):
    """
    Trees in a window: (row, col, height, radius) arrays, rows and cols as
    fractional samples (crown centroids).
    """
    smooth = ndimage.gaussian_filter(chm, 0.7)
    grown = ndimage.binary_dilation(buildings > 0, iterations=BUILDING_DILATE)
    vegetation = (chm > 0) & ~grown & (smooth >= MIN_HEIGHT)

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


def footprints(grid, shape):
    """
    1 where an OpenStreetMap building covers a grid sample. Multipolygon
    rings combine even-odd: they come in no particular order, so the first
    isn't necessarily the outer one (the terrain's mask fills a stadium's
    pitch and leaves its stands).
    """
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


def port_yards(grid, shape):
    """
    1 over port yards: stacked containers and log piles stand as tall as
    trees, and the scene has its own containers there.
    """
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


def terrain_ground(east, north):
    """
    The published terrain's height at each point: bilinear in the finest
    level's mosaic covering it, as the terrain's drawn. Sea samples count as
    0, as trees on the shore stand on land.
    """
    ground = np.full(len(east), np.nan, dtype=np.float32)
    for level in sorted({l for l, _ in terrain.REGIONS}, reverse=True):
        todo = np.isnan(ground)
        if not todo.any():
            break
        heights = np.load(terrain.CACHE_DIR / f"mosaic_{level}.npy", mmap_mode="r")
        grid, (rows, cols) = terrain.level_grid(level)
        # Sample centres: column c is at west + (c + 0.5) * res.
        u = (east[todo] - grid.c) / grid.a - 0.5
        v = (grid.f - north[todo]) / grid.a - 0.5
        inside = (u >= 0) & (u < cols - 1) & (v >= 0) & (v < rows - 1)
        i = np.floor(u[inside]).astype(int)
        j = np.floor(v[inside]).astype(int)
        fu = (u[inside] - i).astype(np.float32)
        fv = (v[inside] - j).astype(np.float32)

        def at(dj, di):
            return np.maximum(np.asarray(heights[j + dj, i + di], dtype=np.float32), 0)

        top = at(0, 0) * (1 - fu) + at(0, 1) * fu
        bottom = at(1, 0) * (1 - fu) + at(1, 1) * fu
        found = np.flatnonzero(todo)[inside]
        ground[found] = top * (1 - fv) + bottom * fv
    return ground


def build():
    fetch()
    grid, (rows, cols), _ = tree_grid()
    print(f"  footprints over {cols}x{rows}")
    built = footprints(grid, (rows, cols))
    built |= port_yards(grid, (rows, cols))
    sites = landmark_sites()
    print(f"  clearing {len(sites)} landmarks")
    canopy = np.zeros((rows, cols), dtype=np.uint8)
    res = grid.a
    # Sample centres: column c is at west + (c + 0.5) * res.
    west0, north0 = grid.c, grid.f

    found_tiles = []
    total_trees = 0
    total_bytes = 0
    row = None
    for tx, ty in sorted(tiles(), key=lambda t: (t[1], t[0])):
        if row is not None and ty != row:
            print(f"  row {row}: {total_trees} trees, {total_bytes / 1e6:.1f}MB")
        row = ty
        chm, window = chm_tile(tx, ty)
        clear_landmarks(chm, window, grid, sites)
        tile_built = built[window]
        west, north, size = tile_bounds(tx, ty)

        # Cover over the tile itself, for the land cover map: its samples
        # from the one on its north-west corner.
        n = int(size / res)
        r = int((north0 - north) / res)
        c = int((west - west0) / res)
        rs = slice(max(r, 0), min(r + n, rows))
        cs = slice(max(c, 0), min(c + n, cols))
        local = (
            slice(rs.start - window[0].start, rs.stop - window[0].start),
            slice(cs.start - window[1].start, cs.stop - window[1].start),
        )
        canopy[rs, cs] = (chm[local] >= MIN_HEIGHT) & (tile_built[local] == 0)

        found = crowns(chm, tile_built)
        if found is None:
            continue
        rws, col, height, radius = found
        east = west0 + (col + window[1].start + 0.5) * res
        south = north0 - (rws + window[0].start + 0.5) * res
        inside = (east >= west) & (east < west + size) & (south <= north) & (south > north - size)
        if not inside.any():
            continue
        east, south, height, radius = east[inside], south[inside], height[inside], radius[inside]
        ground = terrain_ground(east, south)

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
        found_tiles.append([
            tx, ty, count,
            round(float(ground.min()), 1), round(float(ground.max()), 1),
            round(float(height.max()), 1),
        ])
        total_trees += count
    print(f"  row {row}: {total_trees} trees, {total_bytes / 1e6:.1f}MB")

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
        "tiles": found_tiles,
    }
    with open(OUT_DIR / "manifest.json", "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    print(f"total {total_trees} trees, {len(found_tiles)} tiles, {total_bytes / 1e6:.1f}MB")
    del built
    canopy_cover(canopy, grid)


# Canopy is averaged to this many samples per side before resampling to the
# land cover grid, to keep the temporaries small.
COVER_BLOCK = 4


def canopy_cover(canopy, grid):
    """Share of each land cover texel under canopy, cached for the terrain's landcover step."""
    k = COVER_BLOCK
    rows, cols = (canopy.shape[0] // k) * k, (canopy.shape[1] // k) * k
    blocks = np.zeros((rows // k, cols // k), dtype=np.float32)
    # In strips: the whole region at once is a few GB of temporaries.
    for r0 in range(0, rows, 1024):
        strip = canopy[r0 : min(r0 + 1024, rows), :cols].astype(np.float32)
        blocks[r0 // k : (r0 + strip.shape[0]) // k] = strip.reshape(-1, k, cols // k, k).mean(axis=(1, 3))

    w, s, e, n = terrain.LANDCOVER_BOUNDS
    res = terrain.LANDCOVER_RES
    out = np.zeros((round((n - s) / res), round((e - w) / res)), dtype=np.float32)
    reproject(
        source=blocks,
        destination=out,
        src_transform=grid * Affine.scale(k),
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
        fetch()
        return
    build()


if __name__ == "__main__":
    main()
