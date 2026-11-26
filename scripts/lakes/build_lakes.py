"""
Lakes, reservoirs and ponds for the scene: OpenStreetMap's standing water,
each a flat sheet at its surface's height.

The sea is one sheet at sea level (src/components/scene/ocean), so water held
up in the hills, like Zealandia's two Karori reservoirs, had nothing drawn on
it: the DEM's lidar is hydro-flattened, so the lake was a flat grey floor
between the trees. Each lake's level is the median of the terrain's heights
inside it, from the finest cached level (scripts/terrain) that covers it, so
the sheet lies on that floor.

Left out: rivers and streams (their surface runs downhill, so a flat sheet
can't follow it); water at sea level, which the sea already draws;
covered reservoirs and tanks; and anything too small to see.

Output: public/lakes/lakes.json
  { "origin": [E0, N0], "lakes": [{ "name", "level", "rings": [[dE, dN, ...]] }] }
  Rings are NZTM metres from the terrain's origin, outer first, then its
  holes. Level is metres above sea level, before the scene's vertical scale.

Usage:
  .venv-terrain/bin/python -I scripts/lakes/build_lakes.py
"""

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from rasterio.crs import CRS
from rasterio.enums import MergeAlg
from rasterio.features import rasterize
from rasterio.transform import rowcol
from rasterio.warp import transform_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "terrain"))

from build_tiles import (  # noqa: E402
    LANDCOVER_BOUNDS,
    NODATA,
    ORIGIN,
    REGIONS,
    level_grid,
    read_raw,
    stitch,
    to_nztm,
)

ROOT_DIR = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT_DIR / "public" / "lakes"
CACHE = ROOT_DIR / ".cache" / "lakes" / "osm_water.json"

QUERY = """
[out:json][timeout:300][bbox:{s},{w},{n},{e}];
(nwr["natural"="water"];nwr["landuse"="reservoir"];nwr["water"];);
out geom qt;
"""

# Their surface slopes, or they're the sea's.
RUNNING = {"river", "stream", "canal", "drain", "ditch", "tidal", "lagoon", "stream_pool"}

# Smaller than this, m², it's a few pixels from any height.
MIN_AREA = 100.0

# Below this, m, it's the sea's (or a tidal flat the sea covers).
MIN_LEVEL = 1.5

# Vertices closer than this along a ring, m, are dropped.
SIMPLIFY = 1.0


def elements():
    if not CACHE.exists():
        w, s, e, n = transform_bounds(CRS.from_epsg(2193), CRS.from_epsg(4326), *LANDCOVER_BOUNDS)
        print("fetching OpenStreetMap water")
        request = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=urllib.parse.urlencode({"data": QUERY.format(w=w, s=s, e=e, n=n)}).encode(),
            headers={"User-Agent": "joshbarr.com lakes build"},
        )
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(request, timeout=600) as response:
            CACHE.write_bytes(response.read())
    return json.loads(CACHE.read_text())["elements"]


def standing(tags):
    """Open standing water, not a tank, a covered reservoir or a river."""
    if tags.get("covered") in ("yes", "partial") or tags.get("man_made") in ("storage_tank", "reservoir_covered"):
        return False
    if "tank" in tags.get("name", "").lower():
        return False
    if tags.get("water") in RUNNING or tags.get("waterway"):
        return False
    # landuse=reservoir alone is usually a covered service reservoir.
    return tags.get("natural") == "water" or "water" in tags


def area(ring):
    xs, ys = np.asarray(ring).T
    return 0.5 * float(np.dot(xs, np.roll(ys, 1)) - np.dot(ys, np.roll(xs, 1)))


def inside(point, ring):
    x, y = point
    xs, ys = np.asarray(ring).T
    xj, yj = np.roll(xs, 1), np.roll(ys, 1)
    crosses = ((ys > y) != (yj > y)) & (x < (xj - xs) * (y - ys) / np.where(yj == ys, 1e-12, yj - ys) + xs)
    return bool(np.count_nonzero(crosses) % 2)


def same(ring, other):
    """Whether two shores are one lake's, mapped twice: much the same size, and
    nearly all of one's points within a few metres of the other's."""
    if abs(abs(area(ring)) / abs(area(other)) - 1) > 0.2:
        return False
    a, b = np.asarray(ring), np.asarray(other)
    if np.hypot(*(a.mean(axis=0) - b.mean(axis=0))) > 50:
        return False
    gaps = np.min(np.hypot(*(a[:, None, :] - b[None, :, :]).transpose(2, 0, 1)), axis=1)
    return np.mean(gaps < 5) > 0.8


