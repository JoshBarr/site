// Builds public/rail/network.json: the railway around Wellington as a graph
// for the scene's trains to run along, with which tracks to model and the
// platforms at Wellington station.
//
//   node scripts/trains/build_rail.mjs [--osm cached.json]
//
// Track geometry comes from OpenStreetMap (© OpenStreetMap contributors,
// ODbL). Every running line on the map is in the graph, so trains can be
// followed wherever they are, and the scene lays track along all of it out
// of the tunnels; the tracks joined to Wellington station short of the
// first tunnels are modelled in detail. Heights are read from the terrain
// tiles in public/terrain (so run this after build_tiles.py), smoothed as a
// railway's grades are, and carried straight from portal to portal through
// tunnels and from abutment to abutment over bridges.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGroundSampler, toNztm } from "../lib/geo.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const TERRAIN = path.join(ROOT, "public/terrain");
const OUT_DIR = path.join(ROOT, "public/rail");

/** Generous around the terrain root; clipped to it below. */
const BBOX = "-41.62,174.52,-40.88,175.45";

/** Around Wellington station, for its platforms. */
const STATION_BBOX = "-41.282,174.776,-41.272,174.785";

const QUERY = `[out:json][timeout:180];
(
  way["railway"="rail"](${BBOX});
  way["railway"="platform"](${STATION_BBOX});
)->.ways;
.ways out body;
node(w.ways);
out skel qt;`;

/**
 * Tracks are modelled in detail from the station out to here at most, NZTM
 * northing: just short of the Ngauranga tunnels, the first on the main
 * lines. The Johnsonville Line's first, at Kaiwharawhara, stops it sooner.
 */
const MODEL_NORTH = 5432400;

/**
 * Track points are at most this far apart, m: in the model, along the
 * plainer track beyond, and through tunnels, where nothing's laid.
 */
const MODEL_STEP = 6;
const LINE_STEP = 10;
const TUNNEL_STEP = 30;

/**
 * Ground is sampled this far either side of a track as well as under it,
 * m, and the middle value kept: a line along a sea wall or a cutting's edge
 * shouldn't take on the drop beside it.
 */
const SAMPLE_SPREAD = 2.5;

/** Rounds of smoothing between neighbouring track points. */
const SMOOTHING = 40;

/** Bits of a way's flags. */
const TUNNEL = 1;
const BRIDGE = 2;
const MODEL = 4;

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

const { manifest, groundHeight } = await createGroundSampler(TERRAIN);
const half = manifest.rootSize / 2;

const onMap = ([e, n]) =>
  Math.abs(e - manifest.origin[0]) < half &&
  Math.abs(n - manifest.origin[1]) < half;

const osm = await loadOsm();
const points = new Map();

for (const e of osm.elements) {
  if (e.type === "node") points.set(e.id, toNztm(e.lat, e.lon));
}

const ways = osm.elements.filter((e) => e.type === "way");
const rails = ways.filter((w) => w.tags.railway === "rail");
const platformWays = ways.filter((w) => w.tags.railway === "platform");

const isTunnel = (w) => w.tags.tunnel && w.tags.tunnel !== "building_passage";
const isBridge = (w) => w.tags.bridge && w.tags.bridge !== "no";

/** Where passenger trains run: main and branch lines, and crossovers. */
const isRunning = (w) =>
  (!w.tags.service || w.tags.service === "crossover") &&
  !["tourism", "industrial", "military"].includes(w.tags.usage);

// --- The modelled tracks: everything joined to the platforms, short of
// the first tunnels. ---

const byNode = new Map();

for (const w of rails) {
  for (const id of w.nodes) {
    if (!byNode.has(id)) byNode.set(id, []);
    byNode.get(id).push(w);
  }
}

const platformRings = platformWays
  .filter((w) => w.nodes[0] === w.nodes[w.nodes.length - 1])
  .map((w) => w.nodes.map((id) => points.get(id)));

if (!platformRings.length) throw new Error("no platforms at the station");

const near = (p, ring, distance) =>
  ring.some(([e, n]) => Math.hypot(e - p[0], n - p[1]) < distance);

const modelled = new Set();

