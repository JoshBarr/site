#!/usr/bin/env bash
# Rebuilds every generated asset for the homepage scene, in dependency order.
#
#   scripts/build_assets.sh              everything
#   scripts/build_assets.sh buses trains just those steps (still in order)
#   npm run build:assets -- buses        the same, through npm
#
# Steps:
#   terrain    public/terrain: height tiles, water, shore (LINZ DEM + OSM)
#   trees      public/trees: lidar-found trees (needs terrain's caches)
#   landcover  public/terrain/landcover.png, with the trees' canopy folded in
#   footprints .cache/buildings/footprints.json: OSM footprints with lidar
#              heights, for past the city (needs the trees' caches)
#   buildings  public/buildings (WCC I3S, and the footprints past it)
#   heroes     src/components/scene/buildings/heroes.ts: floodlit landmarks (OSM)
#   airport    public/airport + src/components/scene/airport/airfield.ts
#   buses      public/buses/routes.json (Metlink GTFS)
#   landmarks  src/components/scene/landmarks/sites.ts
#   port       src/components/scene/port/terminal.ts
#   traffic    public/roads/roads.json (OSM + NZTA)
#   trains     public/rail/network.json
#   cablecar   public/rail/cablecar.json: the cable car's track (OSM)
#
# Everything after landcover reads ground heights from public/terrain.
# Downloads are cached in .cache/, so a rerun is mostly local. The terrain
# step needs BATHYMETRY: the path to NIWA's NZ bathymetry grid
# (nzbathy_2016.tif).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALL=(terrain trees landcover footprints buildings heroes airport buses landmarks port traffic trains cablecar)
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

if wants terrain || wants trees || wants landcover || wants footprints; then
  python_env
fi

wants terrain && run terrain "$PY" -I scripts/terrain/build_tiles.py
wants trees && run trees "$PY" -I scripts/trees/build_trees.py
wants landcover && run landcover "$PY" -I scripts/terrain/build_tiles.py landcover
wants footprints && run footprints "$PY" -I scripts/buildings/build_footprints.py
wants buildings && run buildings node scripts/buildings/build_tiles.mjs
wants heroes && run heroes node scripts/buildings/build_heroes.mjs
wants airport && run airport node scripts/airport/build_airfield.mjs
wants buses && run buses node scripts/buses/build_routes.mjs
wants landmarks && run landmarks node scripts/landmarks/build_sites.mjs
wants port && run port node scripts/port/build_port.mjs
wants traffic && run traffic node scripts/traffic/build_roads.mjs
wants trains && run trains node scripts/trains/build_rail.mjs
wants cablecar && run cablecar node scripts/trains/build_cablecar.mjs

echo
echo "built: ${STEPS[*]}"