def polygons():
    """(name, [outer, holes...]) in NZTM, outers counter-clockwise."""
    out = []
    for element in elements():
        tags = element.get("tags", {})
        if not standing(tags):
            continue
        name = tags.get("name", "")
        if element["type"] == "way":
            points = [(p["lon"], p["lat"]) for p in element.get("geometry", [])]
            if len(points) >= 4 and points[0] == points[-1]:
                out.append((name, [to_nztm(points)]))
        elif element["type"] == "relation" and tags.get("type") == "multipolygon":
            rings = {"outer": [], "inner": []}
            for role in rings:
                ways = [
                    [(p["lon"], p["lat"]) for p in m["geometry"]]
                    for m in element.get("members", [])
                    if m["type"] == "way" and m.get("geometry") and (m.get("role") or "outer") == role
                ]
                rings[role] = [to_nztm(r) for r in stitch(ways) if len(r) >= 4]
            for outer in rings["outer"]:
                holes = [r for r in rings["inner"] if inside(r[0], outer)]
                out.append((name, [outer, *holes]))
    return out


def simplify(ring):
    kept = [ring[0]]
    for p in ring[1:-1]:
        if np.hypot(p[0] - kept[-1][0], p[1] - kept[-1][1]) >= SIMPLIFY:
            kept.append(p)
    return kept


def oriented(ring, ccw):
    ring = list(ring[:-1] if ring[0] == ring[-1] else ring)
    return ring if (area(ring) > 0) == ccw else ring[::-1]


def finest_level(bounds):
    """The finest terrain level whose region holds all of `bounds`."""
    w, s, e, n = bounds
    for level, (rw, rs, re_, rn) in sorted(REGIONS, reverse=True):
        if rw <= w and rs <= s and e <= re_ and n <= rn:
            return level
    return None


_mosaics = {}


def heights_inside(rings):
    """The terrain's heights at the samples inside the polygon, sea dropped."""
    xs = [x for r in rings for x, _ in r]
    ys = [y for r in rings for _, y in r]
    level = finest_level((min(xs), min(ys), max(xs), max(ys)))
    if level is None:
        return None
    if level not in _mosaics:
        _mosaics[level] = (read_raw(level, None)[0], level_grid(level)[0])
    heights, grid = _mosaics[level]

    r0, c0 = rowcol(grid, min(xs), max(ys))
    r1, c1 = rowcol(grid, max(xs), min(ys))
    r0, c0 = max(r0 - 1, 0), max(c0 - 1, 0)
    r1, c1 = min(r1 + 2, heights.shape[0]), min(c1 + 2, heights.shape[1])
    window = np.asarray(heights[r0:r1, c0:c1])
    count = rasterize(
        [({"type": "Polygon", "coordinates": [ring]}, 1) for ring in rings],
        out_shape=window.shape,
        transform=grid * grid.translation(c0, r0),
        dtype=np.uint8,
        merge_alg=MergeAlg.add,
    )
    return window[(count % 2 == 1) & (window != NODATA)]


def main():
    lakes = []
    # Some water's mapped twice over: two sheets in one place would fight.
    kept = []
    for name, rings in polygons():
        outer = rings[0]
        if abs(area(outer)) < MIN_AREA:
            continue
        if any(same(outer, other) for other in kept):
            continue
        kept.append(outer)
        values = heights_inside(rings)
        if values is None or values.size == 0:
            continue
        level = float(np.median(values))
        if level < MIN_LEVEL:
            continue
        spread = float(np.percentile(values, 90) - np.percentile(values, 10))
        rings = [oriented(simplify(outer), True)] + [oriented(simplify(h), False) for h in rings[1:]]
        rings = [r for r in rings if len(r) >= 3]
        if len(rings[0]) < 3:
            continue
        lakes.append(
            {
                "name": name,
                "level": round(level, 2),
                "rings": [
                    [round(v, 1) for x, y in ring for v in (x - ORIGIN[0], y - ORIGIN[1])]
                    for ring in rings
                ],
            }
        )
        if name or abs(area(outer)) > 2000:
            print(f"  {name or '(unnamed)':40s} {abs(area(outer)):9.0f} m²  level {level:6.1f} m  spread {spread:4.1f} m")

    lakes.sort(key=lambda lake: -abs(area(np.reshape(lake["rings"][0], (-1, 2)))))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / "lakes.json"
    path.write_text(json.dumps({"origin": list(ORIGIN), "lakes": lakes}, separators=(",", ":")))
    print(f"{len(lakes)} lakes, {path.stat().st_size / 1e3:.0f}kB")


if __name__ == "__main__":
    main()
