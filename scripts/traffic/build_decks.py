"""
Lifts the highways' bridge decks in public/roads/roads.json to where the
lidar found them, and notes the ground beneath for their piers.

build_roads.mjs reads heights from the terrain, which is bare earth: under
a bridge that's the gully floor, so it carries the road straight across
from one end to the other. A long viaduct isn't straight: the Thorndon
overbridge climbs to 15 m and holds it over the rail yards, 5 m above the
line between its ends. And the ends themselves are low: the bare earth
dips at an abutment, where the survey took the bridge away. Here each
deck's profile is read from the surface model instead, from where it and
the road on the ground last agree before the bridge to where they next do
after it.

Sources: LINZ 1m DSM and DEM (CC BY 4.0), read through their COGs and
cached in .cache/traffic/decks.json. A deck is sampled at each lane's
centre (the median, so a truck in one lane isn't a hump), median-filtered
along (nor a gantry, or a footbridge over it), then smoothed.

The surface model has only what's on top, so a deck that runs under
another reads as the upper one, with a step up to it: those, and any the
lidar doesn't settle back to the road beside, are left straight.

Each carriageway gets `ground`: [first point, height, height, …] for every
run of points lifted, the bare earth under them, which the scene stands
the deck's piers and abutments on.

Run straight after build_roads.mjs, on what it wrote.

Usage:
  .venv-terrain/bin/python -I scripts/traffic/build_decks.py
"""

import importlib.util
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds

ROOT_DIR = Path(__file__).resolve().parents[2]
ROADS = ROOT_DIR / "public" / "roads" / "roads.json"
CACHE = ROOT_DIR / ".cache" / "traffic" / "decks.json"

_spec = importlib.util.spec_from_file_location(
    "terrain", ROOT_DIR / "scripts" / "terrain" / "build_tiles.py"
)
terrain = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(terrain)

DSM_SOURCE = "https://nz-elevation.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dsm_1m/2193"
SOURCES = {"surface": DSM_SOURCE, "ground": terrain.SOURCE}

# Lanes, m, as build_roads.mjs and the scene have them.
LANE = 3.5
TOWN_LANE = 3.2

# The road on the ground is looked along this many points (8 m apart) past
# each end of a bridge, for where the lidar agrees with it again.
APPROACH = 40
# The lidar and the road agree, m: at two points running, it's the road.
AGREE = 0.5
# Failing that, at the bridge's own ends they're no further apart than
# this, m, or it's something else's surface the lidar found.
END_TOLERANCE = 2.0
# The median along a deck is over this many points either side.
MEDIAN_REACH = 2
# Then rounds of smoothing between neighbours.
SMOOTHING = 4
# A deck needs the lidar under this share of its points; the rest are
# filled from their neighbours.
MIN_COVERAGE = 0.7
# From one point to the next the lidar steps no more than this, m, or
# that's the edge of something over the road; and nothing's built steeper
# than this, m per m.
MAX_STEP = 1.5
MAX_GRADE = 0.09

_datasets = {}


def _dataset(source, sheet):
    key = (source, sheet)
    if key not in _datasets:
        try:
            _datasets[key] = rasterio.open(f"{SOURCES[source]}/{sheet}.tiff")
        except rasterio.errors.RasterioIOError:
            _datasets[key] = None
    return _datasets[key]


def read(source, points):
    """`source`'s height at each (east, north), None off the survey."""
    heights = [None] * len(points)
    by_sheet = {}
    for k, (east, north) in enumerate(points):
        # On a sheet's edge it's in two: the first has it.
        sheet = terrain.sheets_for((east, north, east + 0.001, north + 0.001))[0]
        by_sheet.setdefault(sheet, []).append(k)
    for sheet, ks in by_sheet.items():
        dataset = _dataset(source, sheet)
        if dataset is None:
            continue
        east = [points[k][0] for k in ks]
        north = [points[k][1] for k in ks]
        window = (
            from_bounds(
                min(east) - 2, min(north) - 2, max(east) + 2, max(north) + 2, dataset.transform
            )
            .round_offsets()
            .round_lengths()
        )
        data = dataset.read(1, window=window, boundless=True, fill_value=terrain.NODATA)
        transform = dataset.window_transform(window)
        for k in ks:
            col, row = ~transform * points[k]
            value = data[int(row), int(col)]
            if value > terrain.NODATA + 1:
                heights[k] = float(value)
    return heights


