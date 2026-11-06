"""
Builds public/wind/field.png: how the land bends and slows a wind that's
uniform out at sea, for the scene's wind trails.

The surface wind is treated as a layer under a lid, LID metres up. The
terrain takes up part of that depth, so air must speed up over ridges and
through gaps, or go round high ground, for as much to get through. That's a
mass-consistent adjustment (as WindNinja's, flattened to one layer): find
the potential phi for which u = u0 + grad(phi) satisfies div(H u) = 0, by
solving div(H grad(phi)) = -div(H u0). Rough land then slows it: a log-law
ratio of the 10 m wind over each cover to that over open water.

The equation's linear in u0, so it's solved for a unit wind toward the east
and one toward the south; the scene adds them in proportion to the
forecast's wind. Rows 0..N-1 of the PNG are the eastward solution, rows
N..2N-1 the southward one. R and G are the flow's x (east) and z (south)
components, each 128 + v * SCALE. B in the top half is how much land there
is round about (0..255), blurred over a few hundred metres: the trails rise
over it gently, clear of trees and houses, rather than stepping up at the
shore. B in the bottom half is unused.

Its constants were tuned (scripts/wind/tune_wind.py) to GWRC's wind
stations' readings against the wind out at sea (public/wind/stations.json,
from build_stations.py).

Reads public/terrain (heights, landcover.png), so run that step first.
"""

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import sparse
from scipy.ndimage import gaussian_filter, zoom
from scipy.sparse.linalg import splu

ROOT = Path(__file__).resolve().parents[2]
TERRAIN = ROOT / "public" / "terrain"
OUT = ROOT / "public" / "wind"

# Cells across the terrain's root square: 128 m each.
N = 512
# Height of the lid over the sea, and the least depth left under it, m.
LID = 1000.0
MIN_DEPTH = 50.0
# 1 lets the flow go over hills, speeding up; higher sends it round them.
POWER = 2.0
# How much of that stiffness slows the air on high ground (0..1): the lee of
# a hill is calmer, but its top is windier than the valleys.
SHELTER = 0.6
# Metres over which the land's edge is blurred, for the trails to rise.
LAND_BLUR = 250.0
# The most any cell's flow speeds up the wind.
MAX_SPEEDUP = 2.0
# Encoding: 128 + v * SCALE, so components up to about ±4 of the wind.
SCALE = 32.0

# 10 m wind over each cover relative to open water. A log law (z0 0.03 m
# for grass, 1 m for forest and city) would say 0.89 and 0.66, but the
# stations read about 0.45 of the sea's wind wherever they are, whatever's
# round them: they can't tell grass from forest, so it's kept in order
# about that.
OPEN = 0.5
SCRUB = 0.45
TALL = 0.4
# The slowing takes a kilometre or so of fetch to set in.
ROUGH_SMOOTHING = 600.0

# Near the ground, steep slopes turn the wind along them: this much of the
# part crossing the contours goes, on slopes from GENTLE to STEEP (rise/run),
# over hills smoothed by SLOPE_SMOOTHING m.
ALONG_SLOPE = 0.7
GENTLE = 0.05
STEEP = 0.35
SLOPE_SMOOTHING = 250.0
# Tops standing above the land around (within EXPOSURE_RADIUS m) catch more
# wind and hollows less: up to this much more, at EXPOSED metres proud.
# Fitted to Belmont's hilltop against the valley stations; wider radii fit
# them worse.
EXPOSURE = 0.9
EXPOSED = 200.0
EXPOSURE_RADIUS = 1500.0
# Hollows are calmer, down to this fraction of EXPOSURE.
HOLLOW = 0.6


@dataclass(frozen=True)
class Effects:
    """What's done to the flow after the solve: tuned as one."""

    along_slope: float = ALONG_SLOPE
    exposure: float = EXPOSURE
    exposure_radius: float = EXPOSURE_RADIUS
    hollow: float = HOLLOW
    open: float = OPEN
    scrub: float = SCRUB
    tall: float = TALL
    max_speedup: float = MAX_SPEEDUP


def mosaic(manifest, level):
    """Heights (m) over the root at `level`, NaN where there's no tile."""
    cells = manifest["tileCells"]
    apron = manifest["apron"]
    offset = manifest["encoding"]["offset"]
    scale = manifest["encoding"]["scale"]
    count = 2**level
    out = np.full((count * cells, count * cells), np.nan, dtype=np.float32)

    for x in range(count):
        for y in range(count):
            path = TERRAIN / str(level) / str(x) / f"{y}.webp"

            if not path.exists():
                continue
            rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.int32)
            heights = ((rgb[..., 0] << 8) | rgb[..., 1]) / scale - offset
            inner = heights[apron : apron + cells, apron : apron + cells]
            out[y * cells : (y + 1) * cells, x * cells : (x + 1) * cells] = inner

    return out


