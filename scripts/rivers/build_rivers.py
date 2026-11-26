"""
The region's big rivers, as ribbons of water on their lidar-measured surface.

A lake's water is level (scripts/lakes); a river's runs downhill, and a 20 m
river is lost in the terrain's 8 m and 16 m tiles. So each one is measured
from the LINZ 1 m DEM itself, which is hydro-flattened: the water's surface
is left as a flat run across the channel, falling downstream.

  1. Its OpenStreetMap centreline (waterway=river, drawn downstream), cut to
     the terrain's detailed region and resampled every STEP m.
  2. A cross-section of the 1 m DEM at each station: the water is the run of
     ground within TOLERANCE of the lowest near the line, which finds the
     channel where the line has strayed off it and leaves out gravel bars.
  3. Along the river: the levels made to never rise downstream (isotonic
     regression) and smoothed; the banks median-filtered and smoothed.
  4. Each vertex's height: the water's, or the terrain's as drawn there (from
     the finest cached level, scripts/terrain) where that's higher, so the
     coarse tiles' banks don't bury it.

Every river runs into the sea. The coast is the terrain's own: ground at or
under mean sea level that joins the open sea (the lidar has the water near
the shore at about 0 m, so its nodata starts well out). A river that's
mapped as stopping short of it, behind a beach's shingle bar, is carried on
from its last bend in a smooth curve to the nearest sea; one that's mapped
out past it is cut. Either way it runs FADE m on over the sea, and the scene
fades it out over those, so it pours into the sea rather than ending in a
square edge. Its water down at sea level the scene shades as the sea's own
(by `levels`), and lifts with the tide.

Output: public/rivers/rivers.json
  { "origin": [E0, N0], "fade": m,
    "rivers": [{ "name", "points": [dE, dN, h, ...], "levels": [m, ...] }] }
  Points are the ribbon's left and right banks, in pairs, downstream; h is
  metres above sea level before the scene's vertical scale: the water's, or
  the drawn terrain's where that's higher. Levels are the water's alone, one
  to a pair. Each river's last `fade` metres are over the sea.

Usage:
  .venv-terrain/bin/python -I scripts/rivers/build_rivers.py
"""

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.transform import rowcol, xy
from rasterio.warp import transform_bounds
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "terrain"))

from build_tiles import (  # noqa: E402
    GDAL_ENV,
    LANDCOVER_BOUNDS,
    NODATA,
    ORIGIN,
    REGIONS,
    level_grid,
    open_sources,
    read_raw,
    to_nztm,
)

ROOT_DIR = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT_DIR / "public" / "rivers"
CACHE_DIR = ROOT_DIR / ".cache" / "rivers"

QUERY = """
[out:json][timeout:300][bbox:{s},{w},{n},{e}];
way["waterway"="river"];
out tags geom qt;
"""

# (OpenStreetMap name, widest its water gets, m: a cross-section's run is
# cut to it, which keeps a flat floodplain from counting as river). The
# Hutt's is its estuary's, bank to bank at the mouth.
RIVERS = [
    ("Te Awa Kairangi / Hutt River", 200.0),
    ("Wainuiomata River", 30.0),
    ("Ōrongorongo River", 50.0),
]

# Stations along the centreline, m; every SPACING-th is drawn.
STEP = 4.0
SPACING = 2

# The cross-section reaches this far either side of the line, m; the channel
# is looked for within SEARCH of it.
REACH = 130.0
SEARCH = 25.0

# Ground within this of the water's surface, m, is the water's.
TOLERANCE = 0.3

# Narrowest drawn, m: under it the DEM can't tell the water from the bed.
NARROWEST = 5.0

# Smoothing along the river, m: of the level, and of the banks.
LEVEL_SMOOTH = 60.0
BANK_SMOOTH = 16.0

# The water's never put lower than this, m above sea level: the last
# stretch's lidar is the water at the tide it was flown at.
LOWEST = 0.05

# How far a river runs on over the sea, m, fading out as it goes.
FADE = 120.0

# The 1 m DEM is read in squares this size, m, cached.
CHUNK = 500.0

# Kept this far inside the terrain's detailed region, m.
MARGIN = 200.0


