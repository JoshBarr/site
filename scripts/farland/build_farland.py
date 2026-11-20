"""
Builds public/farland/land.bin: the top of the South Island as one coarse
mesh, for the scene's horizon. From Wellington the Marlborough Sounds are
30 to 60 km off across Cook Strait and the Kaikōura ranges 120 to 150 km,
well past the terrain's root: this is what stands there, seen through the
haze.

Source: NIWA's NZ 250m bathymetry grid (nzbathy_2016.tif, CC BY 3.0 NZ),
whose land is at the same 250 m. BATHYMETRY must point at it, as for the
terrain build.

The mesh is a right-triangulated irregular network (Evans et al. 2001, as
in Mapbox's martini): triangles split until they're within a tolerance of
the grid, here an angle seen from the scene, so the mesh coarsens with
distance. Sea is left out, but for the triangles across each coast: their
vertices at sea are at -SEA, and the client draws them down to height 0.

land.bin, little-endian:
  uint32 x 5     vertices, triangles, west, north (NZTM, m), cell (m)
  int16 x 3 each vertex: column east of west, row south of north, height (m)
  uint16 x 3     each triangle, anticlockwise from above, the farthest
                 from the scene first: drawn in that order, the nearer
                 cover the farther even where the depth buffer can't tell
                 them apart

Usage:
  BATHYMETRY=~/Downloads/nzbathy2016/nzbathy_2016.tif \\
    .venv-terrain/bin/python -I scripts/farland/build_farland.py
"""

import os
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

ROOT_DIR = Path(__file__).resolve().parents[2]
OUT = ROOT_DIR / "public" / "farland" / "land.bin"

BATHYMETRY = os.environ.get("BATHYMETRY")

# The scene's origin (see scripts/terrain/build_tiles.py).
ORIGIN = (1748000.0, 5428000.0)

# The grid: SIZE samples a side (2^k + 1, for the triangulation), CELL apart,
# its north-east corner at (EAST, NORTH). East of EAST is the North Island.
SIZE = 1025
CELL = 250.0
EAST = 1724000.0
NORTH = 5514000.0
WEST = EAST - (SIZE - 1) * CELL

# Land this far from the origin is left out, m, sinking to the sea over the
# last TAPER of it: past it, the Earth's curve and the nearer ranges hide
# all but the odd summit.
RADIUS = 190000.0
TAPER = 20000.0

# Height given to the sea, m: the coast is where a triangle crosses 0.
SEA = -60.0

# The mesh is within this angle of the grid, rad, seen from as near as the
# camera gets: the scene's edge is REACH from its origin, and nothing counts
# as nearer than NEAREST.
ANGLE = 0.0022
REACH = 20000.0
NEAREST = 15000.0


def read_heights():
    """The grid's heights, m, row 0 the northernmost, sea and all."""
    if not BATHYMETRY:
        sys.exit("set BATHYMETRY to NIWA's NZ bathymetry grid (nzbathy_2016.tif)")
    out = np.full((SIZE, SIZE), np.nan, dtype=np.float32)
    with rasterio.open(os.path.expanduser(BATHYMETRY)) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=out,
            # Samples are pixel centres: the pixels reach half a cell past.
            dst_transform=from_origin(WEST - CELL / 2, NORTH + CELL / 2, CELL, CELL),
            dst_crs=CRS.from_epsg(2193),
            src_nodata=src.nodata,
            dst_nodata=np.nan,
            resampling=Resampling.cubic,
        )
    return np.nan_to_num(out, nan=SEA)


def distances():
    """Each sample's distance from the scene's origin, m."""
    east = WEST + np.arange(SIZE) * CELL - ORIGIN[0]
    north = NORTH - np.arange(SIZE) * CELL - ORIGIN[1]
    return np.hypot(east[None, :], north[:, None])


def split(a, b, c):
    """A level of triangles, each halved at its hypotenuse's middle."""
    m = (a + b) >> 1
    return (
        np.concatenate([c, b]),
        np.concatenate([a, c]),
        np.concatenate([m, m]),
    )


