"""
Build a quadtree of terrain height tiles for the homepage scene.

Source: LINZ national 1m DEM (Cloud-Optimised GeoTIFFs on the AWS open data
registry, LERC compressed). Reads only the overview levels needed for each
output resolution, so nothing large is downloaded.

Output (public/terrain/):
  manifest.json          world frame, encoding, per-level tile lists
  {z}/{x}/{y}.webp       lossless WebP, 259x259
  water.png              water depth over the whole root, for the ocean
  landcover.png          forest/scrub/urban cover over the level 5 region
  shore.png              signed distance to the shore around the harbour, for ships

Land cover: OpenStreetMap polygons (via Overpass, cached), painted most
general first so woods inside suburbs and parks inside towns win. Where the
trees build has cached lidar canopy cover (scripts/trees), forest is
whichever is more.

Sea floor: real bathymetry if BATHYMETRY points at a raster (e.g. NIWA's NZ
250m grid, elevations negative below sea level), ramped to 0 at the coast;
otherwise a synthetic shelf sloping away from the coast.

Tile layout: each tile has 256 cells / 257 samples per side, registered so the
first and last samples sit exactly on the tile edges (shared with neighbours),
plus a 1-sample apron on every side for computing normals = 259 samples.

Height encoding: q = round((h + OFFSET) * SCALE) as uint16, R = q >> 8,
G = q & 255. B = relief << 1 | building. Relief is 7 bits, 64 on level
ground, higher on ridges and spurs, lower in gullies and valleys, from the
height's difference to its surroundings at a few scales; computed over the
whole level, so it's seamless. Building is 1 where an OpenStreetMap footprint
covers the sample (levels BUILDINGS_MIN_LEVEL and up).

World frame: NZTM2000 (EPSG:2193) metres, origin at ORIGIN. In three.js,
x = E - E0, z = -(N - N0), y = height. Tile x increases east, tile y increases
south (row 0 is the northern edge of the root).

Usage:
  .venv-terrain/bin/python -I scripts/terrain/build_tiles.py [levels...]
  .venv-terrain/bin/python -I scripts/terrain/build_tiles.py fetch <levels...>
  .venv-terrain/bin/python -I scripts/terrain/build_tiles.py landcover
  .venv-terrain/bin/python -I scripts/terrain/build_tiles.py shore
  BATHYMETRY=~/Downloads/nz_bathy.tif .venv-terrain/bin/python -I ...
"""

import io
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.enums import MergeAlg, Resampling
from rasterio.features import rasterize
from rasterio.merge import merge
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform, transform_bounds
from rasterio.windows import from_bounds as window_from_bounds
from scipy import ndimage

ROOT_DIR = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT_DIR / "public" / "terrain"
CACHE_DIR = ROOT_DIR / ".cache" / "terrain"

SOURCE = "https://nz-elevation.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193"
NODATA = -9999.0

# Te Aro. Root tile is centred here.
ORIGIN = (1748000.0, 5428000.0)
ROOT_SIZE = 65536.0
TILE_CELLS = 256
APRON = 1
TILE_SAMPLES = TILE_CELLS + 1 + 2 * APRON

# Covers -1000m (Cook Strait) to +1048m at 3cm steps.
OFFSET = 1000.0
SCALE = 32.0

# Highest level available inside each region (NZTM bounds: west, south, east, north).
# Levels 0..4 always cover the whole root.
RING_MAX_LEVEL = 4
REGIONS = [
    # level 5 (8m): Porirua, Hutt, Eastbourne, Mākara coast
    (5, (1724000.0, 5410000.0, 1772000.0, 5452000.0)),
    # level 6 (4m): West Wind -> Eastbourne, south coast -> Johnsonville
    (6, (1731000.0, 5418000.0, 1760000.0, 5440000.0)),
    # level 7 (2m): same core, for close-ups
    (7, (1731000.0, 5418000.0, 1760000.0, 5440000.0)),
]
MAX_LEVEL = max(level for level, _ in REGIONS)

BATHYMETRY = os.environ.get("BATHYMETRY")

