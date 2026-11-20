"""
Builds src/components/scene/power/grid.ts: Transpower's towers and poles
around Wellington, the spans strung between them, and the HVDC link's
cables across Cook Strait.

Sources:
  Transpower's open data (CC BY 4.0): Structures (a point for each tower,
  pole and termination, with its type) and Transmission Lines (centrelines,
  a vertex at each structure, with the design voltage).
  OpenStreetMap (ODbL): the three Cook Strait cables, traced from LINZ's
  charts.
  LINZ 1m DSM and DEM (CC BY 4.0): each structure's height, the surface's
  highest return over it less the ground. The lidar caught the steelwork
  (and the conductors, which is why the trees build clears them).

Lines under MIN_KV are left out (the 11 kV pole line to Oteranga Bay), and
the HVDC link's electrode line.

Each structure stands on the published terrain (public/terrain), so run
this after the terrain build. The trees build reads grid.ts to clear the
canopy the lidar found on the towers and wires: run it after this.

Usage:
  .venv-terrain/bin/python -I scripts/power/build_power.py
"""

import importlib.util
import json
import threading
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import from_bounds
from scipy.spatial import cKDTree

ROOT_DIR = Path(__file__).resolve().parents[2]
OUT = ROOT_DIR / "src" / "components" / "scene" / "power" / "grid.ts"
CACHE_DIR = ROOT_DIR / ".cache" / "power"
TERRAIN_DIR = ROOT_DIR / "public" / "terrain"

_spec = importlib.util.spec_from_file_location(
    "terrain", ROOT_DIR / "scripts" / "terrain" / "build_tiles.py"
)
terrain = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(terrain)

TRANSPOWER = "https://services3.arcgis.com/AkUq3zcWf7TVqyR9/arcgis/rest/services"
DSM_SOURCE = "https://nz-elevation.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dsm_1m/2193"
USER_AGENT = "joshbarr.com scene builder"

# Lines designed for less than this are left out, kV.
MIN_KV = 33

# Transpower's structure types, as grid.ts names them.
TYPES = {
    "Double Circuit Steel Tower": "D",
    "Triple Circuit Steel Tower": "T",
    "Single Circuit Steel Tower": "S",
    "Double Circuit Single Pole": "DP",
    "Single Circuit Single Pole": "SP",
    "Single Circuit Pi Pole": "PI",
    "Termination": "X",
}
POLES = {"DP", "SP", "PI"}

# A line's vertex is at the structure within this of it, m. Terminations
# are drawn a few metres off the ends of their lines.
SNAP = 6.0
# Terminations this close are one gantry, m.
GANTRY = 10.0

# A structure's top is the surface's highest point within this of its
# centre, m: towers, then poles.
TOP_RADIUS = {False: 5.0, True: 3.0}
# Heights outside these are something else's (a tree over a pole, a gap in
# the survey), m: towers, then poles.
PLAUSIBLE = {False: (12.0, 75.0), True: (8.0, 45.0)}
# With nothing measured on its line either, m.
DEFAULT_HEIGHT = {False: 30.0, True: 20.0}
WORKERS = 8

# The ground along a span is sampled about this often, m.
SPAN_STEP = 10.0
# A span's tightest point is found for the terrain's vertical scale (see
# verticalScale in Terrain.tsx), and wires this far over the feet, m.
VERTICAL_SCALE = 1.15
WIRE_HEIGHT = 8.0

# The Cook Strait cables: points no further apart than this near the
# shore, where the sea floor shows, and beyond, m.
CABLE_QUERY = """
[out:json][timeout:120];
way["power"="cable"]["location"="underwater"]["voltage"="350000"](-41.6,174.0,-41.2,174.75);
out geom;
"""
CABLE_SHORE = 1500.0
CABLE_STEP_SHORE = 40.0
CABLE_STEP = 300.0


def cached(name, fetch):
    path = CACHE_DIR / name
    if not path.exists():
        print(f"  fetching {name}")
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(fetch()))
    return json.loads(path.read_text())