def roots():
    """The grid's two halves: right angle at c, hypotenuse from a to b."""
    last = SIZE - 1
    a = np.array([[0, 0], [last, last]])
    b = np.array([[last, last], [0, 0]])
    c = np.array([[last, 0], [0, last]])
    return a, b, c


def flat(points):
    """Indices into the grid, of points as (x, y)."""
    return points[:, 1] * SIZE + points[:, 0]


def errors(heights, tolerance):
    """
    For each sample, how far out the mesh would be without it, as a multiple
    of the tolerance there: the most of its own triangle's and of every
    triangle's within that one. Over 1, it's needed.
    """
    levels = [roots()]
    # Down to triangles a cell on a side, which have no middle to add.
    while abs(levels[-1][0][0] - levels[-1][2][0]).sum() > 1:
        levels.append(split(*levels[-1]))

    height = heights.ravel()
    allowed = tolerance.ravel()
    out = np.zeros(SIZE * SIZE, dtype=np.float32)

    for depth in range(len(levels) - 2, -1, -1):
        a, b, c = levels[depth]
        middle = flat((a + b) >> 1)
        between = (height[flat(a)] + height[flat(b)]) / 2
        error = np.abs(between - height[middle]) / allowed[middle]

        if depth < len(levels) - 2:
            left = flat((a + c) >> 1)
            right = flat((b + c) >> 1)
            error = np.maximum(error, np.maximum(out[left], out[right]))

        np.maximum.at(out, middle, error)

    return out


def triangulate(needed):
    """The triangles, as indices into the grid, anticlockwise from above."""
    level = roots()
    found = []

    while len(level[0]):
        a, b, c = level
        divisible = np.abs(a - c).sum(axis=1) > 1
        divide = divisible & (needed[flat((a + b) >> 1)] > 1)
        found.append(np.stack([flat(a[~divide]), flat(b[~divide]), flat(c[~divide])], axis=1))
        level = split(a[divide], b[divide], c[divide])

    return np.concatenate(found)


def main():
    heights = read_heights()
    distance = distances()

    # Out to the radius, and no further.
    fade = np.clip((RADIUS - distance) / TAPER, 0, 1)
    fade = fade * fade * (3 - 2 * fade)
    heights = np.where(heights > 0, heights * fade, heights)
    heights = np.where(heights > 0, heights, SEA).astype(np.float32)

    tolerance = np.maximum(distance - REACH, NEAREST) * ANGLE
    triangles = triangulate(errors(heights, tolerance))

    # Only what has land in it.
    height = heights.ravel()
    triangles = triangles[(height[triangles] > 0).any(axis=1)]

    # The farthest first. (Columns run east and rows south, as the scene's x
    # and z do: a to b to c is anticlockwise from above as it is.)
    far = distance.ravel()[triangles].mean(axis=1)
    triangles = triangles[np.argsort(-far, kind="stable")]

    used, indices = np.unique(triangles, return_inverse=True)
    indices = indices.reshape(triangles.shape)
    if len(used) > 65535:
        sys.exit(f"{len(used)} vertices: too many for 16-bit indices, raise ANGLE")

    # To the metre, and land stays land.
    metres = np.round(height[used])
    metres = np.where(height[used] > 0, np.maximum(metres, 1), metres)
    vertices = np.stack([used % SIZE, used // SIZE, metres], axis=1).astype("<i2")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(
            np.array(
                [len(vertices), len(triangles), WEST, NORTH, CELL], dtype="<u4"
            ).tobytes()
        )
        f.write(vertices.tobytes())
        f.write(indices.astype("<u2").tobytes())

    print(
        f"  {len(vertices)} vertices, {len(triangles)} triangles, "
        f"highest {height[used].max():.0f} m, {OUT.stat().st_size / 1024:.0f} KB"
    )


if __name__ == "__main__":
    main()
