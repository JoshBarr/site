// Builds src/components/scene/vessels/berths.ts: the marina berths and
// moorings around the harbour and at Mana, each a slot a moored yacht can lie
// in, where the scene puts generic yachts in some of them
// (vessels/Moored.tsx, at the occupancy in vessels/moorings.ts); and
// vessels/marinaOutlines.ts, the marinas' pontoons and breakwaters
// (vessels/Marinas.tsx), from OpenStreetMap (© OpenStreetMap contributors,
// ODbL) by way of ./marinas.mjs.
//
//   node scripts/vessels/build_berths.mjs [--survey cached.json] [--osm cached.json]
//
// The slots are from a marine biosecurity survey of hulls, Ethos GIS's public
// layer of every marina berth, pole mooring and swing mooring it inspects,
// each an outline: a berth's is its pen, so where it is, which way it lies
// and how long and wide; a swing mooring's a 20 m circle round its buoy. The
// layer is in live use in the field, and its owner asks it be read gently:
// it's fetched once, into .cache/moorings/survey.json, and read from there
// after. Whether a boat was there at each berth's last check is left out:
// the scene fills berths at each place's average instead.
//
// OpenStreetMap's fetched once too, into .cache/moorings/osm.json. The
// terrain tiles in public/terrain say which of its piers and breakwaters the
// terrain already has, so run this after build_tiles.py.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGroundSampler, toNztm } from "../lib/geo.mjs";
import { buildMarinas, osmQuery } from "./marinas.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const CACHE = path.join(ROOT, ".cache/moorings/survey.json");
const OSM_CACHE = path.join(ROOT, ".cache/moorings/osm.json");
const OUT = path.join(ROOT, "src/components/scene/vessels/berths.ts");

const MARINAS_OUT = path.join(
  ROOT,
  "src/components/scene/vessels/marinaOutlines.ts"
);

const TERRAIN = path.join(ROOT, "public/terrain");

const SURVEY =
  "https://services2.arcgis.com/geHbTEWts6uYVifz/arcgis/rest/services/Berths_Mooring_and_Anchor_TOS_and_Wellington_PUBLIC_VIEW/FeatureServer/0/query";

/** Around the scene: min lon, min lat, max lon, max lat. */
const BOUNDS = "174.6,-41.45,175.0,-41.0";

/**
 * Where berths are grouped: each survey outline goes to the nearest of
 * these, by its centre (lat, lon: OSM's marina outlines' middles, and for the
 * pile moorings at Paremata, the survey's own), and its kind.
 */
const SITES_AT = [
  { name: "Chaffers Marina", at: [-41.28938, 174.78439] },
  { name: "Clyde Quay", at: [-41.29072, 174.78768] },
  { name: "Evans Bay", at: [-41.31182, 174.79866] },
  { name: "Seaview Marina", at: [-41.24905, 174.90315] },
  { name: "Mana", at: [-41.10052, 174.86738] },
  { name: "Paremata", at: [-41.10686, 174.85883] },
];

const SITES = SITES_AT.map(({ name, at }) => ({ name, at: toNztm(...at) }));

/**
 * Where OpenStreetMap has the walkways but not the fingers off them: each
 * pen here gets one down its side (marinas.mjs).
 */
const FINGERS_FROM_PENS = new Set(["Evans Bay"]);

/** The survey's kinds: a marina pen, between piles, or on a buoy. */
const KINDS = {
  MarinaBerth: "berth",
  PoleMooring: "pole",
  SwingMooring: "swing",
  // At Evans Bay: two more 20 m circles.
  Other: "swing",
};

const KIND_INDEX = { berth: 0, pole: 1, swing: 2 };