def post(url, params):
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(params).encode(),
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


def transpower(layer):
    """Every feature of a Transpower layer that touches the terrain's root."""
    w, s, e, n = terrain.root_bounds()
    features = []
    while True:
        page = post(
            f"{TRANSPOWER}/{layer}/FeatureServer/0/query",
            {
                "where": "1=1",
                "geometry": f"{w},{s},{e},{n}",
                "geometryType": "esriGeometryEnvelope",
                "inSR": 2193,
                "outSR": 2193,
                "outFields": "*",
                "orderByFields": "OBJECTID",
                "resultOffset": len(features),
                "f": "json",
            },
        )
        if "error" in page:
            raise SystemExit(f"{layer}: {page['error']}")
        features += page["features"]
        if not page.get("exceededTransferLimit"):
            return features


class Ground:
    """
    The published terrain's height at a point: bilinear in the finest tile
    over it, sea floor and all, as scripts/lib/geo.mjs reads it.
    """

    def __init__(self):
        manifest = json.loads((TERRAIN_DIR / "manifest.json").read_text())
        self.origin = manifest["origin"]
        self.root = manifest["rootSize"]
        self.cells = manifest["tileCells"]
        self.apron = manifest["apron"]
        self.offset = manifest["encoding"]["offset"]
        self.scale = manifest["encoding"]["scale"]
        self.samples = self.cells + 1 + 2 * self.apron
        self.levels = sorted((l["level"] for l in manifest["levels"]), reverse=True)
        self.tiles = {}

    def tile(self, level, x, y):
        key = (level, x, y)
        if key not in self.tiles:
            path = TERRAIN_DIR / str(level) / str(x) / f"{y}.webp"
            heights = None
            if path.exists():
                # Streets, where a tile has them, are rows under the heights.
                rgb = np.asarray(Image.open(path).convert("RGB"))[: self.samples].astype(np.float32)
                heights = (rgb[..., 0] * 256 + rgb[..., 1]) / self.scale - self.offset
            self.tiles[key] = heights
        return self.tiles[key]

    def at(self, east, north):
        wx = east - self.origin[0] + self.root / 2
        wz = -(north - self.origin[1]) + self.root / 2
        for level in self.levels:
            size = self.root / 2**level
            tx, ty = int(wx // size), int(wz // size)
            heights = self.tile(level, tx, ty)
            if heights is None:
                continue
            u = (wx - tx * size) / size * self.cells + self.apron
            v = (wz - ty * size) / size * self.cells + self.apron
            i, j = int(u), int(v)
            fu, fv = u - i, v - j
            top = heights[j, i] * (1 - fu) + heights[j, i + 1] * fu
            bottom = heights[j + 1, i] * (1 - fu) + heights[j + 1, i + 1] * fu
            return float(top * (1 - fv) + bottom * fv)
        raise SystemExit(f"no terrain under {east}, {north}")


_local = threading.local()


def _source(url):
    """A COG, opened once per thread: datasets aren't shared between them."""
    if not hasattr(_local, "sources"):
        _local.sources = {}
    if url not in _local.sources:
        try:
            _local.sources[url] = rasterio.open(url)
        except rasterio.errors.RasterioIOError:
            _local.sources[url] = None
    return _local.sources[url]


def _measure(job):
    """A structure's height: the surface's top over it, less the ground at its centre."""
    east, north, radius = job
    (sheet,) = terrain.sheets_for((east, north, east + 1, north + 1))
    dem = _source(f"{terrain.SOURCE}/{sheet}.tiff")
    dsm = _source(f"{DSM_SOURCE}/{sheet}.tiff")
    if dem is None or dsm is None:
        return None
    ground = dem.read(
        1,
        window=from_bounds(east - 1, north - 1, east + 1, north + 1, dem.transform),
        boundless=True,
        fill_value=terrain.NODATA,
    )
    reach = int(np.ceil(radius)) + 1
    surface = dsm.read(
        1,
        window=from_bounds(east - reach, north - reach, east + reach, north + reach, dsm.transform),
        boundless=True,
        fill_value=terrain.NODATA,
    )
    rows, cols = np.indices(surface.shape)
    centre = (np.array(surface.shape) - 1) / 2
    near = np.hypot(rows - centre[0], cols - centre[1]) <= radius
    tops = surface[near & (surface > terrain.NODATA + 1)]
    ground = ground[ground > terrain.NODATA + 1]
    if not len(tops) or not len(ground):
        return None
    return round(float(tops.max() - ground.mean()), 1)


def measured_heights(structures):
    """Lidar heights by structure name, None where there's no survey. Cached."""
    path = CACHE_DIR / "heights.json"
    heights = json.loads(path.read_text()) if path.exists() else {}
    missing = [s for s in structures if s["name"] not in heights]
    if missing:
        print(f"  measuring {len(missing)} structures in the lidar")
        jobs = [(s["east"], s["north"], TOP_RADIUS[s["type"] in POLES]) for s in missing]
        with rasterio.Env(**terrain.GDAL_ENV), ThreadPoolExecutor(WORKERS) as pool:
            for s, height in zip(missing, pool.map(_measure, jobs)):
                heights[s["name"]] = height
        path.write_text(json.dumps(heights, indent=0, sort_keys=True))
    return heights


def believed_heights(structures):
    """
    Each structure's height: the lidar's where that's plausible, otherwise
    the median of its line's others of the same type.
    """
    lidar = measured_heights(structures)
    by_line = defaultdict(list)
    for s in structures:
        low, high = PLAUSIBLE[s["type"] in POLES]
        height = lidar.get(s["name"])
        s["height"] = height if height is not None and low <= height <= high else None
        if s["height"] is not None:
            by_line[(s["line"], s["type"])].append(s["height"])
    guessed = 0
    for s in structures:
        if s["height"] is None:
            guessed += 1
            others = by_line.get((s["line"], s["type"]))
            s["height"] = (
                round(float(np.median(others)), 1) if others else DEFAULT_HEIGHT[s["type"] in POLES]
            )
    print(f"  {len(structures) - guessed} heights from the lidar, {guessed} from their lines")


def network():
    """
    The structures on lines of MIN_KV and up, and the spans between them:
    (structures, spans as pairs of indices). Terminations a few metres apart
    are one gantry.
    """
    w, s, e, n = terrain.root_bounds()
    lines = [
        f
        for f in cached("lines.json", lambda: transpower("TransmissionLines"))
        if f["attributes"]["status"] == "COMMISSIONED"
    ]
    volts = {f["attributes"]["MXLOCATION"]: float(f["attributes"]["designvolt"]) for f in lines}
    overhead = [
        f
        for f in lines
        if f["attributes"]["type"] == "TRANSLINE" and volts[f["attributes"]["MXLOCATION"]] >= MIN_KV
    ]

    def line_of(name):
        """A structure is named for its line, then its number on it."""
        return max((line for line in volts if name.startswith(line)), key=len, default=None)

    points = []
    for f in cached("structures.json", lambda: transpower("Structures")):
        a = f["attributes"]
        if a["status"] != "COMMISSIONED" or a["LongType"] not in TYPES:
            continue
        line = line_of(a["MXLOCATION"])
        points.append(
            {
                "name": a["MXLOCATION"],
                "east": f["geometry"]["x"],
                "north": f["geometry"]["y"],
                "type": TYPES[a["LongType"]],
                "line": line,
                "kv": volts.get(line, 0.0),
            }
        )
    tree = cKDTree([(p["east"], p["north"]) for p in points])

    edges = set()
    unplaced = 0
    for f in overhead:
        kv = volts[f["attributes"]["MXLOCATION"]]
        for path in f["geometry"]["paths"]:
            last = None
            for x, y in path:
                if not (w <= x <= e and s <= y <= n):
                    # Off the map: the line picks up again if it comes back.
                    last = None
                    continue
                distance, i = tree.query((x, y))
                if distance > SNAP:
                    unplaced += 1
                    continue
                # A structure shared with a lesser line carries the greater.
                points[i]["kv"] = max(points[i]["kv"], kv)
                if last is not None and last != i:
                    edges.add((min(last, i), max(last, i)))
                last = i
    if unplaced:
        print(f"  {unplaced} line vertices with no structure, passed over")

    # Terminations a few metres apart land on one gantry.
    used = sorted({i for edge in edges for i in edge})
    ends = [i for i in used if points[i]["type"] == "X"]
    group = {i: i for i in used}

    def find(i):
        while group[i] != i:
            group[i] = group[group[i]]
            i = group[i]
        return i

    if ends:
        ends_tree = cKDTree([(points[i]["east"], points[i]["north"]) for i in ends])
        for a, b in ends_tree.query_pairs(GANTRY):
            group[find(ends[a])] = find(ends[b])

    members = defaultdict(list)
    for i in used:
        members[find(i)].append(i)

    structures = []
    index = {}
    for root, group_members in sorted(members.items()):
        first = points[group_members[0]]
        for i in group_members:
            index[i] = len(structures)
        structures.append(
            {
                **first,
                "east": float(np.mean([points[i]["east"] for i in group_members])),
                "north": float(np.mean([points[i]["north"] for i in group_members])),
                "kv": max(points[i]["kv"] for i in group_members),
            }
        )

    spans = sorted(
        {(min(index[a], index[b]), max(index[a], index[b])) for a, b in edges if index[a] != index[b]}
    )
    # Two gantries joined are a busbar, not a line.
    spans = [
        (a, b) for a, b in spans if not (structures[a]["type"] == "X" and structures[b]["type"] == "X")
    ]
    return structures, spans


def tightest(a, b, ground):
    """
    Where the ground comes nearest a span's wires: how far along, 0..1, and
    how far the ground there rises over the line between the structures'
    feet, m (less than nothing across a valley). The scene sags the span no
    further than clears it.
    """
    length = np.hypot(b["east"] - a["east"], b["north"] - a["north"])
    count = max(int(length / SPAN_STEP), 2)
    ts = np.linspace(0, 1, count + 1)[1:-1]
    rise = np.array(
        [
            ground.at(a["east"] + (b["east"] - a["east"]) * t, a["north"] + (b["north"] - a["north"]) * t)
            for t in ts
        ]
    ) - (a["ground"] + (b["ground"] - a["ground"]) * ts)
    # The sag that would touch the ground at each point: least is tightest.
    allowed = (WIRE_HEIGHT - VERTICAL_SCALE * rise) / (4 * ts * (1 - ts))
    i = int(np.argmin(allowed))
    return round(float(ts[i]), 2), round(float(rise[i]), 1)


def densify(points, step_at):
    """A polyline with points added so none are further apart than step_at(distance along)."""
    out = [points[0]]
    along = 0.0
    for a, b in zip(points, points[1:]):
        length = float(np.hypot(b[0] - a[0], b[1] - a[1]))
        pieces = max(int(np.ceil(length / step_at(along))), 1)
        for k in range(1, pieces + 1):
            out.append((a[0] + (b[0] - a[0]) * k / pieces, a[1] + (b[1] - a[1]) * k / pieces))
        along += length
    return out


def cables(ground):
    """
    The Cook Strait cables from the shore at Oteranga Bay out to the map's
    edge: [easting, northing, sea floor] along each. What's above the tide
    line is buried in the beach, and left out.
    """
    w, s, e, n = terrain.root_bounds()
    ways = cached(
        "cables.json",
        lambda: post("https://overpass-api.de/api/interpreter", {"data": CABLE_QUERY}),
    )["elements"]
    found = []
    for way in ways:
        points = terrain.to_nztm([(p["lon"], p["lat"]) for p in way["geometry"]])
        # From the North Island's shore.
        if points[0][0] < points[-1][0]:
            points = points[::-1]
        kept = [points[0]]
        for a, b in zip(points, points[1:]):
            if b[0] < w:
                # Cut at the map's western edge.
                t = (w - a[0]) / (b[0] - a[0])
                kept.append((w, a[1] + (b[1] - a[1]) * t))
                break
            kept.append(b)
        kept = densify(kept, lambda along: CABLE_STEP_SHORE if along < CABLE_SHORE else CABLE_STEP)
        floor = [(x, y, ground.at(min(max(x, w + 1), e - 1), y)) for x, y in kept]
        # From the last point above the tide line on.
        ashore = max((i for i, p in enumerate(floor) if p[2] >= 0), default=0)
        found.append(floor[ashore:])
    found.sort(key=lambda cable: -cable[-1][1])
    return found


def write(structures, spans, cable_list):
    def row(values):
        return "  [" + ", ".join(values) + "],"

    structure_rows = [
        row(
            [
                f"{s['east']:.1f}",
                f"{s['north']:.1f}",
                f"{s['ground']:.1f}",
                f"{s['height']:.1f}",
                f'"{s["type"]}"',
                f"{s['kv']:g}",
            ]
        )
        for s in structures
    ]
    span_rows = [row([str(v) for v in span]) for span in spans]
    cable_rows = []
    for cable in cable_list:
        cable_rows.append("  [")
        cable_rows += [f"    [{x:.1f}, {y:.1f}, {z:.1f}]," for x, y, z in cable]
        cable_rows.append("  ],")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        f"""// Generated by scripts/power/build_power.py. Do not edit.
//
// Towers, poles and lines © Transpower New Zealand (CC BY 4.0); the Cook
// Strait cables © OpenStreetMap contributors (ODbL), from LINZ's charts;
// heights from LINZ's lidar (CC BY 4.0). Eastings and northings are
// NZTM2000 metres; ground is the terrain's height, before its vertical
// scale.

/**
 * Transpower's kinds of structure: steel towers carrying two circuits,
 * three or one (D, T, S), single poles carrying two or one (DP, SP), a pi
 * pole (PI: two poles and a beam), and a line's termination at a
 * substation's gantry (X).
 */
export type StructureType = "D" | "T" | "S" | "DP" | "SP" | "PI" | "X";

/**
 * Where a structure stands, how tall the lidar found it (0 for a
 * termination, which wasn't measured), and the greatest design voltage of
 * the lines on it, kV. The HVDC link is the 350.
 */
export type Structure = [
  easting: number,
  northing: number,
  ground: number,
  height: number,
  type: StructureType,
  kv: number,
];

/**
 * Two structures, by their place in STRUCTURES, with conductors strung
 * between them; and where the ground comes nearest the wires: how far
 * along (`at`, 0..1), and how far it rises there over the line between the
 * structures' feet, m.
 */
export type Span = [a: number, b: number, at: number, rise: number];

export const STRUCTURES: Structure[] = [
{chr(10).join(structure_rows)}
];

export const SPANS: Span[] = [
{chr(10).join(span_rows)}
];

/**
 * The HVDC link's three cables across Cook Strait, each from the beach at
 * Oteranga Bay out to the map's edge, north to south: [easting, northing,
 * sea floor].
 */
export const CABLES: [easting: number, northing: number, floor: number][][] = [
{chr(10).join(cable_rows)}
];
"""
    )


def main():
    ground = Ground()
    structures, spans = network()
    for s in structures:
        s["ground"] = max(ground.at(s["east"], s["north"]), 0.0)
    believed_heights([s for s in structures if s["type"] != "X"])
    for s in structures:
        s.setdefault("height", 0.0)

    rows = [(a, b, *tightest(structures[a], structures[b], ground)) for a, b in spans]

    cable_list = cables(ground)
    write(structures, rows, cable_list)

    counts = defaultdict(int)
    for s in structures:
        counts[s["type"]] += 1
    print(
        f"{len(structures)} structures ("
        + ", ".join(f"{count} {kind}" for kind, count in sorted(counts.items()))
        + f"), {len(spans)} spans, "
        + f"{len(cable_list)} cables of {', '.join(str(len(c)) for c in cable_list)} points"
    )


if __name__ == "__main__":
    main()