def ground(manifest):
    """Heights at the solve's cells, m, from the finest level that has them."""
    heights = None

    for level in range(0, 3):
        layer = mosaic(manifest, level)
        factor = N / layer.shape[0]
        layer = zoom(layer, factor, order=1) if factor != 1 else layer

        if heights is None:
            heights = layer
        else:
            heights = np.where(np.isnan(layer), heights, layer)

    return np.nan_to_num(heights, nan=0.0)


def cover(manifest):
    """Each cell's tall cover (forest, city) and scrub, 0..1."""
    lc = manifest["landcover"]
    west, south, east, north = lc["bounds"]
    image = np.asarray(Image.open(TERRAIN / "landcover.png").convert("RGB"))
    cover = image.astype(np.float32) / 255
    rows, cols = cover.shape[:2]

    half = manifest["rootSize"] / 2
    cell = manifest["rootSize"] / N
    ox, oy = manifest["origin"]
    centres = -half + (np.arange(N) + 0.5) * cell
    easting = ox + centres[None, :]
    northing = oy - centres[:, None]

    col = np.clip(((easting - west) / (east - west) * cols).astype(int), 0, cols - 1)
    row = np.clip(((north - northing) / (north - south) * rows).astype(int), 0, rows - 1)
    inside = (
        (easting >= west) & (easting < east) & (northing > south) & (northing <= north)
    )

    forest = np.where(inside, cover[row, col, 0], 0)
    scrub = np.where(inside, cover[row, col, 1], 0)
    urban = np.where(inside, cover[row, col, 2], 0)
    tall = np.clip(forest + urban, 0, 1)
    scrub = np.clip(scrub, 0, 1 - tall)

    return tall, scrub


def roughness(heights, tall, scrub, cell, effects):
    """Each cell's 10 m wind as a fraction of open water's."""
    e = effects
    land = heights > 0.5
    factor = np.where(
        land, e.open + (e.tall - e.open) * tall + (e.scrub - e.open) * scrub, 1.0
    )

    return gaussian_filter(factor, ROUGH_SMOOTHING / cell, mode="nearest")


def solve(heights, cell, lid=LID, min_depth=MIN_DEPTH, power=POWER, shelter=SHELTER):
    """The flow for a unit wind east and a unit wind south: (2, N, N, 2)."""
    depth = np.maximum(lid - np.maximum(heights, 0), min_depth)
    # How readily air moves through each cell: the layer's depth times a
    # ratio that makes shallow ground stiffer still, so the flow goes round.
    ease = depth * (depth / lid) ** (power - 1)
    index = np.arange(N * N).reshape(N, N)

    # On the faces between cells: east faces (N, N-1), south (N-1, N).
    east = 0.5 * (ease[:, :-1] + ease[:, 1:])
    south = 0.5 * (ease[:-1, :] + ease[1:, :])

    # div(K grad phi) by face fluxes, times cell^2. Past the edges phi is 0,
    # through a face as easy as the edge cell.
    rows, cols, values = [], [], []
    diagonal = np.zeros((N, N))

    def couple(a, b, conductance):
        rows.extend([a.ravel(), b.ravel()])
        cols.extend([b.ravel(), a.ravel()])
        values.extend([conductance.ravel(), conductance.ravel()])

    couple(index[:, :-1], index[:, 1:], east)
    couple(index[:-1, :], index[1:, :], south)
    diagonal[:, :-1] -= east
    diagonal[:, 1:] -= east
    diagonal[:-1, :] -= south
    diagonal[1:, :] -= south
    diagonal[:, 0] -= ease[:, 0]
    diagonal[:, -1] -= ease[:, -1]
    diagonal[0, :] -= ease[0, :]
    diagonal[-1, :] -= ease[-1, :]

    rows.append(index.ravel())
    cols.append(index.ravel())
    values.append(diagonal.ravel())

    matrix = sparse.csc_matrix(
        (np.concatenate(values), (np.concatenate(rows), np.concatenate(cols))),
        shape=(N * N, N * N),
    )
    lu = splu(matrix)

    ease_e = np.concatenate([ease[:, :1], east, ease[:, -1:]], axis=1)
    ease_s = np.concatenate([ease[:1, :], south, ease[-1:, :]], axis=0)
    flows = []

    for wind in ((1.0, 0.0), (0.0, 1.0)):
        # What u0 alone would carry out of each cell (cell^2 * div).
        divergence = (
            (ease_e[:, 1:] - ease_e[:, :-1]) * wind[0]
            + (ease_s[1:, :] - ease_s[:-1, :]) * wind[1]
        ) * cell

        phi = lu.solve(-divergence.ravel()).reshape(N, N)

        # Driving gradient on each face; what crosses it is that times ease.
        padded = np.pad(phi, 1)
        face_e = wind[0] + (padded[1:-1, 1:] - padded[1:-1, :-1]) / cell
        face_s = wind[1] + (padded[1:, 1:-1] - padded[:-1, 1:-1]) / cell
        flux_e = face_e * ease_e
        flux_s = face_s * ease_s

        # Check: what flows into each cell flows out.
        net = flux_e[:, 1:] - flux_e[:, :-1] + flux_s[1:, :] - flux_s[:-1, :]
        before = np.abs(divergence).max() / cell
        print(f"  wind {wind}: imbalance {np.abs(net).max():.2e} (u0 alone {before:.2e})")

        # The cell's velocity: the mean drive across its faces, slowed where
        # the layer's shallow. With shelter 1 that's what crosses its faces
        # over its depth; less keeps the steering but not all the slowing,
        # so tops and ridges stay windy.
        slowing = (depth / lid) ** ((power - 1) * shelter)
        u = 0.5 * (face_e[:, 1:] + face_e[:, :-1]) * slowing
        v = 0.5 * (face_s[1:, :] + face_s[:-1, :]) * slowing
        flows.append(np.stack([u, v], axis=-1))

    return np.stack(flows)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)

    return t * t * (3 - 2 * t)


