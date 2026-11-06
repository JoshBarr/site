"""
Builds public/wind/stations.json: how each of Greater Wellington Regional
Council's wind stations on the map reads against the wind out at sea, so the
scene can turn what they're measuring now into the wind out there (and
build_wind.py can be tuned to match them).

The wind out at sea is the reference: hourly 10 m wind from Open-Meteo's
archive (ERA5, with the most recent days from their forecast), at the same
point the scene's MetService forecast is asked for. Readings come from
GWRC's Hilltop server, per site (the collections convert some to km/h; per
site they're m/s), averaged as vectors over each hour.

For each station and each of DIRECTIONS directions the reference may blow
from, a complex gain g (x east, z south, as x + iz): what the station reads
over what the reference does, so it's how much the land there speeds the
wind up and turns it. Fitted by least squares over hours blowing from about
that direction (a Gaussian of SPREAD degrees), only when the reference blew
at least BREEZE m/s, as light airs are local. Each comes with its scatter:
the root-mean-square of what's left over, over the reference's, which
says how much to trust that station from that quarter.

Downloads are cached in .cache/wind; --fresh fetches them again.
"""

import argparse
import gzip
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "wind" / "stations.json"
CACHE = ROOT / ".cache" / "wind"
MANIFEST = ROOT / "public" / "terrain" / "manifest.json"

HILLTOP = "https://hilltop.gw.govt.nz/data.hts"
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"

# Where the scene's forecast is asked for (src/lib/weather.ts).
REFERENCE = (-41.276825, 174.7787)

# Site, its speed and direction measurements, and what its speeds are
# multiplied by for m/s. The fire weather (NRFA) stations say m/s but must
# be km/h: Belmont's would average 75 km/h. Long Gully, above Makara, isn't
# here: it stopped early in 2025, and its record before then doesn't follow
# the wind.
KMH = 1 / 3.6

STATIONS = [
    ("Karori Stream at Samuel Marsden School", "Wind Speed", "Wind Direction", 1.0),
    ("NRFA at Belmont", "Wind Speed", "Wind Direction", KMH),
    ("NRFA at Remutaka Forest Park", "Wind Speed", "Wind Direction", KMH),
    ("Birch Lane AQ", "Wind Speed (10m)", "Wind Direction (10m)", 1.0),
    ("Upper Hutt at Savage Park AQ", "Wind Speed (10m)", "Wind Direction (10m)", 1.0),
    ("Willis St AQ", "Wind Speed (6m)", "Wind Direction (6m)", 1.0),
]

# Days of each station's readings, back from its newest.
DAYS = 180
# Directions the gains are given for, from north clockwise.
DIRECTIONS = 16
SPREAD = 20.0
BREEZE = 2.0
# Fewer hours than this from a direction, and the window's widened.
ENOUGH = 30.0
# Faster than this, m/s, it's a fault: Karori's sometimes reads 200.
GALE = 60.0
# Readings older than this, the station's not live.
LIVE = timedelta(days=2)

NZST = timezone(timedelta(hours=12))


def fetch(url, path, fresh):
    if path.exists() and not fresh:
        return path.read_bytes()

    request = urllib.request.Request(url, headers={"User-Agent": "joshbarr.com scene build"})

    with urllib.request.urlopen(request, timeout=180) as response:
        raw = response.read()

    # Hilltop gzips whatever's asked for.
    body = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)

    return body