async function loadOsm() {
  const cached = process.argv.indexOf("--osm");
  const file = cached > 0 ? process.argv[cached + 1] : OSM_CACHE;

  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (cached > 0 || e.code !== "ENOENT") throw e;
  }

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "User-Agent": "joshbarr.com scene builder",
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      data: osmQuery(SITES_AT.map(({ at }) => at)),
    }),
  });

  if (!response.ok) throw new Error(`overpass: ${response.status}`);
  const osm = await response.json();
  await mkdir(path.dirname(OSM_CACHE), { recursive: true });
  await writeFile(OSM_CACHE, JSON.stringify(osm));

  return osm;
}

async function loadSurvey() {
  const cached = process.argv.indexOf("--survey");
  const file = cached > 0 ? process.argv[cached + 1] : CACHE;

  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (cached > 0 || e.code !== "ENOENT") throw e;
  }

  const query = new URLSearchParams({
    where: "1=1",
    geometry: BOUNDS,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields:
      "PlaceType,PlaceID,BoatPresentBooleanMostRecentChe,DateOfMostRecentCheck,Status",
    returnGeometry: "true",
    f: "json",
  });

  const response = await fetch(`${SURVEY}?${query}`, {
    headers: { "User-Agent": "joshbarr.com scene builder" },
  });

  if (!response.ok) throw new Error(`survey: ${response.status}`);
  const survey = await response.json();

  if (survey.error) throw new Error(`survey: ${JSON.stringify(survey.error)}`);

  if (survey.exceededTransferLimit) {
    throw new Error("survey: more berths than one page; page through them");
  }

  await mkdir(path.dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(survey));

  return survey;
}

/**
 * The smallest rectangle round an outline (NZTM points): its centre, the
 * compass bearing of its long side (0..180), and its length and width.
 */
function rectangle(points) {
  let best = null;

  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const angle = Math.atan2(by - ay, bx - ax);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const u = points.map(([x, y]) => x * c + y * s);
    const v = points.map(([x, y]) => -x * s + y * c);
    const [u0, u1] = [Math.min(...u), Math.max(...u)];
    const [v0, v1] = [Math.min(...v), Math.max(...v)];
    const area = (u1 - u0) * (v1 - v0);

    if (best && area >= best.area) continue;
    const um = (u0 + u1) / 2;
    const vm = (v0 + v1) / 2;
    const long = u1 - u0 >= v1 - v0;
    // Along the long side, as a compass bearing.
    const along = long ? angle : angle + Math.PI / 2;
    const bearing = (((90 - (along * 180) / Math.PI) % 180) + 360) % 180;

    best = {
      area,
      centre: [um * c - vm * s, um * s + vm * c],
      bearing,
      length: Math.max(u1 - u0, v1 - v0),
      width: Math.min(u1 - u0, v1 - v0),
    };
  }

  return best;
}

const survey = await loadSurvey();
const places = new Map();
const berths = [];
/** Pens to put fingers down: [centre, bearing, length, width]. */

const pens = [];

for (const { attributes: a, geometry } of survey.features) {
  const kind = KINDS[a.PlaceType];

  if (!kind || a.Status !== "Active" || !geometry?.rings?.[0]) continue;
  const points = geometry.rings[0].map(([lon, lat]) => toNztm(lat, lon));
  const { centre, bearing, length, width } = rectangle(points);

  const site = SITES.reduce((a, b) =>
    Math.hypot(a.at[0] - centre[0], a.at[1] - centre[1]) <
    Math.hypot(b.at[0] - centre[0], b.at[1] - centre[1])
      ? a
      : b
  );

  if (Math.hypot(site.at[0] - centre[0], site.at[1] - centre[1]) > 1500) {
    console.warn(`berth ${a.PlaceID}: no site near ${centre.map(Math.round)}`);
    continue;
  }

  const place = `${site.name} ${kind}`;

  if (kind === "berth" && FINGERS_FROM_PENS.has(site.name)) {
    pens.push([centre, bearing, length, width]);
  }

  if (!places.has(place)) {
    places.set(place, { index: places.size, berths: 0, boats: 0, checks: [] });
  }

  const counts = places.get(place);
  counts.berths++;

  if (a.BoatPresentBooleanMostRecentChe === "Yes") counts.boats++;

  if (a.DateOfMostRecentCheck) counts.checks.push(a.DateOfMostRecentCheck);

  berths.push([
    Math.round(centre[0] * 10) / 10,
    Math.round(centre[1] * 10) / 10,
    Math.round(bearing),
    Math.round(length * 10) / 10,
    Math.round(width * 10) / 10,
    KIND_INDEX[kind],
    counts.index,
  ]);
}