# Synthetic sea floor, used where there's no bathymetry: slopes down away from
# the coast.
SHELF_SLOPE = 0.04
SHELF_MAX_DEPTH = 30.0
# Bathymetry grids are too coarse to resolve the shore, so depth is capped by
# a ramp up to 0 at the coastline.
COAST_SLOPE = 0.08
# Port waters are dredged, and wharves and seawalls drop straight to that depth
# rather than ramping like a beach. (depth m, NZTM polygon [E, N]...) Edges
# on the shore run over land, so no sliver of sea between counts as open water.
DREDGED = [
    # Thorndon container wharf, Aotea Quay, Interislander terminal.
    (12.0, [(1749500, 5430300), (1750300, 5431100), (1750800, 5430900), (1750500, 5427800), (1749700, 5427800), (1749700, 5428600)]),
    # Kings, Queens and Glasgow wharves, Waterloo Quay.
    (10.0, [(1748950, 5428800), (1749450, 5428800), (1749450, 5428600), (1749750, 5428600), (1749750, 5427300), (1748950, 5427300)]),
]
# Depth per metre out from a wharf face.
WHARF_SLOPE = 1.0
# Dredged depth fades in over this distance from a polygon's edge in open
# water, so the edge doesn't step the floor.
DREDGED_FEATHER = 200.0
# Sea-only tiles are kept while their floor might be seen through the water.
SEABED_VISIBLE = 60.0

# Topo50 sheet grid (24km x 36km), used to pick which source COGs to open.
SHEET_ROWS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
SHEET_W = 24000.0
SHEET_H = 36000.0
BQ31_LEFT, BQ31_TOP = 1732000.0, 5442000.0

GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    GDAL_HTTP_MULTIRANGE="YES",
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES",
    VSI_CACHE="TRUE",
    VSI_CACHE_SIZE=str(256 * 1024 * 1024),
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tiff",
)


def root_bounds():
    half = ROOT_SIZE / 2
    return (ORIGIN[0] - half, ORIGIN[1] - half, ORIGIN[0] + half, ORIGIN[1] + half)


def resolution(level):
    return ROOT_SIZE / (TILE_CELLS * 2**level)


def tile_size(level):
    return ROOT_SIZE / 2**level


def sheet_name(col_left, row_top):
    """Topo50 sheet code for the sheet whose top-left corner is given."""
    col = 31 + round((col_left - BQ31_LEFT) / SHEET_W)
    row = SHEET_ROWS.index("Q") + round((BQ31_TOP - row_top) / SHEET_H)
    return f"B{SHEET_ROWS[row]}{col:02d}"


def sheets_for(bounds):
    w, s, e, n = bounds
    first_left = BQ31_LEFT + np.floor((w - BQ31_LEFT) / SHEET_W) * SHEET_W
    first_top = BQ31_TOP + np.ceil((n - BQ31_TOP) / SHEET_H) * SHEET_H
    names = []
    left = first_left
    while left < e:
        top = first_top
        while top > s:
            names.append(sheet_name(left, top))
            top -= SHEET_H
        left += SHEET_W
    return names


def open_sources(bounds):
    sources = []
    for name in sheets_for(bounds):
        try:
            sources.append(rasterio.open(f"{SOURCE}/{name}.tiff"))
            print(f"  source {name}")
        except rasterio.errors.RasterioIOError:
            # No sheet: open sea.
            pass
    return sources


def level_tile_range(level):
    """Inclusive-exclusive tile index ranges (x0, x1, y0, y1) for a level."""
    n = 2**level
    if level <= RING_MAX_LEVEL:
        return 0, n, 0, n

    region = next(b for l, b in REGIONS if l == level)
    rw, rs, re_, rn = root_bounds()
    size = tile_size(level)
    w, s, e, nn = region
    x0 = int(np.floor((w - rw) / size))
    x1 = int(np.ceil((e - rw) / size))
    y0 = int(np.floor((rn - nn) / size))
    y1 = int(np.ceil((rn - s) / size))
    return max(x0, 0), min(x1, n), max(y0, 0), min(y1, n)