def hilltop(params, name, fresh):
    query = urllib.parse.urlencode({"Service": "Hilltop", **params}).replace("+", "%20")
    body = fetch(f"{HILLTOP}?{query}", CACHE / name, fresh).decode("utf-8", "replace")
    error = re.search(r"<Error>([^<]*)</Error>", body)

    if error:
        raise RuntimeError(f"hilltop: {error.group(1)}")

    return body


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def to_nztm(lat, lon):
    """As src/lib/nztm.ts."""
    a = 6378137
    f = 1 / 298.257222101
    n = f / (2 - f)
    e = math.sqrt(f * (2 - f))
    radius = (a / (1 + n)) * (1 + n**2 / 4 + n**4 / 64)
    alpha = [
        n / 2 - (2 / 3) * n**2 + (5 / 16) * n**3,
        (13 / 48) * n**2 - (3 / 5) * n**3,
        (61 / 240) * n**3,
    ]
    phi = math.radians(lat)
    d_lon = math.radians(lon) - math.radians(173)
    t = math.sinh(math.atanh(math.sin(phi)) - e * math.atanh(e * math.sin(phi)))
    xi0 = math.atan2(t, math.cos(d_lon))
    eta0 = math.atanh(math.sin(d_lon) / math.sqrt(1 + t * t))
    xi, eta = xi0, eta0

    for i, coefficient in enumerate(alpha):
        j = 2 * (i + 1)
        xi += coefficient * math.sin(j * xi0) * math.cosh(j * eta0)
        eta += coefficient * math.cos(j * xi0) * math.sinh(j * eta0)

    return 1600000 + 0.9996 * radius * eta, 10000000 + 0.9996 * radius * xi


def toward(speed, direction):
    """A wind from `direction` (degrees) as a complex velocity, x east + i z south."""
    angle = np.radians(np.asarray(direction) + 180)

    return np.asarray(speed) * (np.sin(angle) - 1j * np.cos(angle))


def from_direction(velocity):
    return (np.degrees(np.arctan2(velocity.real, -velocity.imag)) + 180) % 360


def site_positions(fresh):
    body = hilltop({"Request": "SiteList", "Location": "LatLong"}, "sites.xml", fresh)
    positions = {}

    for name, inside in re.findall(r'<Site Name="([^"]*)">(.*?)</Site>', body, re.S):
        lat = re.search(r"<Latitude>([^<]*)", inside)
        lon = re.search(r"<Longitude>([^<]*)", inside)

        if lat and lon:
            positions[name.replace("&amp;", "&")] = (float(lat.group(1)), float(lon.group(1)))

    return positions


def newest(site, measurement, fresh):
    """When the station's speed was last recorded."""
    body = hilltop({"Request": "MeasurementList", "Site": site}, f"{slug(site)}-list.xml", fresh)

    for name, inside in re.findall(r'<DataSource Name="([^"]*)"(.*?)</DataSource>', body, re.S):
        if name == measurement:
            return datetime.fromisoformat(re.search(r"<To>([^<]*)", inside).group(1)).replace(tzinfo=NZST)

    raise RuntimeError(f"{site}: no {measurement}")


def series(site, measurement, start, end, fresh):
    body = hilltop(
        {
            "Request": "GetData",
            "Site": site,
            "Measurement": measurement,
            "From": start.astimezone(NZST).strftime("%Y-%m-%dT%H:%M:%S"),
            "To": end.astimezone(NZST).strftime("%Y-%m-%dT%H:%M:%S"),
        },
        f"{slug(site)}-{slug(measurement)}-{start:%Y%m%d}-{end:%Y%m%d}.xml",
        fresh,
    )

    return {
        datetime.fromisoformat(t).replace(tzinfo=NZST): float(v)
        for t, v in re.findall(r"<E><T>([^<]*)</T><I1>([^<]*)</I1></E>", body)
    }


def hourly(speeds, directions, scale):
    """Vector means over each UTC hour, m/s, labelled by the hour they're centred on."""
    sums = {}

    for at, reading in speeds.items():
        direction = directions.get(at)
        speed = reading * scale

        if direction is None or not math.isfinite(speed) or not 0 <= speed <= GALE:
            continue
        # A reading closes the interval before it: a few minutes back, then
        # to the nearest hour.
        hour = (at - timedelta(minutes=5) + timedelta(minutes=30)).astimezone(timezone.utc)
        hour = hour.replace(minute=0, second=0, microsecond=0)
        total, count = sums.get(hour, (0j, 0))
        sums[hour] = (total + toward(speed, direction), count + 1)

    return {hour: total / count for hour, (total, count) in sums.items()}