// West to east, so the file diffs by place.
berths.sort((a, b) => a[6] - b[6] || a[0] - b[0] || a[1] - b[1]);

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

console.log("place: boats / berths at their last checks");

for (const [place, { berths: n, boats, checks }] of places) {
  const span = checks.length
    ? `${day(Math.min(...checks))} to ${day(Math.max(...checks))}`
    : "never checked";

  console.log(
    `  ${place}: ${boats} / ${n} (${Math.round((100 * boats) / n)}%), ${span}`
  );
}

await writeFile(
  OUT,
  `// Generated by scripts/vessels/build_berths.mjs. Do not edit.
//
// Marina berths and moorings from Ethos GIS's marine biosecurity survey of
// hulls. Each is [easting, northing, bearing, length, width, kind, place]:
// its centre in NZTM2000 metres, the compass bearing its long side lies on
// (0..180), its outline's length and width in metres (a swing mooring's is
// the 20 m circle round its buoy), its kind (KINDS) and its place (PLACES).

/** A marina pen, between piles, or on a buoy. */
export const KINDS = ["berth", "pole", "swing"] as const;

export const PLACES = [
${[...places.keys()].map((place) => `  ${JSON.stringify(place)},`).join("\n")}
] as const;

export type Place = (typeof PLACES)[number];

export type Berth = [
  easting: number,
  northing: number,
  bearing: number,
  length: number,
  width: number,
  kind: number,
  place: number,
];

// prettier-ignore
export const BERTHS: Berth[] = [
${berths.map((berth) => `  [${berth.join(", ")}],`).join("\n")}
];
`
);

console.log(`${berths.length} berths in ${places.size} places → ${OUT}`);

const { groundHeight } = await createGroundSampler(TERRAIN);

const { pontoons, breakwaters, fingers, skipped } = await buildMarinas(
  await loadOsm(),
  groundHeight,
  pens
);

if (skipped.length) {
  console.log(
    `not drawn, as the terrain has them or they're fixed: ${skipped.join(", ")}`
  );
}

const rings = (shape) =>
  `[${shape.map((ring) => `\n    [${ring.join(", ")}],`).join("")}\n  ]`;

await writeFile(
  MARINAS_OUT,
  `// Generated by scripts/vessels/build_berths.mjs. Do not edit.
//
// The marinas' pontoons and breakwaters from OpenStreetMap (© OpenStreetMap
// contributors, ODbL), less those the terrain has, and fingers put in down
// the side of each pen where it hasn't any (scripts/vessels/marinas.mjs).
// Each is its outline's rings, the outside first, wound anticlockwise
// looking down, then its holes, clockwise: each ring a flat list of NZTM2000
// easting, northing pairs in metres.

export type Outline = number[][];

/** Pontoons, walkways and fingers: they float. */
// prettier-ignore
export const PONTOONS: Outline[] = [
${pontoons.map((shape) => `  ${rings(shape)},`).join("\n")}
];

/** Breakwaters: \`rock\`, a mound of it; or else a concrete wall. */
// prettier-ignore
export const BREAKWATERS: { rock: boolean; outline: Outline }[] = [
${breakwaters.map(({ rock, rings: shape }) => `  { rock: ${rock}, outline: ${rings(shape)} },`).join("\n")}
];
`
);

console.log(
  `${pontoons.length} pontoons (${fingers} fingers from pens), ${breakwaters.length} breakwaters → ${MARINAS_OUT}`
);