def terrain_effects(flows, heights, cell, effects):
    """Turns the flows along steep slopes and speeds them on tops, in place."""
    e = effects
    smooth = gaussian_filter(np.maximum(heights, 0), SLOPE_SMOOTHING / cell)
    # Rows run south, so the gradient's (z, x).
    gz, gx = np.gradient(smooth, cell)
    slope = np.hypot(gx, gz)
    nx = gx / np.maximum(slope, 1e-6)
    nz = gz / np.maximum(slope, 1e-6)
    turn = e.along_slope * smoothstep(GENTLE, STEEP, slope)

    for flow in flows:
        across = flow[..., 0] * nx + flow[..., 1] * nz
        flow[..., 0] -= turn * across * nx
        flow[..., 1] -= turn * across * nz

    land = heights > 0.5
    proud = heights - gaussian_filter(heights, e.exposure_radius / cell)
    exposure = np.where(
        land, 1 + e.exposure * np.clip(proud / EXPOSED, -e.hollow, 1), 1.0
    )
    flows *= exposure[None, :, :, None]


def finish(raw, heights, tall, scrub, cell, effects):
    """The solve's flows with the land's effects, capped: (2, N, N, 2)."""
    flows = raw.copy()
    terrain_effects(flows, heights, cell, effects)
    flows *= roughness(heights, tall, scrub, cell, effects)[None, :, :, None]
    # On peaks the layer's thinnest and the drive can run away: capped.
    speed = np.linalg.norm(flows, axis=-1, keepdims=True)
    flows *= np.minimum(1, effects.max_speedup / np.maximum(speed, 1e-9))

    return flows


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--lid", type=float, default=LID)
    parser.add_argument("--min-depth", type=float, default=MIN_DEPTH)
    parser.add_argument("--power", type=float, default=POWER)
    parser.add_argument("--shelter", type=float, default=SHELTER)
    parser.add_argument("--out", type=Path, default=OUT / "field.png")
    args = parser.parse_args()

    manifest = json.loads((TERRAIN / "manifest.json").read_text())
    cell = manifest["rootSize"] / N

    heights = ground(manifest)
    tall, scrub = cover(manifest)
    raw = solve(heights, cell, args.lid, args.min_depth, args.power, args.shelter)
    flows = finish(raw, heights, tall, scrub, cell, Effects())

    encoded = np.clip(np.round(128 + flows * SCALE), 0, 255).astype(np.uint8)
    image = np.zeros((2 * N, N, 3), dtype=np.uint8)
    image[:N, :, :2] = encoded[0]
    image[N:, :, :2] = encoded[1]
    land = gaussian_filter((heights > 0.5).astype(np.float64), LAND_BLUR / cell)
    image[:N, :, 2] = np.round(land * 255).astype(np.uint8)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(image, "RGB").save(args.out, optimize=True)

    speed = np.linalg.norm(flows, axis=-1)
    print(
        f"{args.out.name}: {N}x{2 * N}, speed east {speed[0].min():.2f}..{speed[0].max():.2f}, "
        f"south {speed[1].min():.2f}..{speed[1].max():.2f}, "
        f"clipped {np.mean(np.abs(flows) * SCALE > 127) * 100:.3f}%"
    )


if __name__ == "__main__":
    sys.exit(main())