def read_raw(level, sources):
    """
    Read heights for every tile in a level as one array whose pixel centres
    sit on the level's sample grid, including the outer apron. Sea and gaps
    are NODATA. Cached, since this is the slow, network-bound part.
    """
    cache = CACHE_DIR / f"mosaic_{level}.npy"
    x0, x1, y0, y1 = level_tile_range(level)
    res = resolution(level)
    size = tile_size(level)
    rw, _, _, rn = root_bounds()

    # Sample i of the mosaic is centred at west + i * res.
    west = rw + x0 * size - APRON * res
    north = rn - y0 * size + APRON * res
    width = (x1 - x0) * TILE_CELLS + 1 + 2 * APRON
    height = (y1 - y0) * TILE_CELLS + 1 + 2 * APRON

    if cache.exists():
        return np.load(cache, mmap_mode="r"), (x0, x1, y0, y1)

    # Pixel areas extend half a pixel beyond the centres.
    bounds = (
        west - res / 2,
        north - (height - 0.5) * res,
        west + (width - 0.5) * res,
        north + res / 2,
    )
    print(f"  reading {width}x{height} @ {res:g}m")
    data, _ = merge(
        sources,
        bounds=bounds,
        res=res,
        nodata=NODATA,
        resampling=Resampling.average,
    )
    heights = data[0].astype(np.float32)
    assert heights.shape == (height, width), heights.shape

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.save(cache, heights)
    return heights, (x0, x1, y0, y1)


def level_grid(level):
    """Transform and shape of a level's sample grid (pixel-is-area)."""
    x0, x1, y0, y1 = level_tile_range(level)
    res = resolution(level)
    size = tile_size(level)
    rw, _, _, rn = root_bounds()
    west = rw + x0 * size - APRON * res - res / 2
    north = rn - y0 * size + APRON * res + res / 2
    shape = (
        (y1 - y0) * TILE_CELLS + 1 + 2 * APRON,
        (x1 - x0) * TILE_CELLS + 1 + 2 * APRON,
    )
    return from_origin(west, north, res, res), shape


_bathymetry = None


def bathymetry():
    """
    The bathymetry around the root in its own CRS, with every cell that isn't
    sea (coastal cells flagged as land, nodata) filled from the nearest sea
    cell. Coarse grids put land cells over near-shore water; without the fill
    the floor would step where those cells end.
    """
    global _bathymetry
    if _bathymetry is None:
        margin = 10000
        w, s, e, n = root_bounds()
        with rasterio.open(os.path.expanduser(BATHYMETRY)) as src:
            bounds = transform_bounds(
                CRS.from_epsg(2193), src.crs, w - margin, s - margin, e + margin, n + margin
            )
            window = window_from_bounds(*bounds, src.transform).round_offsets().round_lengths()
            elevation = src.read(1, window=window, masked=True).filled(np.nan)
            transform = src.window_transform(window)
            crs = src.crs
        sea = np.isfinite(elevation) & (elevation < -0.5)
        _, (rows, cols) = ndimage.distance_transform_edt(~sea, return_indices=True)
        _bathymetry = (elevation[rows, cols].astype(np.float32), transform, crs)
    return _bathymetry


def read_depth(level):
    """Bathymetry resampled to a level's grid, as positive depth, or None."""
    if not BATHYMETRY:
        return None
    elevation, src_transform, src_crs = bathymetry()
    transform, shape = level_grid(level)
    out = np.full(shape, np.nan, dtype=np.float32)
    reproject(
        source=elevation,
        destination=out,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=transform,
        dst_crs=CRS.from_epsg(2193),
        dst_nodata=np.nan,
        resampling=Resampling.cubic_spline,
    )
    return -out


def read_mosaic(level, sources):
    raw, extent = read_raw(level, sources)
    return fill_sea(np.array(raw), resolution(level), read_depth(level), dredged(level)), extent


def dredged(level):
    """Dredged depth on a level's grid, 0 outside the DREDGED polygons."""
    transform, shape = level_grid(level)
    out = np.zeros(shape, dtype=np.float32)
    for depth, polygon in DREDGED:
        inside = rasterize(
            [({"type": "Polygon", "coordinates": [polygon + polygon[:1]]}, 1)],
            out_shape=shape,
            transform=transform,
            dtype=np.uint8,
        ).astype(bool)
        out[inside] = np.maximum(out[inside], depth)
    return out