class Lidar:
    """Heights across the road at its points, kept between runs."""

    def __init__(self):
        self.cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}

    def across(self, source, cw, first, last):
        """The median of `source` over the lanes at each point first..last."""
        lanes = [cw.lane_centres(i) for i in range(first, last + 1)]
        keys = [[f"{source} {east:.1f},{north:.1f}" for east, north in row] for row in lanes]
        missing = [
            (key, at)
            for row, ats in zip(keys, lanes)
            for key, at in zip(row, ats)
            if key not in self.cache
        ]
        if missing:
            found = read(source, [at for _, at in missing])
            for (key, _), height in zip(missing, found):
                self.cache[key] = None if height is None else round(height, 2)
        medians = []
        for row in keys:
            known = [self.cache[key] for key in row if self.cache[key] is not None]
            medians.append(float(np.median(known)) if known else None)
        return medians

    def save(self):
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(self.cache, indent=0, sort_keys=True))


class Carriageway:
    def __init__(self, file, bridge, tunnel):
        self.points = file["points"]
        self.count = len(self.points) // 3
        self.lanes = [0] * self.count
        self.total = [0] * self.count
        self.flags = [0] * self.count
        self.width = [LANE] * self.count
        spans = file["spans"]
        for k, (start, lanes, total, flags, limit) in enumerate(spans):
            end = spans[k + 1][0] if k + 1 < len(spans) else self.count
            for i in range(start, end):
                self.lanes[i] = lanes
                self.total[i] = total
                self.flags[i] = flags
                self.width[i] = LANE if limit > 50 else TOWN_LANE
        # As build_roads.mjs has it: off the ground on both sides.
        off = bridge | tunnel
        self.lifted = [
            0 < i < self.count - 1
            and self.flags[i - 1] & off != 0
            and self.flags[i] & off != 0
            for i in range(self.count)
        ]
        self.bridge = bridge
        self.off = off

    def at(self, i):
        return self.points[i * 3], self.points[i * 3 + 1]

    def height(self, i):
        return self.points[i * 3 + 2]

    def lane_centres(self, i):
        """Each of this way's lanes at point i, (east, north) at its middle."""
        a = self.at(max(i - 1, 0))
        b = self.at(min(i + 1, self.count - 1))
        length = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
        # To the right of the way it runs.
        right = ((b[1] - a[1]) / length, -(b[0] - a[0]) / length)
        k = min(i, self.count - 2)
        kerb = -self.total[k] * self.width[k] / 2
        east, north = self.at(i)
        return [
            (
                east + right[0] * (kerb + (lane + 0.5) * self.width[k]),
                north + right[1] * (kerb + (lane + 0.5) * self.width[k]),
            )
            for lane in range(self.lanes[k])
        ]

    def bridges(self):
        """
        (start, end) of each bridge: the points on the ground either side of
        a run build_roads.mjs lifted, where it's all bridge and no tunnel.
        """
        runs = []
        i = 0
        while i < self.count:
            if not self.lifted[i]:
                i += 1
                continue
            start = i - 1
            while i < self.count - 1 and self.lifted[i]:
                i += 1
            if all(self.flags[k] & self.off == self.bridge for k in range(start, i)):
                runs.append((start, i))
        return runs

    def reach(self, start, end):
        """How far the road runs on the ground before `start` and after `end`."""
        first = start
        while first > 0 and start - first < APPROACH and not self.lifted[first - 1]:
            first -= 1
        last = end
        while last < self.count - 1 and last - end < APPROACH and not self.lifted[last + 1]:
            last += 1
        return first, last


def median_along(values, reach):
    out = []
    for i in range(len(values)):
        near = [v for v in values[max(i - reach, 0) : i + reach + 1] if v is not None]
        out.append(float(np.median(near)) if near else None)
    return out


def fill(values):
    """Gaps filled straight between their neighbours; None if it's all gap."""
    known = [i for i, v in enumerate(values) if v is not None]
    if not known:
        return None
    return list(np.interp(range(len(values)), known, [values[i] for i in known]))


def anchor(cw, profile, first, steps):
    """
    The first of `steps` (points, going away from a bridge's end) where the
    lidar and the road agree, there and at the next: None if they never do.
    """
    agrees = [abs(profile[i - first] - cw.height(i)) <= AGREE for i in steps]
    for k, i in enumerate(steps):
        if agrees[k] and (k + 1 == len(steps) or agrees[k + 1]):
            return i
    return None