def elements():
    cache = CACHE_DIR / "osm_rivers.json"
    if not cache.exists():
        w, s, e, n = transform_bounds(CRS.from_epsg(2193), CRS.from_epsg(4326), *LANDCOVER_BOUNDS)
        print("fetching OpenStreetMap rivers")
        request = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=urllib.parse.urlencode({"data": QUERY.format(w=w, s=s, e=e, n=n)}).encode(),
            headers={"User-Agent": "joshbarr.com rivers build"},
        )
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(request, timeout=600) as response:
            cache.write_bytes(response.read())
    return json.loads(cache.read_text())["elements"]


def centreline(name):
    """The river's longest chain of ways, joined end to start, downstream."""
    ways = [
        to_nztm([(p["lon"], p["lat"]) for p in x["geometry"]])
        for x in elements()
        if x.get("tags", {}).get("name") == name and len(x.get("geometry", [])) >= 2
    ]

    def key(p):
        return (round(p[0], 1), round(p[1], 1))

    starting = {}
    for i, way in enumerate(ways):
        starting.setdefault(key(way[0]), []).append(i)

    def length(line):
        a = np.asarray(line)
        return float(np.hypot(*np.diff(a, axis=0).T).sum())

    def longest_from(i, used):
        line = list(ways[i])
        best = line
        for j in starting.get(key(line[-1]), []):
            if j in used:
                continue
            rest = longest_from(j, used | {j})
            if length(line + rest[1:]) > length(best):
                best = line + rest[1:]
        return best

    ends = {key(w[-1]) for w in ways}
    heads = [i for i, w in enumerate(ways) if key(w[0]) not in ends] or list(range(len(ways)))
    return max((longest_from(i, {i}) for i in heads), key=length)


def resample(line, step):
    a = np.asarray(line, dtype=float)
    along = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(a, axis=0).T))])
    at = np.arange(0, along[-1], step)
    return np.column_stack([np.interp(at, along, a[:, 0]), np.interp(at, along, a[:, 1])])


def inside_region(points):
    w, s, e, n = LANDCOVER_BOUNDS
    x, y = points.T
    return (x > w + MARGIN) & (x < e - MARGIN) & (y > s + MARGIN) & (y < n - MARGIN)


class Dem:
    """The 1 m DEM, read a CHUNK square at a time and cached."""

    def __init__(self):
        self.chunks = {}
        self.sources = None

    def chunk(self, i, j):
        if (i, j) in self.chunks:
            return self.chunks[(i, j)]
        path = CACHE_DIR / "dem" / f"{i}_{j}.npy"
        if path.exists():
            data = np.load(path)
        else:
            west, south = i * CHUNK, j * CHUNK
            bounds = (west, south, west + CHUNK, south + CHUNK)
            if self.sources is None:
                self.sources = open_sources(LANDCOVER_BOUNDS)
            data, _ = merge(self.sources, bounds=bounds, res=1.0, nodata=NODATA, resampling=Resampling.average)
            data = data[0].astype(np.float32)
            path.parent.mkdir(parents=True, exist_ok=True)
            np.save(path, data)
        self.chunks[(i, j)] = data
        return data

    def sample(self, x, y):
        """Nearest 1 m pixel's height at each point; nan where there's none."""
        out = np.full(np.shape(x), np.nan, dtype=np.float32)
        i = np.floor(np.asarray(x) / CHUNK).astype(int)
        j = np.floor(np.asarray(y) / CHUNK).astype(int)
        for ci, cj in set(zip(i.ravel(), j.ravel())):
            data = self.chunk(ci, cj)
            mask = (i == ci) & (j == cj)
            col = np.clip(np.floor(x[mask] - ci * CHUNK).astype(int), 0, data.shape[1] - 1)
            row = np.clip(np.floor((cj + 1) * CHUNK - y[mask]).astype(int), 0, data.shape[0] - 1)
            v = data[row, col]
            out[mask] = np.where(v == NODATA, np.nan, v)
        return out