def fill_sea(heights, res, depth=None, dredged=None):
    """
    Replace sea (and gaps) with a sea floor. `depth` is positive metres;
    `dredged` is a minimum depth reached WHARF_SLOPE out from the shore.
    """
    # Some surveys record the water surface just below 0 rather than nodata.
    sea = (heights == NODATA) | ~np.isfinite(heights) | (heights < 0)
    if not sea.any():
        return heights
    distance = ndimage.distance_transform_edt(sea).astype(np.float32) * res
    floor = np.minimum(distance * SHELF_SLOPE, SHELF_MAX_DEPTH)
    if depth is not None:
        known = np.isfinite(depth) & (depth > 0)
        floor = np.where(known, np.minimum(depth, distance * COAST_SLOPE), floor)
    if dredged is not None and dredged.any():
        # Fade in from the polygons' edges out in open water, not those on land.
        open_water = sea & (dredged == 0)
        weight = np.clip(ndimage.distance_transform_edt(~open_water) * res / DREDGED_FEATHER, 0, 1)
        floor = np.maximum(floor, np.minimum(dredged * weight, distance * WHARF_SLOPE))
    heights[sea] = -floor[sea]
    return heights


# Relief: (scale in metres, height difference that saturates, weight).
# Scales finer than a level's cells drop out of that level.
RELIEF_SCALES = [(12.0, 2.0, 0.3), (50.0, 6.0, 0.4), (200.0, 25.0, 0.3)]