const queue = rails.filter((w) =>
  w.nodes.some((id) =>
    platformRings.some((ring) => near(points.get(id), ring, 12))
  )
);

while (queue.length) {
  const w = queue.pop();

  if (modelled.has(w) || isTunnel(w) || w.tags.usage === "tourism") continue;

  if (w.nodes.some((id) => points.get(id)[1] > MODEL_NORTH)) continue;
  modelled.add(w);

  for (const id of w.nodes) queue.push(...byNode.get(id));
}

// --- The graph: modelled tracks and running lines, densified. ---

/** Track points: [easting, northing], and which way they came from. */
const nodes = [];
const nodeIndex = new Map();

const pointFor = (id) => {
  if (!nodeIndex.has(id)) {
    nodeIndex.set(id, nodes.length);
    nodes.push(points.get(id));
  }

  return nodeIndex.get(id);
};

/** [flags, ...track points]. */
const graphWays = [];

for (const w of rails) {
  const model = modelled.has(w);

  if (!model && !isRunning(w)) continue;

  const flags =
    (isTunnel(w) ? TUNNEL : 0) |
    (isBridge(w) ? BRIDGE : 0) |
    (model ? MODEL : 0);

  const step = model ? MODEL_STEP : isTunnel(w) ? TUNNEL_STEP : LINE_STEP;

  // Split where it leaves the map; each piece on it is a way.
  let run = [];

  const flush = () => {
    if (run.length > 1) graphWays.push([flags, ...run]);
    run = [];
  };

  w.nodes.forEach((id, i) => {
    const p = points.get(id);

    if (!onMap(p)) return flush();

    if (run.length) {
      const [pe, pn] = points.get(w.nodes[i - 1]);
      const pieces = Math.ceil(Math.hypot(p[0] - pe, p[1] - pn) / step);

      for (let k = 1; k < pieces; k++) {
        nodes.push([
          pe + ((p[0] - pe) * k) / pieces,
          pn + ((p[1] - pn) * k) / pieces,
        ]);
        run.push(nodes.length - 1);
      }
    }

    run.push(pointFor(id));
  });
  flush();
}

// --- Heights. ---

const neighbours = nodes.map(() => []);

/** Whether a point is inside a tunnel or on a bridge, off the ground. */
const lifted = nodes.map(() => true);

/** Whether it's on the ground: touched by any track that isn't. */
const grounded = nodes.map(() => false);

for (const [flags, ...run] of graphWays) {
  const structure = flags & (TUNNEL | BRIDGE);
  run.forEach((i, k) => {
    if (k > 0) neighbours[i].push(run[k - 1]);

    if (k < run.length - 1) neighbours[i].push(run[k + 1]);

    if (!structure) grounded[i] = true;
  });
}

// Structure ends with nothing beyond them (where they leave the map, or a
// ferry linkspan) stay level with the end that's on the ground.
nodes.forEach((_, i) => (lifted[i] = !grounded[i]));

const sampled = await Promise.all(
  nodes.map(async ([e, n], i) => {
    // Across the track, from its neighbours' direction.
    const [a, b] = [neighbours[i][0] ?? i, neighbours[i][1] ?? i];
    const de = nodes[b][0] - nodes[a][0];
    const dn = nodes[b][1] - nodes[a][1];
    const length = Math.hypot(de, dn) || 1;
    const across = [-dn / length, de / length];

    const heights = await Promise.all(
      [-1, 0, 1].map((s) =>
        groundHeight(
          e + across[0] * s * SAMPLE_SPREAD,
          n + across[1] * s * SAMPLE_SPREAD
        )
      )
    );

    const known = heights.filter((h) => h !== undefined).sort((x, y) => x - y);

    return known.length ? Math.max(known[Math.floor(known.length / 2)], 0) : 0;
  })
);

// Smooth on the ground, holding near what was sampled; carry heights
// through structures from their ends.
let heights = [...sampled];

for (let round = 0; round < SMOOTHING; round++) {
  heights = heights.map((h, i) => {
    if (lifted[i]) return h;
    const around = neighbours[i].filter((j) => !lifted[j]);
    const sum = around.reduce((s, j) => s + heights[j], sampled[i]);

    return sum / (around.length + 1);
  });
}