class Drawn:
    """The terrain's height as its tiles have it: the finest level there."""

    def __init__(self):
        self.levels = [(level, bounds, read_raw(level, None)[0], level_grid(level)[0]) for level, bounds in sorted(REGIONS, reverse=True)]

    def sample(self, x, y):
        out = np.full(np.shape(x), np.nan, dtype=np.float32)
        for _, (w, s, e, n), heights, grid in self.levels:
            todo = np.isnan(out) & (x > w) & (x < e) & (y > s) & (y < n)
            if not todo.any():
                continue
            # Bilinear between the sample points (pixel centres).
            fr, fc = (np.asarray(v) for v in rowcol(grid, x[todo], y[todo], op=lambda v: v))
            fr, fc = fr - 0.5, fc - 0.5
            r0, c0 = np.floor(fr).astype(int), np.floor(fc).astype(int)
            tr, tc = fr - r0, fc - c0
            r0 = np.clip(r0, 0, heights.shape[0] - 2)
            c0 = np.clip(c0, 0, heights.shape[1] - 2)
            corners = [heights[r0 + dr, c0 + dc] for dr in (0, 1) for dc in (0, 1)]
            corners = [np.maximum(c, 0) for c in corners]
            top = corners[0] * (1 - tc) + corners[1] * tc
            bottom = corners[2] * (1 - tc) + corners[3] * tc
            out[todo] = top * (1 - tr) + bottom * tr
        return out


def isotonic_falling(values, weights):
    """The closest sequence to `values` that never rises (pool adjacent violators)."""
    blocks = []
    for v, w in zip(values, weights):
        blocks.append([v * w, w, 1])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] < blocks[-1][0] / blocks[-1][1]:
            s, ww, n = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += ww
            blocks[-1][2] += n
    return np.concatenate([np.full(n, s / w) for s, w, n in blocks])


def cross_sections(dem, stations):
    """Per station: the water's level and its banks' offsets (left, right), m."""
    tangent = np.gradient(ndimage.gaussian_filter1d(stations, 20 / STEP, axis=0), axis=0)
    tangent /= np.linalg.norm(tangent, axis=1, keepdims=True)
    # Left of the way downstream.
    normal = np.column_stack([-tangent[:, 1], tangent[:, 0]])
    offsets = np.arange(-REACH, REACH + 1.0)
    xs = stations[:, 0:1] + normal[:, 0:1] * offsets
    ys = stations[:, 1:2] + normal[:, 1:2] * offsets
    heights = dem.sample(xs, ys)

    levels = np.full(len(stations), np.nan)
    banks = np.full((len(stations), 2), np.nan)
    near = np.abs(offsets) <= SEARCH
    for k, h in enumerate(heights):
        if np.isnan(h[near]).mean() > 0.3:
            continue
        # The channel: the lowest ground near the line.
        lowest = np.nanargmin(np.where(near, h, np.nan))
        floor = h[lowest]
        wet = h <= floor + TOLERANCE
        left = lowest
        while left + 1 < len(h) and wet[left + 1]:
            left += 1
        right = lowest
        while right > 0 and wet[right - 1]:
            right -= 1
        levels[k] = np.nanmedian(h[right : left + 1])
        banks[k] = (offsets[left] + 0.5, -(offsets[right] - 0.5))
    return levels, banks, normal


class Sea:
    """The terrain's sea: what's at or under 0 m and joins the open water."""

    def __init__(self):
        heights = np.asarray(read_raw(5, None)[0])
        self.grid = level_grid(5)[0]
        low = (heights == NODATA) | (heights <= 0)
        labels, _ = ndimage.label(low)
        counts = np.bincount(labels.ravel())
        counts[0] = 0
        self.mask = labels == counts.argmax()
        _, self.nearest_index = ndimage.distance_transform_edt(~self.mask, return_indices=True)

    def _cell(self, points):
        rows, cols = rowcol(self.grid, points[:, 0], points[:, 1])
        rows = np.clip(np.asarray(rows), 0, self.mask.shape[0] - 1)
        cols = np.clip(np.asarray(cols), 0, self.mask.shape[1] - 1)
        return rows, cols

    def at(self, points):
        return self.mask[self._cell(points)]

    def nearest(self, point):
        rows, cols = self._cell(np.asarray([point]))
        r, c = self.nearest_index[:, rows[0], cols[0]]
        return np.asarray(xy(self.grid, r, c))


def to_sea(stations, sea):
    """
    The river's stations carried on to the sea and FADE m out over it, and
    the indices of the first past its mapped end and the first at sea.
    """
    mapped = len(stations)
    line = list(stations)
    if not sea.at(stations[-1:])[0]:
        # From the last bend, on its way, round to the nearest sea.
        end = stations[-1]
        way = stations[-1] - stations[-min(10, len(stations))]
        way /= np.linalg.norm(way)
        target = sea.nearest(end)
        reach = np.linalg.norm(target - end)
        bend = end + way * reach * 0.5
        for t in np.linspace(0, 1, max(int(reach / STEP), 2))[1:]:
            line.append((1 - t) ** 2 * end + 2 * (1 - t) * t * bend + t**2 * target)
    a = np.asarray(line)
    way = a[-1] - a[-min(10, len(a))]
    way /= np.linalg.norm(way)
    line += [a[-1] + way * d for d in np.arange(STEP, FADE + 2 * STEP, STEP)]

    stations = resample(line, STEP)
    coast = int(np.argmax(sea.at(stations)))
    stations = stations[: coast + int(FADE / STEP) + 1]
    return stations, min(mapped, len(stations)), coast


