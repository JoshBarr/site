"""
Tunes build_wind.py's land effects to GWRC's wind stations: for each station
and direction in public/wind/stations.json (build_stations.py), the field's
gain there against what the station reads against the wind out at sea.

Fits how much open ground and tall cover (forest, city) slow the wind and
how much more exposed ground catches, for each of a few SHELTERS and
RADII, scoring each by the squared log of the speeds' ratio plus a little
for the turn. Willis St's mast is left out: it's 6 m up
in a street, under the roofs the trails run over.

Prints the stations' fit before and after, and how well each is predicted
when it's left out of the fit (so how far the fit can be trusted between
them), then the constants to put in build_wind.py. Changes nothing.
"""

import importlib.util
import json
import math
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

spec = importlib.util.spec_from_file_location("build_wind", HERE / "build_wind.py")
bw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bw)

LEFT_OUT = {"Willis St AQ"}
SHELTERS = [0.6]
# Across which a place is compared with the land round it, m.
RADII = [1500.0, 3000.0, 5000.0]
# Turns count this much against the speed's log ratio, per radian squared.
TURN_WEIGHT = 0.1
# Hours from a direction count up to this: the common ones don't swamp the
# rest.
HOURS_CAP = 400.0

# Fitted, as logs, with their bounds.
FREE = {
    "open": (0.1, 1.0),
    "tall": (0.05, 1.0),
    "exposure": (0.01, 3.0),
}


def sample(flows, cell, root, world):
    """Bilinear, as the scene's: (2 solutions, 2 components) at x/z."""
    n = flows.shape[1]
    u = (world[0] + root / 2) / cell - 0.5
    v = (world[1] + root / 2) / cell - 0.5
    i, j = int(math.floor(u)), int(math.floor(v))
    fu, fv = u - i, v - j
    out = np.zeros((2, 2))

    for di, dj, w in ((0, 0, (1 - fu) * (1 - fv)), (1, 0, fu * (1 - fv)), (0, 1, (1 - fu) * fv), (1, 1, fu * fv)):
        out += w * flows[:, min(max(j + dj, 0), n - 1), min(max(i + di, 0), n - 1)]

    return out


def gains(at, directions):
    """The field's complex gain at a point (from `sample`) for winds from each direction."""
    angle = np.radians(np.arange(directions) * 360 / directions + 180)
    toward = np.stack([np.sin(angle), -np.cos(angle)], axis=-1)
    flow = toward[:, :1] * at[0] + toward[:, 1:] * at[1]

    return (flow[:, 0] + 1j * flow[:, 1]) / (toward[:, 0] + 1j * toward[:, 1])


def observed(station):
    return np.array([complex(*g) for g in station["gain"]])


def misfit(model, station):
    seen = observed(station)
    weight = np.minimum(np.array(station["hours"], float), HOURS_CAP)
    speed = np.log(np.abs(model) / np.abs(seen))
    turn = np.angle(model / seen)

    return np.sum(weight * (speed**2 + TURN_WEIGHT * turn**2)) / np.sum(weight)


def with_free(base, x):
    values = {k: float(np.exp(v)) for k, v in zip(FREE, x)}
    # Scrub's between open ground and tall cover.
    values["scrub"] = (values["open"] + values["tall"]) / 2

    return replace(base, **values)


def bounded(x):
    return np.array([np.clip(v, math.log(lo), math.log(hi)) for v, (lo, hi) in zip(x, FREE.values())])


def main():
    manifest = json.loads((ROOT / "public/terrain/manifest.json").read_text())
    calibration = json.loads((ROOT / "public/wind/stations.json").read_text())
    root = manifest["rootSize"]
    cell = root / bw.N
    directions = calibration["directions"]
    stations = calibration["stations"]
    fitted = [s for s in stations if s["site"] not in LEFT_OUT]

    heights = bw.ground(manifest)
    tall, scrub = bw.cover(manifest)
    base = bw.Effects()

    def evaluate(raw, effects, among):
        flows = bw.finish(raw, heights, tall, scrub, cell, effects)

        return {s["site"]: gains(sample(flows, cell, root, s["world"]), directions) for s in among}

    def fit(raw, among, start):
        def cost(x):
            x = bounded(x)
            model = evaluate(raw, with_free(base, x), among)

            return np.mean([misfit(model[s["site"]], s) for s in among])

        result = minimize(cost, start, method="Nelder-Mead", options={"xatol": 1e-3, "fatol": 1e-5, "maxiter": 600})

        return bounded(result.x), result.fun

    start = np.log([base.open, base.tall, max(base.exposure, 0.05)])
    best = None

    for shelter in SHELTERS:
        print(f"shelter {shelter}: solving")
        raw = bw.solve(heights, cell, shelter=shelter)

        for radius in RADII:
            base = replace(bw.Effects(), exposure_radius=radius)
            x, score = fit(raw, fitted, start)
            print(f"  radius {radius:.0f}: misfit {score:.4f}: {with_free(base, x)}")

            if best is None or score < best[1]:
                best = (shelter, score, x, raw, base)

    shelter, score, x, raw, base = best
    tuned = with_free(base, x)
    before = evaluate(bw.solve(heights, cell), bw.Effects(), stations)
    after = evaluate(raw, tuned, stations)

    print(f"\nBest: shelter {shelter}, misfit {score:.4f}\n")
    print(f"{'station':40s} {'reads':>6} {'before':>7} {'after':>6} {'turn err':>9}  (mean gains over directions)")

    for s in stations:
        seen = observed(s)
        turn = np.degrees(np.angle(after[s["site"]] / seen))
        print(
            f"{s['site']:40s} {np.abs(seen).mean():6.2f} {np.abs(before[s['site']]).mean():7.2f} "
            f"{np.abs(after[s['site']]).mean():6.2f} {np.sqrt(np.mean(turn**2)):8.0f}°"
            f"{'  (not fitted)' if s['site'] in LEFT_OUT else ''}"
        )

    print("\nLeft out of the fit in turn: the speed it's predicted at, against what it reads")

    for held in fitted:
        others = [s for s in fitted if s is not held]
        y, _ = fit(raw, others, x)
        model = evaluate(raw, with_free(base, y), [held])[held["site"]]
        ratio = np.exp(np.mean(np.log(np.abs(model) / np.abs(observed(held)))))
        print(f"  {held['site']:40s} ×{ratio:.2f}")

    print("\nFor build_wind.py:")
    print(f"SHELTER = {shelter}")

    for name in ("open", "scrub", "tall", "exposure", "exposure_radius"):
        print(f"{name.upper()} = {getattr(tuned, name):.3g}")


if __name__ == "__main__":
    sys.exit(main())