def reference(start, end, fresh):
    lat, lon = REFERENCE
    query = urllib.parse.urlencode(
        {
            "latitude": lat,
            "longitude": lon,
            "start_date": f"{start:%Y-%m-%d}",
            "end_date": f"{end:%Y-%m-%d}",
            "hourly": "wind_speed_10m,wind_direction_10m",
            "wind_speed_unit": "ms",
            "timezone": "GMT",
        }
    )
    body = json.loads(fetch(f"{ARCHIVE}?{query}", CACHE / f"reference-{start:%Y%m%d}-{end:%Y%m%d}.json", fresh))
    hours = body["hourly"]
    out = {}

    for t, speed, direction in zip(hours["time"], hours["wind_speed_10m"], hours["wind_direction_10m"]):
        if speed is not None and direction is not None:
            out[datetime.fromisoformat(t).replace(tzinfo=timezone.utc)] = toward(speed, direction)

    return out, (body["latitude"], body["longitude"])


def calibrate(readings, ref):
    """Gains, scatters and hours for each direction."""
    hours = [h for h in readings if h in ref and abs(ref[h]) >= BREEZE]
    observed = np.array([readings[h] for h in hours])
    expected = np.array([ref[h] for h in hours])
    blowing = from_direction(expected)
    gains, scatters, counts = [], [], []

    for k in range(DIRECTIONS):
        centre = k * 360 / DIRECTIONS
        off = (blowing - centre + 180) % 360 - 180
        spread = SPREAD

        while True:
            weight = np.exp(-0.5 * (off / spread) ** 2)

            if weight.sum() >= ENOUGH or spread > 180:
                break
            spread *= 1.5

        gain = np.sum(weight * np.conj(expected) * observed) / np.sum(weight * np.abs(expected) ** 2)
        left = observed - gain * expected
        scatter = math.sqrt(np.sum(weight * np.abs(left) ** 2) / np.sum(weight * np.abs(expected) ** 2))
        gains.append([round(float(gain.real), 3), round(float(gain.imag), 3)])
        scatters.append(round(scatter, 3))
        counts.append(round(float(weight.sum())))

    return gains, scatters, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fresh", action="store_true", help="fetch again, not from the cache")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text())
    origin = manifest["origin"]
    positions = site_positions(args.fresh)
    now = datetime.now(timezone.utc)

    def gather(station):
        site, speed, direction, scale = station
        # Cached by the day, so the window ends at the start of today.
        end = min(
            newest(site, speed, args.fresh),
            now.replace(hour=0, minute=0, second=0, microsecond=0),
        )
        start = end - timedelta(days=DAYS)

        return hourly(
            series(site, speed, start, end, args.fresh),
            series(site, direction, start, end, args.fresh),
            scale,
        ), start, end

    with ThreadPoolExecutor(4) as pool:
        gathered = list(pool.map(gather, STATIONS))

    first = min(start for _, start, _ in gathered)
    last = max(end for _, _, end in gathered)
    ref, snapped = reference(first, last, args.fresh)

    stations = []

    for (site, speed, direction, scale), (readings, start, end) in zip(STATIONS, gathered):
        lat, lon = positions[site]
        easting, northing = to_nztm(lat, lon)
        gains, scatters, counts = calibrate(readings, ref)
        live = now - max(readings) <= LIVE
        magnitude = [math.hypot(*g) for g in gains]
        print(
            f"{site:40s} {len(readings):5d} h  gain {min(magnitude):.2f}..{max(magnitude):.2f}"
            f"  scatter {min(scatters):.2f}..{max(scatters):.2f}{'' if live else '  (not live)'}"
        )
        stations.append(
            {
                "site": site,
                "speed": speed,
                "direction": direction,
                "scale": round(scale, 6),
                "position": [round(easting), round(northing)],
                "world": [round(easting - origin[0]), round(origin[1] - northing)],
                "live": live,
                "from": f"{start:%Y-%m-%d}",
                "to": f"{end:%Y-%m-%d}",
                "gain": gains,
                "scatter": scatters,
                "hours": counts,
            }
        )

    out = {
        "reference": {
            "source": "Open-Meteo archive (ERA5), 10 m",
            "asked": list(REFERENCE),
            "cell": list(snapped),
        },
        "directions": DIRECTIONS,
        "stations": stations,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1) + "\n")
    print(f"{args.out.relative_to(ROOT)}: {len(stations)} stations")


if __name__ == "__main__":
    sys.exit(main())
