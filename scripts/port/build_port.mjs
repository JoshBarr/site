// Builds src/components/scene/port/terminal.ts: CentrePort's container cranes
// and the container stacks in its Thorndon yard, in NZTM, with the ground
// under each.
//
//   node scripts/port/build_port.mjs [--osm cached.json]
//
// Crane positions come from OpenStreetMap (© OpenStreetMap contributors,
// ODbL). The stacks were laid out by eye from aerial photos: where the blocks
// are is roughly right, the boxes in them are made up. Ground heights are
// read from the terrain tiles in public/terrain, so run this after
// build_tiles.py.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGroundSampler, toNztm } from "../lib/geo.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const TERRAIN = path.join(ROOT, "public/terrain");
const OUT = path.join(ROOT, "src/components/scene/port/terminal.ts");

const QUERY = `[out:json][timeout:60];
node["man_made"="crane"]["seamark:crane:category"="container"](-41.29,174.78,-41.27,174.80);
out body;`;

/**
 * Compass bearing the face of Thorndon Container Wharf runs along, degrees:
 * from the waterline in the DEM and aerials. The yard is laid out square to it.
 */
const WHARF_BEARING = 170;

/**
 * Container blocks: centre (NZTM), extent along the wharf and across it (m),
 * which way the boxes lie, and how high they're stacked at most.
 */
// prettier-ignore
const YARD = [
  // West of the rail siding, from the gate southward.
  { centre: [1749493, 5428765], along: 40, across: 40, lie: "along", tiers: 3 },
  { centre: [1749571, 5428710], along: 58, across: 58, lie: "along", tiers: 3 },
  { centre: [1749636, 5428725], along: 69, across: 27, lie: "across", tiers: 3 },
  { centre: [1749590, 5428608], along: 88, across: 43, lie: "across", tiers: 4 },
  { centre: [1749646, 5428600], along: 110, across: 57, lie: "across", tiers: 4 },
  { centre: [1749664, 5428524], along: 40, across: 43, lie: "across", tiers: 3 },
  { centre: [1749482, 5428635], along: 31, across: 101, lie: "along", tiers: 3 },
  { centre: [1749499, 5428591], along: 47, across: 118, lie: "along", tiers: 4 },
  { centre: [1749459, 5428510], along: 103, across: 40, lie: "across", tiers: 3 },
  { centre: [1749515, 5428511], along: 99, across: 36, lie: "across", tiers: 3 },
  { centre: [1749563, 5428513], along: 94, across: 30, lie: "across", tiers: 3 },
  { centre: [1749610, 5428509], along: 36, across: 25, lie: "across", tiers: 2 },
  // East of it, toward the wharf.
  { centre: [1749760, 5428777], along: 31, across: 117, lie: "along", tiers: 2 },
  { centre: [1749762, 5428735], along: 27, across: 117, lie: "across", tiers: 2 },
  { centre: [1749764, 5428703], along: 27, across: 112, lie: "across", tiers: 2 },
  { centre: [1749755, 5428668], along: 27, across: 74, lie: "across", tiers: 2 },
  { centre: [1749809, 5428597], along: 94, across: 81, lie: "across", tiers: 4 },
  { centre: [1749739, 5428610], along: 45, across: 13, lie: "across", tiers: 2 },
  { centre: [1749850, 5428731], along: 100, across: 28, lie: "across", tiers: 4 },
  { centre: [1749873, 5428641], along: 40, across: 27, lie: "across", tiers: 3 },
  { centre: [1749876, 5428538], along: 31, across: 25, lie: "along", tiers: 3 },
  // The line behind the cranes, beside the log yard.
  { centre: [1749769, 5428999], along: 269, across: 13, lie: "across", tiers: 2 },
];

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

const { groundHeight: sampleGround } = await createGroundSampler(TERRAIN);

async function groundHeight(easting, northing) {
  const height = await sampleGround(easting, northing);
  if (height === undefined) {
    throw new Error(`no terrain under ${easting}, ${northing}`);
  }
  return height;
}

const radians = (degrees) => (degrees * Math.PI) / 180;
// Unit vectors (east, north) along the wharf and seaward across it.
const along = [
  Math.sin(radians(WHARF_BEARING)),
  Math.cos(radians(WHARF_BEARING)),
];
const seaward = [
  Math.sin(radians(WHARF_BEARING - 90)),
  Math.cos(radians(WHARF_BEARING - 90)),
];

// --- Cranes: on one rail, so set them on a common line along the wharf. ---

const osm = await loadOsm();
const nodes = osm.elements
  .filter(
    (e) =>
      e.type === "node" &&
      e.tags?.man_made === "crane" &&
      e.tags["seamark:crane:category"] === "container"
  )
  .map((node) => toNztm(node.lat, node.lon));
if (nodes.length !== 2) {
  console.warn(`cranes: expected 2, found ${nodes.length}`);
}
const mean = [0, 1].map(
  (i) => nodes.reduce((sum, p) => sum + p[i], 0) / nodes.length
);
const cranes = [];
for (const [e, n] of nodes) {
  const t = (e - mean[0]) * along[0] + (n - mean[1]) * along[1];
  const ce = mean[0] + along[0] * t;
  const cn = mean[1] + along[1] * t;
  cranes.push({ t, e: ce, n: cn, ground: await groundHeight(ce, cn) });
}
// North to south along the wharf.
cranes.sort((a, b) => a.t - b.t);

// --- Blocks: stood on the lowest ground under them, so none float. ---

const blocks = [];
for (const block of YARD) {
  const [e, n] = block.centre;
  let ground = Infinity;
  for (const [a, s] of [
    [0, 0],
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ]) {
    const da = (a * block.along) / 2;
    const ds = (s * block.across) / 2;
    ground = Math.min(
      ground,
      await groundHeight(
        e + along[0] * da + seaward[0] * ds,
        n + along[1] * da + seaward[1] * ds
      )
    );
  }
  blocks.push({ ...block, ground });
}

const site = (e, n, ground) =>
  `[${e.toFixed(1)}, ${n.toFixed(1)}, ${ground.toFixed(1)}]`;

await writeFile(
  OUT,
  `// Generated by scripts/port/build_port.mjs. Do not edit.
//
// Crane positions © OpenStreetMap contributors (ODbL). Container blocks laid
// out by eye from aerial photos. Sites are [easting, northing, ground] in
// NZTM2000 metres; ground is the bare-earth DEM height, before the terrain's
// vertical scale.

import type { Site } from "../landmarks/sites";

/** Compass bearing the face of Thorndon Container Wharf runs along. */
export const WHARF_BEARING = ${WHARF_BEARING};

/** CentrePort's ship-to-shore container cranes, north to south. */
export const CRANES: Site[] = [
${cranes.map(({ e, n, ground }) => `  ${site(e, n, ground)},`).join("\n")}
];

export interface YardBlock {
  site: Site;
  /** Extent along the wharf and across it, m. */
  along: number;
  across: number;
  /** Which of those the boxes' length lies along. */
  lie: "along" | "across";
  /** Most boxes in a stack. */
  tiers: number;
}

/** Container stacks in the Thorndon yard. */
export const YARD: YardBlock[] = [
${blocks
  .map(
    ({ centre: [e, n], ground, along, across, lie, tiers }) =>
      `  { site: ${site(e, n, ground)}, along: ${along}, across: ${across}, lie: "${lie}", tiers: ${tiers} },`
  )
  .join("\n")}
];
`
);

console.log(`cranes: ${cranes.length}, blocks: ${blocks.length}`);