def deck(cw, start, end, first, measured):
    """
    Where the lidar's profile takes over from the road and hands back, and
    the heights of the points between; or why not. `measured` is the lidar
    at each point from `first` on.
    """
    last = first + len(measured) - 1
    inside = measured[start - first : end - first + 1]
    coverage = sum(v is not None for v in inside) / len(inside)
    if coverage < MIN_COVERAGE:
        return None, f"lidar under {coverage:.0%} of it"
    profile = fill(median_along(measured, MEDIAN_REACH))

    # The road's on the ground somewhere past each end: the lidar says the
    # same there.
    a = anchor(cw, profile, first, range(start, first - 1, -1))
    b = anchor(cw, profile, first, range(end, last + 1))
    off = [profile[i - first] - cw.height(i) for i in (start, end)]
    if a is None and abs(off[0]) <= END_TOLERANCE:
        a = start
    if b is None and abs(off[1]) <= END_TOLERANCE:
        b = end
    if a is None or b is None:
        return None, f"lidar {off[0]:+.1f}, {off[1]:+.1f} m off the road at its ends"

    step = max(
        abs(profile[i + 1 - first] - profile[i - first]) for i in range(a, b)
    )
    if step > MAX_STEP:
        return None, f"lidar steps {step:.1f} m: something's over it"

    for _ in range(SMOOTHING):
        profile = [
            (profile[max(i - 1, 0)] + 2 * v + profile[min(i + 1, len(profile) - 1)]) / 4
            for i, v in enumerate(profile)
        ]
    profile = profile[a - first : b - first + 1]
    s = [0.0]
    for i in range(a, b):
        p, q = cw.at(i), cw.at(i + 1)
        s.append(s[-1] + math.hypot(q[0] - p[0], q[1] - p[1]))
    # What's left where they meet is spread along it, so they meet exactly.
    left = (cw.height(a) - profile[0], cw.height(b) - profile[-1])
    heights = [
        h + left[0] + (left[1] - left[0]) * s[k] / s[-1] for k, h in enumerate(profile)
    ]
    grade = max(
        abs(heights[k + 1] - heights[k]) / max(s[k + 1] - s[k], 1)
        for k in range(len(heights) - 1)
    )
    if grade > MAX_GRADE:
        return None, f"as steep as {grade:.0%}"
    return (a, b, heights[1:-1]), None


def tidy(height):
    """As build_roads.mjs writes a height: to 0.1 m, whole numbers bare."""
    rounded = round(height, 1)
    return int(rounded) if rounded == int(rounded) else rounded


def main():
    roads = json.loads(ROADS.read_text())
    if any("ground" in file for file in roads["carriageways"].values()):
        raise SystemExit(f"{ROADS.name}'s decks are lifted already: run build_roads.mjs first")
    bridge, tunnel = roads["flags"]["bridge"], roads["flags"]["tunnel"]
    lidar = Lidar()
    lifted = 0
    left = 0

    with rasterio.Env(**terrain.GDAL_ENV):
        for name, file in roads["carriageways"].items():
            cw = Carriageway(file, bridge, tunnel)
            ground = []
            # Heights are set once every bridge is read: a bridge's
            # approach is the next one's too.
            decks = []
            for start, end in cw.bridges():
                first, last = cw.reach(start, end)
                measured = lidar.across("surface", cw, first, last)
                found, why = deck(cw, start, end, first, measured)
                east, north = cw.at((start + end) // 2)
                where = f"{name} {start}-{end} at {east:.0f}, {north:.0f}"
                if found is None:
                    left += 1
                    print(f"  {where}: left straight ({why})")
                    continue
                a, b, heights = found
                if decks and a < decks[-1][1]:
                    left += 1
                    print(f"  {where}: left straight (runs into the bridge before)")
                    continue
                decks.append((a, b, heights))
                rise = max(
                    (h - cw.height(i) for i, h in zip(range(a + 1, b), heights)),
                    key=abs,
                    default=0,
                )
                lifted += 1
                if abs(rise) >= 1:
                    print(
                        f"  {where}: moved up to {rise:+.1f} m, "
                        f"from {start - a} points before it to {b - end} after"
                    )
            for a, b, heights in decks:
                under = fill(lidar.across("ground", cw, a, b)) or [0] * (b - a + 1)
                for i, h in zip(range(a + 1, b), heights):
                    file["points"][i * 3 + 2] = tidy(h)
                # The sea's bed isn't ground to stand on: sea level is.
                ground.append([a, *(tidy(max(g, 0)) for g in under)])
            file["ground"] = ground

    lidar.save()
    ROADS.write_text(json.dumps(roads, separators=(",", ":"), ensure_ascii=False))
    print(f"{lifted} decks from the lidar, {left} left straight")


if __name__ == "__main__":
    main()
