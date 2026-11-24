// Builds src/components/scene/events/venues.ts: where the venues the scene
// lights for what's on (src/lib/events.ts) stand: their footprints, the
// stadium's and the Basin's pitches, their ground height and roughly how
// tall they are, in NZTM.
//
//   node scripts/events/build_venues.mjs [--osm cached.json]
//
// Footprints from OpenStreetMap (© OpenStreetMap contributors, ODbL); ground
// heights from the terrain's DEM (LINZ, CC BY 4.0).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGroundSampler, toNztm } from "../lib/geo.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const TERRAIN = path.join(ROOT, "public/terrain");
const OUT = path.join(ROOT, "src/components/scene/events/venues.ts");

/**
 * Each venue's OSM way and the name it should carry there, or, for those
 * OSM has only as a point inside a bigger building, where they are; the
 * stadium's and the Basin's pitches; and how tall, m, where OSM doesn't say.
 */
// prettier-ignore
const VENUES = [
  { key: "stadium", way: 1021590430, name: "Hnry Stadium", pitch: 1157350361, height: 35 },
  { key: "basin", way: 288996918, name: "Basin Reserve", pitch: 96906280, height: 12 },
  { key: "michaelFowler", way: 190555300, name: "Michael Fowler Centre" },
  { key: "operaHouse", way: 260864067, name: "The Opera House" },
  { key: "stJames", way: 288450695, name: "St James Theatre" },
  { key: "tsbArena", way: 38138828, name: "TSB Arena" },
  { key: "shed6", way: 38138812, name: "Shed 6" },
  { key: "takina", way: 1028184544, name: "Tākina - Wellington Convention and Exhibition Centre" },
  { key: "townHall", way: 190555301, name: "Wellington Town Hall" },
  { key: "tePapa", way: 190557095, name: "Museum of New Zealand Te Papa Tongarewa" },
  { key: "hannah", way: 257036856, name: "Hannah Playhouse" },
  { key: "circa", way: 62153752, name: "Circa Theatre" },
  { key: "bats", way: 643601943, name: "BATS Theatre" },
  { key: "embassy", way: 251575875, name: "Embassy Theatre" },
  { key: "stAndrews", way: 402874338, name: "St Andrew's on the Terrace" },
  { key: "cathedral", way: 47113870, name: "Wellington Cathedral of Saint Paul" },
  { key: "meow", way: 256401051, name: "Meow Nui" },
  // Upstairs on Cuba Street; and a timber church OSM has no outline of.
  { key: "sanFran", at: [-41.294, 174.7753], height: 12 },
  { key: "oldStPauls", at: [-41.2763, 174.7801], height: 15 },
];

/** How tall a building is when OSM says nothing, m. */
const DEFAULT_HEIGHT = 18;

/** And a storey, when it gives levels. */
const STOREY = 3.5;

const ways = VENUES.flatMap(({ way, pitch }) => [way, pitch]).filter(Boolean);

const QUERY = `[out:json][timeout:60];
way(id:${ways.join(",")});
out geom tags;`;

async function loadOsm() {
  const cached = process.argv.indexOf("--osm");

  if (cached > 0)
    return JSON.parse(await readFile(process.argv[cached + 1], "utf8"));

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "User-Agent": "joshbarr.com scene builder",
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ data: QUERY }),
  });

  if (!response.ok) throw new Error(`overpass: ${response.status}`);

  return response.json();
}

const osm = await loadOsm();
const byId = new Map(osm.elements.map((e) => [e.id, e]));
const { groundHeight } = await createGroundSampler(TERRAIN);

/** A closed way's ring in NZTM, without the repeated last node. */
const ringOf = ({ geometry }) =>
  geometry.slice(0, -1).map(({ lat, lon }) => toNztm(lat, lon));

/** A ring's centroid, worked from its first corner (see build_tiles.mjs). */
function centroid(ring) {
  const [e0, n0] = ring[0];
  let area = 0;
  let e = 0;
  let n = 0;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = [ring[i][0] - e0, ring[i][1] - n0];
    const [xj, yj] = [ring[j][0] - e0, ring[j][1] - n0];
    const cross = xj * yi - xi * yj;

    area += cross;
    e += (xj + xi) * cross;
    n += (yj + yi) * cross;
  }

  return [e0 + e / (3 * area), n0 + n / (3 * area)];
}

/** How tall OSM says it is, m, if it does. */
function taggedHeight(tags = {}) {
  const height = Number.parseFloat(tags.height);

  if (Number.isFinite(height)) return height;

  const levels = Number.parseFloat(tags["building:levels"]);

  return Number.isFinite(levels) ? levels * STOREY : undefined;
}

const sites = [];

for (const venue of VENUES) {
  let ring;
  let centre;
  let height = venue.height;

  if (venue.way) {
    const element = byId.get(venue.way);

    if (!element) throw new Error(`${venue.key}: way ${venue.way} is missing`);

    if (element.tags?.name !== venue.name) {
      throw new Error(
        `${venue.key}: way ${venue.way} is now "${element.tags?.name}"`
      );
    }

    ring = ringOf(element);
    centre = centroid(ring);
    height ??= taggedHeight(element.tags);
  } else {
    centre = toNztm(...venue.at);
  }

  const pitch = venue.pitch && byId.get(venue.pitch);

  if (venue.pitch && !pitch) {
    throw new Error(`${venue.key}: pitch ${venue.pitch} is missing`);
  }

  const ground = await groundHeight(...centre);

  if (ground === undefined) throw new Error(`${venue.key}: no terrain`);

  sites.push({
    key: venue.key,
    centre,
    ground,
    height: height ?? DEFAULT_HEIGHT,
    ring,
    pitch: pitch && ringOf(pitch),
  });
}

const point = ([e, n]) => `[${e.toFixed(1)}, ${n.toFixed(1)}]`;
const ring = (points) => `[${points.map(point).join(", ")}]`;

await writeFile(
  OUT,
  `// Generated by scripts/events/build_venues.mjs. Do not edit.
//
// Footprints © OpenStreetMap contributors (ODbL), as [easting, northing] in
// NZTM2000 metres; ground from the DEM (LINZ, CC BY 4.0), before the
// terrain's vertical scale. Heights are OSM's, or guessed.

import type { VenueKey } from "../../../lib/events";

export interface VenueSite {
  /** Where its icon goes over. */
  centre: [number, number];
  /** Ground at the centre, m. */
  ground: number;
  /** Roughly how tall, m. */
  height: number;
  /** Its footprint, which glows; none for those OSM has only as a point. */
  ring?: [number, number][];
  /** The pitch, lit by floodlights. */
  pitch?: [number, number][];
}

// prettier-ignore
export const VENUE_SITES: Record<VenueKey, VenueSite> = {
${sites
  .map(
    ({ key, centre, ground, height, ring: footprint, pitch }) =>
      `  ${key}: {\n    centre: ${point(centre)},\n    ground: ${ground.toFixed(1)},\n    height: ${height.toFixed(1)},${
        footprint ? `\n    ring: ${ring(footprint)},` : ""
      }${pitch ? `\n    pitch: ${ring(pitch)},` : ""}\n  },`
  )
  .join("\n")}
};
`
);

console.log(`${sites.length} venues → ${path.relative(ROOT, OUT)}`);