def build(name, widest, dem, drawn, sea):
    stations = resample(centreline(name), STEP)
    # The longest stretch inside the region: one wandering out and back in
    # mustn't be joined across the gap.
    runs = np.split(np.arange(len(stations)), np.flatnonzero(np.diff(inside_region(stations).astype(int))) + 1)
    stations = stations[max((r for r in runs if inside_region(stations[r[:1]]).all()), key=len)]
    stations, mapped, coast = to_sea(stations, sea)
    levels, banks, normal = cross_sections(dem, stations)

    # Past its mapped end, over the bar, nothing measured's the river's: its
    # level eases down to the sea's at the coast, and it keeps its width.
    beyond = min(mapped, coast)
    levels[beyond:] = np.nan
    banks[beyond:] = np.nan
    levels[coast:] = LOWEST

    # Gaps (a bridge's deck, a culvert): from either side.
    known = ~np.isnan(levels)
    idx = np.arange(len(levels))
    levels = np.interp(idx, idx[known], levels[known])
    measured = ~np.isnan(banks[:, 0])
    for side in (0, 1):
        b = banks[:, side]
        banks[:, side] = np.interp(idx, idx[measured], b[measured])

    # The banks: a run cut short at one station, or run out over a flat
    # field, is filtered out, then the river's held to its widths.
    banks = ndimage.median_filter(banks, size=(int(BANK_SMOOTH / STEP) * 2 + 1, 1), mode="nearest")
    banks = ndimage.gaussian_filter1d(banks, BANK_SMOOTH / STEP, axis=0, mode="nearest")
    width = banks.sum(axis=1)
    scale = np.clip(width, NARROWEST, widest) / np.maximum(width, 1e-3)
    centre = (banks[:, 0] - banks[:, 1]) / 2
    half = width * scale / 2
    banks = np.column_stack([centre + half, half - centre])

    falling = isotonic_falling(levels, np.ones_like(levels))
    falling = ndimage.gaussian_filter1d(falling, LEVEL_SMOOTH / STEP, mode="nearest")
    falling = np.maximum(np.minimum.accumulate(falling), LOWEST)

    left = stations + normal * banks[:, 0:1]
    right = stations - normal * banks[:, 1:2]
    pairs = np.stack([left, right], axis=1)
    ground = drawn.sample(pairs[..., 0], pairs[..., 1])
    heights = np.fmax(falling[:, None], ground)

    print(
        f"  {name}: {len(stations) * STEP / 1000:.1f} km, {falling[0]:.1f} m to {falling[-1]:.1f} m, "
        f"width {np.percentile(banks.sum(axis=1), 10):.0f}..{np.percentile(banks.sum(axis=1), 90):.0f} m, "
        f"raised over the tiles' banks {np.mean(ground > falling[:, None] + 0.5) * 100:.0f}%"
    )

    keep = np.unique(np.append(np.arange(0, len(pairs), SPACING), len(pairs) - 1))
    points = []
    for (x, y), h in zip(pairs[keep].reshape(-1, 2), heights[keep].ravel()):
        points += [round(float(x) - ORIGIN[0], 1), round(float(y) - ORIGIN[1], 1), round(float(h), 2)]
    return {"name": name, "points": points, "levels": [round(float(v), 2) for v in falling[keep]]}


def main():
    with rasterio.Env(**GDAL_ENV):
        dem = Dem()
        drawn = Drawn()
        sea = Sea()
        rivers = [build(name, widest, dem, drawn, sea) for name, widest in RIVERS]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / "rivers.json"
    path.write_text(json.dumps({"origin": list(ORIGIN), "fade": FADE, "rivers": rivers}, separators=(",", ":")))
    print(f"{len(rivers)} rivers, {path.stat().st_size / 1e3:.0f}kB")


if __name__ == "__main__":
    main()