// Through each run of structure points, by distance between the ends.
const done = new Set();

for (let start = 0; start < nodes.length; start++) {
  if (!lifted[start] || done.has(start)) continue;
  // The structure this point is in: its lifted points and grounded ends.
  const inside = [];
  const ends = new Set();
  const stack = [start];
  done.add(start);

  while (stack.length) {
    const i = stack.pop();
    inside.push(i);

    for (const j of neighbours[i]) {
      if (!lifted[j]) ends.add(j);
      else if (!done.has(j)) {
        done.add(j);
        stack.push(j);
      }
    }
  }

  const anchors = [...ends];

  // Weighted by inverse distance to each end along the track (Dijkstra).
  const distanceFrom = (a) => {
    const d = new Map([[a, 0]]);
    const open = [a];

    while (open.length) {
      open.sort((x, y) => d.get(y) - d.get(x));
      const i = open.pop();

      for (const j of neighbours[i]) {
        if (!lifted[j] && j !== a) continue;

        const next =
          d.get(i) +
          Math.hypot(nodes[j][0] - nodes[i][0], nodes[j][1] - nodes[i][1]);

        if (next < (d.get(j) ?? Infinity)) {
          d.set(j, next);
          open.push(j);
        }
      }
    }

    return d;
  };

  const fromEnds = anchors.map(distanceFrom);

  for (const i of inside) {
    let weights = 0;
    let sum = 0;
    anchors.forEach((a, k) => {
      const d = fromEnds[k].get(i);

      if (d === undefined) return;
      const w = 1 / Math.max(d, 1);
      weights += w;
      sum += w * heights[a];
    });
    heights[i] = weights ? sum / weights : heights[i];
  }
}

// --- Platforms: their outlines, at the ground under them. ---

const platforms = await Promise.all(
  platformRings.map(async (ring) => {
    const ground = await Promise.all(ring.map(([e, n]) => groundHeight(e, n)));
    const known = ground.filter((h) => h !== undefined);

    return {
      ground: round(known.reduce((a, b) => a + b, 0) / known.length),
      ring: ring.slice(0, -1).map(([e, n]) => [round(e), round(n)]),
    };
  })
);

function round(x) {
  return Math.round(x * 10) / 10;
}

// --- Out. ---

// Drop points no way kept, and renumber.
const used = [...new Set(graphWays.flatMap(([, ...run]) => run))].sort(
  (a, b) => a - b
);

const renumber = new Map(used.map((i, k) => [i, k]));

const network = {
  // Generated by scripts/trains/build_rail.mjs. Track © OpenStreetMap
  // contributors (ODbL). NZTM2000 metres; heights are bare-earth ground,
  // before the terrain's vertical scale.
  flags: { tunnel: TUNNEL, bridge: BRIDGE, model: MODEL },
  /** easting, northing, height, … */
  nodes: used.flatMap((i) => [
    round(nodes[i][0]),
    round(nodes[i][1]),
    round(heights[i]),
  ]),
  /** [flags, point, point, …] */
  ways: graphWays.map(([flags, ...run]) => [
    flags,
    ...run.map((i) => renumber.get(i)),
  ]),
  platforms,
};

await mkdir(OUT_DIR, { recursive: true });

const json = JSON.stringify(network);

await writeFile(path.join(OUT_DIR, "network.json"), json);

const model = graphWays.filter(([flags]) => flags & MODEL);

const length = (list) =>
  list.reduce(
    (sum, [, ...run]) =>
      sum +
      run
        .slice(1)
        .reduce(
          (s, i, k) =>
            s +
            Math.hypot(
              nodes[i][0] - nodes[run[k]][0],
              nodes[i][1] - nodes[run[k]][1]
            ),
          0
        ),
    0
  );

console.log(
  `${used.length} points, ${graphWays.length} ways ` +
    `(${(length(graphWays) / 1000).toFixed(1)} km), ` +
    `${model.length} modelled (${(length(model) / 1000).toFixed(1)} km), ` +
    `${platforms.length} platforms; ${(json.length / 1024).toFixed(0)} KB`
);
