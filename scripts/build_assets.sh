#!/usr/bin/env bash
# Rebuilds every generated asset for the homepage scene, in dependency order.
#
#   scripts/build_assets.sh              everything
#   scripts/build_assets.sh buses trains just those steps (still in order)
#   npm run build:assets -- buses        the same, through npm
#
# Steps:
#   terrain    public/terrain: height tiles, water, shore (LINZ DEM + OSM)
#   traffic    public/roads/roads.json (OSM + NZTA), its bridge decks then
#              lifted to the lidar's heights. The trees step clears the
#              canopy the lidar made of the decks, and the buildings step
#              leaves out the council's models of them: when a bridge
#              changes, run trees, landcover and buildings again
#   trees      public/trees: lidar-found trees, and scrub.png, the scrub
#              cover the scene scatters shrubs by (needs terrain's caches;
#              clears the highways' lanes and the railway's bridges, so
#              reads roads.json and the trains step's network.json)
#   landcover  public/terrain/landcover.png, with the trees' canopy folded in
#   farland    public/farland/land.bin: the South Island on the horizon, a
#              coarse mesh of NIWA's grid, and coast.png: how far to the
#              land past the root that nothing draws, which the far sea
#              fades out short of
#   wind-stations public/wind/stations.json: GWRC's wind stations against
#              the wind at sea (Hilltop, Open-Meteo); tune_wind.py fits the
#              field to it
#   wind       public/wind/field.png: how the land turns and slows the wind
#   footprints .cache/buildings/footprints.json: OSM footprints with lidar
#              heights, for past the city (needs the trees' caches)
#   cablecar   public/rail/cablecar.json: the cable car's track (OSM)
#   buildings  public/buildings (WCC I3S, and the footprints past it; less
#              what's on the cable car's track, the highways' own
#              structures and the sign gantries; decks, not walls, over the
#              highways' lanes and the railway, so it reads the trains
#              step's network.json: when that changes, run this again)
#   heroes     src/components/scene/buildings/heroes.ts: floodlit landmarks (OSM)
#   venues     src/components/scene/events/venues.ts: venues lit for what's on
#              in them (OSM, and the DEM)
#   airport    public/airport + src/components/scene/airport/airfield.ts
#   landmarks  src/components/scene/landmarks/sites.ts
#   port       src/components/scene/port/terminal.ts
#   playground src/components/scene/playground/site.ts: Frank Kitts Park's
#              playground's anchor (OSM) and the DEM's ground under it
#   power      src/components/scene/power/grid.ts: Transpower's towers and
#              lines, their heights from the lidar, and the Cook Strait
#              cables. The trees step reads it, to clear what the lidar
#              made of them: when it changes, run trees and landcover again
#   signs      public/roads/signs.json: the signs along the highways there's
#              evidence for (OSM, NZTA), on roads.json's carriageways; what
#              for, in scripts/traffic/signs.evidence.json
#   tunnels    public/tunnels/tunnels.json: the road tunnels (the highways'
#              from roads.json, the rest OSM)
#   buses      public/buses/routes.json (Metlink GTFS), through the tunnels
#   trains     public/rail/network.json, public/rail/crossings.json: the
#              level crossings on it (OSM), and public/rail/stations.json:
#              where trains call (Metlink GTFS)
#   stars      src/components/scene/sky/stars.ts (d3-celestial)
#
# Everything after landcover reads ground heights from public/terrain.
# Downloads are cached in .cache/, so a rerun is mostly local. The terrain
# and farland steps need BATHYMETRY: the path to NIWA's NZ bathymetry grid
# (nzbathy_2016.tif).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALL=(terrain traffic trees landcover farland wind-stations wind footprints cablecar buildings heroes venues airport landmarks port playground power signs tunnels buses trains stars)
VENV=.venv-terrain
PY="$VENV/bin/python"

for step in "$@"; do
  if [[ ! " ${ALL[*]} " =~ " $step " ]]; then
    echo "unknown step: $step (one of: ${ALL[*]})" >&2
    exit 1
  fi
done
STEPS=("${@:-${ALL[@]}}")

wants() {
  [[ " ${STEPS[*]} " =~ " $1 " ]]
}

python_env() {
  if [[ ! -x "$PY" ]]; then
    echo "creating $VENV"
    python3 -m venv "$VENV"
    "$PY" -m pip install -q -r scripts/terrain/requirements.txt
  fi
}

run() {
  local step=$1
  shift
  echo
  echo "=== $step"
  local start=$SECONDS
  "$@"
  echo "=== $step done in $((SECONDS - start))s"
}

if wants terrain || wants traffic || wants trees || wants landcover || wants farland || wants wind-stations || wants wind || wants footprints || wants power; then
  python_env
fi

wants terrain && run terrain "$PY" -I scripts/terrain/build_tiles.py
wants traffic && run traffic node scripts/traffic/build_roads.mjs
wants traffic && run decks "$PY" -I scripts/traffic/build_decks.py
wants trees && run trees "$PY" -I scripts/trees/build_trees.py
wants trees && run scrub "$PY" -I scripts/trees/build_trees.py scrub
wants landcover && run landcover "$PY" -I scripts/terrain/build_tiles.py landcover
wants farland && run farland "$PY" -I scripts/farland/build_farland.py
wants wind-stations && run wind-stations "$PY" -I scripts/wind/build_stations.py
wants wind && run wind "$PY" -I scripts/wind/build_wind.py
wants footprints && run footprints "$PY" -I scripts/buildings/build_footprints.py
wants cablecar && run cablecar node scripts/trains/build_cablecar.mjs
wants buildings && run buildings node scripts/buildings/build_tiles.mjs
wants heroes && run heroes node scripts/buildings/build_heroes.mjs
wants venues && run venues node scripts/events/build_venues.mjs
wants airport && run airport node scripts/airport/build_airfield.mjs
wants landmarks && run landmarks node scripts/landmarks/build_sites.mjs
wants port && run port node scripts/port/build_port.mjs
wants playground && run playground node scripts/playground/build_playground.mjs
wants power && run power "$PY" -I scripts/power/build_power.py
wants signs && run signs node scripts/traffic/build_signs.mjs
wants tunnels && run tunnels node scripts/tunnels/build_tunnels.mjs
wants buses && run buses node scripts/buses/build_routes.mjs
wants trains && run trains node scripts/trains/build_rail.mjs
wants trains && run crossings node scripts/trains/build_crossings.mjs
wants trains && run stations node scripts/trains/build_stations.mjs
wants stars && run stars node scripts/sky/build_stars.mjs

echo
echo "built: ${STEPS[*]}"