def blur(a, sigma):
    """Gaussian blur; wide ones run on a reduced copy and are upsampled."""
    factor = int(sigma // 3)
    if factor < 2:
        return ndimage.gaussian_filter(a, sigma, mode="nearest")
    rows = -(-a.shape[0] // factor) * factor
    cols = -(-a.shape[1] // factor) * factor
    padded = np.pad(a, ((0, rows - a.shape[0]), (0, cols - a.shape[1])), mode="edge")
    small = padded.reshape(rows // factor, factor, cols // factor, factor).mean(axis=(1, 3))
    small = ndimage.gaussian_filter(small, sigma / factor, mode="nearest")

    # Linear upsampling, one axis at a time. Block k is centred on full-res
    # index k * factor + (factor - 1) / 2.
    def upsample(b, n, axis):
        p = (np.arange(n) - (factor - 1) / 2) / factor
        i0 = np.clip(np.floor(p).astype(int), 0, b.shape[axis] - 2)
        w = np.clip(p - i0, 0, 1).astype(np.float32)
        shape = [1, 1]
        shape[axis] = n
        w = w.reshape(shape)
        return np.take(b, i0, axis=axis) * (1 - w) + np.take(b, i0 + 1, axis=axis) * w

    return upsample(upsample(small, a.shape[0], 0), a.shape[1], 1).astype(np.float32)


def relief(heights, res):
    """0..1, 0.5 on level ground. Sea is level."""
    land = np.maximum(heights, 0).astype(np.float32)
    total = np.zeros_like(land)
    for scale, saturate, weight in RELIEF_SCALES:
        sigma = scale / res
        if sigma < 0.7:
            continue
        total += weight * np.tanh((land - blur(land, sigma)) / saturate)
    return np.clip(0.5 + 0.5 * total, 0, 1)


def encode(tile, relief_tile, building_tile):
    q = np.clip(np.round((tile + OFFSET) * SCALE), 0, 65535).astype(np.uint16)
    rgb = np.dstack(
        [
            (q >> 8).astype(np.uint8),
            (q & 255).astype(np.uint8),
            (np.round(relief_tile * 127).astype(np.uint8) << 1) | building_tile,
        ]
    )
    buf = io.BytesIO()
    # Higher effort settings take 50x longer for no size gain on height data.
    Image.fromarray(rgb, "RGB").save(buf, "WEBP", lossless=True, quality=100, method=2)
    return buf.getvalue()


def build_level(level, sources):
    heights, (x0, x1, y0, y1) = read_mosaic(level, sources)
    shading = relief(heights, resolution(level))
    built = buildings(level)
    tiles = []
    total = 0
    for ty in range(y0, y1):
        for tx in range(x0, x1):
            r = (ty - y0) * TILE_CELLS
            c = (tx - x0) * TILE_CELLS
            tile = heights[r : r + TILE_SAMPLES, c : c + TILE_SAMPLES]
            # Skip open water too deep for its floor to show.
            if tile.max() <= -SEABED_VISIBLE:
                continue
            window = (slice(r, r + TILE_SAMPLES), slice(c, c + TILE_SAMPLES))
            data = encode(tile, shading[window], built[window])
            path = OUT_DIR / str(level) / str(tx) / f"{ty}.webp"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            tiles.append([tx, ty, float(tile.min()), float(tile.max())])
            total += len(data)
    print(f"  level {level}: {len(tiles)} tiles, {total / 1e6:.1f}MB")
    return {
        "level": level,
        "resolution": resolution(level),
        "range": [x0, x1, y0, y1],
        # [x, y, minHeight, maxHeight]: heights let the client build tight
        # bounding boxes for culling and LOD.
        "tiles": tiles,
    }, total


WATER_SIZE = 2048
WATER_MAX_DEPTH = 400.0


def build_water(sources):
    """
    Water depth over the root at 32m, 8-bit, square-root encoded so the
    shallows keep precision: depth = (v / 255)² * WATER_MAX_DEPTH. 0 is land.
    Texel j is centred near root west + (j + 0.5) * 32m (within 8m: it's
    averaged from 16m samples).
    """
    heights, _ = read_mosaic(RING_MAX_LEVEL, sources)
    step = (heights.shape[0] - 2 * APRON - 1) // WATER_SIZE
    inner = heights[APRON : APRON + WATER_SIZE * step, APRON : APRON + WATER_SIZE * step]
    # Mean over the block's sea only: averaging land in as 0 would shoal the
    # water off wharves and seawalls.
    sea = (inner < 0).reshape(WATER_SIZE, step, WATER_SIZE, step).sum(axis=(1, 3))
    total = np.minimum(inner, 0).reshape(WATER_SIZE, step, WATER_SIZE, step).sum(axis=(1, 3))
    blocks = total / np.maximum(sea, 1)
    depth = np.sqrt(np.clip(-blocks / WATER_MAX_DEPTH, 0, 1))
    Image.fromarray(np.round(depth * 255).astype(np.uint8), "L").save(
        OUT_DIR / "water.png", optimize=True
    )
    print(f"  water.png {(OUT_DIR / 'water.png').stat().st_size / 1e6:.1f}MB")


# Over the harbour's AIS area (src/lib/openwaters.ts) with a margin: ships
# are kept off land with it. [west, south, east, north]
SHORE_BOUNDS = (1744000.0, 5414000.0, 1764000.0, 5440000.0)
SHORE_LEVEL = 6
SHORE_RES = 8.0
# Metres per step: ±64m, as far as ships need pushing off land.
SHORE_UNIT = 0.5


def build_shore(sources):
    """
    Signed distance to the shore, positive out to sea, 8-bit: distance =
    (v - 128) * SHORE_UNIT, saturating. Sample (i, j) is at the manifest's
    origin + (i * res east, j * res south). From SHORE_LEVEL's samples where
    it reaches, the level below's elsewhere, so the shore is the terrain's.
    """
    w, s, e, n = SHORE_BOUNDS

    def grid(level):
        raw, (x0, _, y0, _) = read_raw(level, sources)
        res = resolution(level)
        size = tile_size(level)
        rw, _, _, rn = root_bounds()
        return raw, res, rw + x0 * size - APRON * res, rn - y0 * size + APRON * res

    fine, res, fine_west, fine_north = grid(SHORE_LEVEL)
    coarse, coarse_res, coarse_west, coarse_north = grid(SHORE_LEVEL - 1)
    # On the fine level's sample grid.
    c0 = round((w - fine_west) / res)
    r0 = round((fine_north - n) / res)
    step = round(SHORE_RES / res)
    cols = round((e - w) / SHORE_RES) * step + 1
    rows = round((n - s) / SHORE_RES) * step + 1
    cs = np.arange(c0, c0 + cols)
    rs = np.arange(r0, r0 + rows)

    def take(heights, rows_at, cols_at):
        r = np.clip(rows_at, 0, heights.shape[0] - 1)
        c = np.clip(cols_at, 0, heights.shape[1] - 1)
        return np.asarray(heights[np.ix_(r, c)])

    east = fine_west + cs * res
    north = fine_north - rs * res
    heights = take(
        coarse,
        np.round((coarse_north - north) / coarse_res).astype(int),
        np.round((east - coarse_west) / coarse_res).astype(int),
    )
    inside = (rs >= 0) & (rs < fine.shape[0]), (cs >= 0) & (cs < fine.shape[1])
    heights[np.ix_(*inside)] = take(fine, rs[inside[0]], cs[inside[1]])

    # As fill_sea: what it floors is sea.
    sea = (heights == NODATA) | ~np.isfinite(heights) | (heights < 0)
    # The shore is halfway between a land sample and a sea one.
    distance = np.where(
        sea,
        ndimage.distance_transform_edt(sea) * res - res / 2,
        res / 2 - ndimage.distance_transform_edt(~sea) * res,
    )[::step, ::step]
    values = np.clip(np.round(distance / SHORE_UNIT) + 128, 0, 255).astype(np.uint8)
    Image.fromarray(values, "L").save(OUT_DIR / "shore.png", optimize=True)
    print(f"  shore.png {values.shape[1]}x{values.shape[0]} {(OUT_DIR / 'shore.png').stat().st_size / 1e6:.1f}MB")
    return {
        "origin": [float(east[0]), float(north[0])],
        "resolution": SHORE_RES,
        "size": [values.shape[1], values.shape[0]],
        "unit": SHORE_UNIT,
    }


LANDCOVER_BOUNDS = next(b for l, b in REGIONS if l == 5)
LANDCOVER_RES = 23.4375
# Painted at this many sub-pixels per side, then averaged into fractions.
LANDCOVER_SUPERSAMPLE = 4
OSM_QUERY = """
[out:json][timeout:300][bbox:{s},{w},{n},{e}];
(
  nwr["natural"~"^(wood|scrub|heath|grassland|bare_rock|scree|sand|beach|shingle|wetland)$"];
  nwr["landuse"~"^(forest|meadow|farmland|grass|residential|commercial|industrial|retail|railway|cemetery|quarry|construction|recreation_ground|brownfield)$"];
  nwr["leisure"~"^(park|golf_course|pitch)$"];
  nwr["aeroway"="aerodrome"];
);
out geom qt;
"""
# Fetched separately: footprints mark the city as built-up where landuse
# isn't tagged, and there are a lot of them.
OSM_BUILDINGS_QUERY = """
[out:json][timeout:600][bbox:{s},{w},{n},{e}];
way["building"];
out geom qt;
"""

# Painted in this order, later over earlier. 0 is untagged. Buildings go
# over everything: a house in a park is still a house.
GRASS, URBAN, SCRUB, FOREST, BARE, BUILDING = 1, 2, 3, 4, 5, 6
PAINT_ORDER = [URBAN, GRASS, SCRUB, FOREST, BARE, BUILDING]
LANDCOVER_CHANNELS = [(FOREST,), (SCRUB,), (URBAN, BUILDING)]


def osm_class(tags):
    natural = tags.get("natural")
    landuse = tags.get("landuse")
    if natural in ("wood",) or landuse == "forest":
        return FOREST
    if natural in ("scrub", "heath", "wetland"):
        return SCRUB
    if natural in ("bare_rock", "scree", "sand", "beach", "shingle") or landuse == "quarry":
        return BARE
    if tags.get("building"):
        return BUILDING
    if landuse in ("residential", "commercial", "industrial", "retail", "railway",
                   "construction", "brownfield") or tags.get("aeroway"):
        return URBAN
    return GRASS


def osm_elements(name, query):
    cache = CACHE_DIR / f"{name}.json"
    if not cache.exists():
        w, s, e, n = transform_bounds(CRS.from_epsg(2193), CRS.from_epsg(4326), *LANDCOVER_BOUNDS)
        query = query.format(w=w, s=s, e=e, n=n)
        print(f"  fetching OpenStreetMap {name}")
        request = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=urllib.parse.urlencode({"data": query}).encode(),
            headers={"User-Agent": "joshbarr.com terrain build"},
        )
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(request, timeout=600) as response:
            cache.write_bytes(response.read())
    return json.loads(cache.read_text())["elements"]


def stitch(ways):
    """Join member ways that share end points into rings."""
    pending = [w for w in ways if len(w) >= 2]
    rings = []
    while pending:
        ring = list(pending.pop())
        while ring[0] != ring[-1]:
            for i, way in enumerate(pending):
                if way[0] == ring[-1]:
                    ring += way[1:]
                elif way[-1] == ring[-1]:
                    ring += way[-2::-1]
                elif way[-1] == ring[0]:
                    ring = way[:-1] + ring
                elif way[0] == ring[0]:
                    ring = way[:0:-1] + ring
                else:
                    continue
                pending.pop(i)
                break
            else:
                # Clipped or broken: rasterising closes it anyway.
                break
        rings.append(ring)
    return rings


def to_nztm(points):
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    xs, ys = transform(CRS.from_epsg(4326), CRS.from_epsg(2193), lons, lats)
    return list(zip(xs, ys))


_osm_shapes = None


def osm_shapes():
    """(class, rings in NZTM) for every area. Rings combine even-odd."""
    global _osm_shapes
    if _osm_shapes is not None:
        return _osm_shapes
    shapes = []
    elements = osm_elements("osm", OSM_QUERY) + osm_elements("osm_buildings", OSM_BUILDINGS_QUERY)
    for element in elements:
        tags = element.get("tags", {})
        if element["type"] == "way":
            points = [(p["lon"], p["lat"]) for p in element.get("geometry", [])]
            if len(points) >= 4 and points[0] == points[-1]:
                shapes.append((osm_class(tags), [to_nztm(points)]))
        elif element["type"] == "relation" and tags.get("type") == "multipolygon":
            ways = [
                [(p["lon"], p["lat"]) for p in member["geometry"]]
                for member in element.get("members", [])
                if member["type"] == "way" and member.get("geometry")
            ]
            rings = [to_nztm(r) for r in stitch(ways) if len(r) >= 4]
            if rings:
                shapes.append((osm_class(tags), rings))
    _osm_shapes = shapes
    return shapes


# Finer than this (8m) a footprint is a speck; the land cover map covers it.
BUILDINGS_MIN_LEVEL = 5


def buildings(level):
    """1 where a building footprint covers a level's sample, else 0."""
    transform, shape = level_grid(level)
    if level < BUILDINGS_MIN_LEVEL:
        return np.zeros(shape, dtype=np.uint8)
    footprints = [
        ({"type": "Polygon", "coordinates": rings}, 1)
        for cls, rings in osm_shapes()
        if cls == BUILDING
    ]
    return rasterize(footprints, out_shape=shape, transform=transform, dtype=np.uint8)


def build_landcover():
    """
    Fractions of forest, scrub and urban cover (R, G, B) over the level 5
    region. Row 0 is the northern edge. Untagged and grassy land is black.
    """
    w, s, e, n = LANDCOVER_BOUNDS
    sub = LANDCOVER_RES / LANDCOVER_SUPERSAMPLE
    cols = round((e - w) / sub)
    rows = round((n - s) / sub)
    grid = from_origin(w, n, sub, sub)
    classes = np.zeros((rows, cols), dtype=np.uint8)

    shapes = osm_shapes()
    print(f"  {len(shapes)} areas")
    for cls in PAINT_ORDER:
        simple = [
            ({"type": "Polygon", "coordinates": rings}, 1)
            for c, rings in shapes
            if c == cls and len(rings) == 1
        ]
        if simple:
            mask = rasterize(simple, out_shape=classes.shape, transform=grid, dtype=np.uint8)
            classes[mask > 0] = cls
        # Multipolygons: count how many rings cover each pixel; odd is inside.
        for c, rings in shapes:
            if c != cls or len(rings) == 1:
                continue
            count = rasterize(
                [({"type": "Polygon", "coordinates": [ring]}, 1) for ring in rings],
                out_shape=classes.shape,
                transform=grid,
                dtype=np.uint8,
                merge_alg=MergeAlg.add,
            )
            classes[count % 2 == 1] = cls

    k = LANDCOVER_SUPERSAMPLE
    out_rows, out_cols = rows // k, cols // k
    blocks = classes[: out_rows * k, : out_cols * k].reshape(out_rows, k, out_cols, k)
    rgb = np.dstack(
        [np.round(np.isin(blocks, group).mean(axis=(1, 3)) * 255).astype(np.uint8) for group in LANDCOVER_CHANNELS]
    )
    canopy_path = ROOT_DIR / ".cache" / "trees" / "canopy.npy"
    if canopy_path.exists():
        canopy = np.load(canopy_path)[:out_rows, :out_cols]
        rgb[..., 0] = np.maximum(rgb[..., 0], np.round(canopy * 255).astype(np.uint8))
        print("  with lidar canopy")
    Image.fromarray(rgb, "RGB").save(OUT_DIR / "landcover.png", optimize=True)
    print(f"  landcover.png {out_cols}x{out_rows} {(OUT_DIR / 'landcover.png').stat().st_size / 1e6:.1f}MB")
    return {"bounds": list(LANDCOVER_BOUNDS), "size": [out_cols, out_rows]}


def update_manifest(**entries):
    manifest_path = OUT_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.update(entries)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, separators=(",", ":"))


def main():
    if sys.argv[1:] == ["water"]:
        build_water(None)
        return

    if sys.argv[1:] == ["landcover"]:
        update_manifest(landcover=build_landcover())
        return

    if sys.argv[1:] == ["shore"]:
        update_manifest(shore=build_shore(None))
        return

    if sys.argv[1:2] == ["fetch"]:
        with rasterio.Env(**GDAL_ENV):
            sources = open_sources(root_bounds())
            for level in map(int, sys.argv[2:]):
                print(f"fetch level {level}")
                read_raw(level, sources)
        return

    levels = range(MAX_LEVEL + 1)
    if len(sys.argv) > 1:
        levels = [int(a) for a in sys.argv[1:]]

    with rasterio.Env(**GDAL_ENV):
        sources = open_sources(root_bounds())
        manifest_levels = []
        grand_total = 0
        for level in levels:
            print(f"level {level}")
            entry, total = build_level(level, sources)
            manifest_levels.append(entry)
            grand_total += total
        build_water(sources)
        shore = build_shore(sources)

    # Building a subset of levels keeps the others from the last full build.
    manifest_path = OUT_DIR / "manifest.json"
    if manifest_path.exists() and len(manifest_levels) < MAX_LEVEL + 1:
        built = {entry["level"] for entry in manifest_levels}
        previous = json.loads(manifest_path.read_text())["levels"]
        manifest_levels = sorted(
            [entry for entry in previous if entry["level"] not in built]
            + manifest_levels,
            key=lambda entry: entry["level"],
        )

    existing = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest = {
        "crs": "EPSG:2193",
        "origin": list(ORIGIN),
        "rootSize": ROOT_SIZE,
        "tileCells": TILE_CELLS,
        "apron": APRON,
        "encoding": {"offset": OFFSET, "scale": SCALE},
        "levels": manifest_levels,
        "water": {
            "size": WATER_SIZE,
            "maxDepth": WATER_MAX_DEPTH,
            "encoding": "sqrt",
        },
        "shore": shore,
    }
    if "landcover" in existing:
        manifest["landcover"] = existing["landcover"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    print(f"total {grand_total / 1e6:.1f}MB")


if __name__ == "__main__":
    main()
