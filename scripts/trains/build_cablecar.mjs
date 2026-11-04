// Builds public/rail/cablecar.json: the Wellington Cable Car's track, as a
// rail network like network.json (so the scene lays it the same way), and
// the way each of its two cars runs, Kelburn to Lambton Quay.
//
//   node scripts/trains/build_cablecar.mjs [--osm cached.json]
//
// Track geometry and stops come from OpenStreetMap (© OpenStreetMap
// contributors, ODbL). The line is single track with a passing loop at
// Talavera, where the cars cross: each car always takes the same side of
// it. Heights are read from the terrain tiles in public/terrain (so run
// this after build_tiles.py): on the ground, smoothed; through tunnels and
// over the viaducts, carried straight from end to end.

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

const BBOX = "-41.290,174.764,-41.282,174.778";

const QUERY = `[out:json][timeout:60];
(
  way["railway"="funicular"](${BBOX});
  node["railway"="stop"]["ref"](${BBOX});
)->.found;
.found out body;
way.found;
node(w);
out skel qt;`;

/**
 * Where the bottom terminus opens onto Cable Car Lane, off Lambton Quay.
 * It's inside a building at the end of a tunnel, level with the street: the
 * ground OSM puts it on is the hillside behind, 20 m higher.
 */
const LAMBTON_STREET = [-41.28418, 174.7753];

/** Track points are at most this far apart, m. */
const STEP = 3;

/**
 * Track centres through the passing loop, m: OSM has them 2.3 m apart at
 * most, too close for cars 2.5 m wide to pass. They spread to this over
 * SWITCH from either end of the loop.
 */
const LOOP_SPACING = 3.4;
const SWITCH = 10;

/** Ground is sampled this far either side of the track too, m. */
const SAMPLE_SPREAD = 2;

/** Rounds of smoothing between neighbouring track points. */
const SMOOTHING = 20;

/**
 * Rounds of fairing along the whole line, once tunnels and viaducts are
 * carried through: its grade's nearly even, about 1 in 5, so the joins
 * between them and the ground shouldn't kink.
 */
const FAIRING = 40;

/** Bits of a way's flags, as network.json's. */
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

const { groundHeight } = await createGroundSampler(TERRAIN);
const osm = await loadOsm();
const points = new Map();

for (const e of osm.elements) {
  if (e.type === "node") points.set(e.id, toNztm(e.lat, e.lon));
}

const ways = osm.elements.filter(
  (e) => e.type === "way" && e.tags?.railway === "funicular"
);

const stopNodes = osm.elements.filter(
  (e) => e.type === "node" && e.tags?.railway === "stop" && e.tags.ref
);

// A station building over the track isn't a tunnel.
const isTunnel = (w) => w.tags.tunnel && w.tags.tunnel !== "building_passage";
const isBridge = (w) => w.tags.bridge && w.tags.bridge !== "no";

// --- The two ways through, top to bottom: one per side of the loop. ---

const waysAt = new Map();

for (const w of ways) {
  for (const id of [w.nodes[0], w.nodes.at(-1)]) {
    if (!waysAt.has(id)) waysAt.set(id, []);
    waysAt.get(id).push(w);
  }
}

const ends = [...waysAt].flatMap(([id, at]) => (at.length === 1 ? [id] : []));

if (ends.length !== 2) throw new Error(`${ends.length} ends to the line`);

// Kelburn's the higher end, to the west.
const [top, bottom] = ends.sort((a, b) => points.get(a)[0] - points.get(b)[0]);

/** Every way from `node` to the bottom, avoiding `used`: [way, forward][]. */
function routes(node, used) {
  if (node === bottom) return [[]];

  return waysAt.get(node).flatMap((w) => {
    if (used.has(w)) return [];
    const forward = w.nodes[0] === node;
    const next = forward ? w.nodes.at(-1) : w.nodes[0];

    return routes(next, new Set([...used, w])).map((rest) => [
      [w, forward],
      ...rest,
    ]);
  });
}

const through = routes(top, new Set());

if (through.length !== 2) throw new Error(`${through.length} ways through`);

// --- Track points, shared where the ways are, densified. ---

/** [easting, northing]. */
const nodes = [];
const nodeIndex = new Map();

const pointFor = (id) => {
  if (!nodeIndex.has(id)) {
    nodeIndex.set(id, nodes.length);
    nodes.push(points.get(id));
  }

  return nodeIndex.get(id);
};

/** Each OSM way's track points, in its own direction, and its flags. */
const graphWays = new Map(
  ways.map((w) => {
    const run = [];

    w.nodes.forEach((id, i) => {
      if (i > 0) {
        const [pe, pn] = points.get(w.nodes[i - 1]);
        const [e, n] = points.get(id);
        const pieces = Math.ceil(Math.hypot(e - pe, n - pn) / STEP);

        for (let k = 1; k < pieces; k++) {
          nodes.push([
            pe + ((e - pe) * k) / pieces,
            pn + ((n - pn) * k) / pieces,
          ]);
          run.push(nodes.length - 1);
        }
      }

      run.push(pointFor(id));
    });

    const flags =
      (isTunnel(w) ? TUNNEL : 0) | (isBridge(w) ? BRIDGE : 0) | MODEL;

    return [w, { flags, run }];
  })
);

/** Each car's track points, top to bottom, and whether each is lifted. */
const paths = through.map((route) => {
  const path = [];
  const lifted = [];

  for (const [w, forward] of route) {
    const { flags, run } = graphWays.get(w);
    const ordered = forward ? run : [...run].reverse();
    const structure = (flags & (TUNNEL | BRIDGE)) !== 0;

    ordered.forEach((i, k) => {
      // A way's first point is the last one's end: on the ground if either is.
      if (k === 0 && path.length) {
        lifted[lifted.length - 1] &&= structure;

        return;
      }

      path.push(i);
      lifted.push(structure);
    });
  }

  return { path, lifted };
});

// --- The loop, spread so the cars can pass. ---

const smoothstep = (x) => {
  const t = Math.min(Math.max(x, 0), 1);

  return t * t * (3 - 2 * t);
};

/** The nearest point to `p` on the line through `line`'s points. */
function nearestOn(p, line) {
  let best = { gap: Infinity, at: line[0] };

  for (let k = 1; k < line.length; k++) {
    const [a, b] = [line[k - 1], line[k]];
    const [de, dn] = [b[0] - a[0], b[1] - a[1]];
    const length = de * de + dn * dn || 1;

    const t = Math.min(
      Math.max(((p[0] - a[0]) * de + (p[1] - a[1]) * dn) / length, 0),
      1
    );

    const at = [a[0] + de * t, a[1] + dn * t];
    const gap = Math.hypot(p[0] - at[0], p[1] - at[1]);

    if (gap < best.gap) best = { gap, at };
  }

  return best;
}

const shared = new Set(paths[0].path.filter((i) => paths[1].path.includes(i)));
const spread = new Map();

for (const [mine, theirs] of [paths, [...paths].reverse()]) {
  const first = mine.path.findIndex((i) => !shared.has(i));
  const last = mine.path.findLastIndex((i) => !shared.has(i));
  const [from, to] = [mine.path[first - 1], mine.path[last + 1]];

  const other = theirs.path
    .slice(theirs.path.indexOf(from), theirs.path.indexOf(to) + 1)
    .map((i) => nodes[i]);

  const branch = mine.path.slice(first - 1, last + 2);
  const along = [0];

  for (let k = 1; k < branch.length; k++) {
    const [a, b] = [nodes[branch[k - 1]], nodes[branch[k]]];
    along.push(along[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }

  branch.forEach((i, k) => {
    if (shared.has(i)) return;

    const p = nodes[i];
    const { gap, at } = nearestOn(p, other);
    const fromEnd = Math.min(along[k], along.at(-1) - along[k]);
    const wanted = LOOP_SPACING * smoothstep(fromEnd / SWITCH);

    if (wanted <= gap || gap === 0) return;

    // Each track takes half the move.
    const push = (wanted - gap) / 2 / gap;
    spread.set(i, [p[0] + (p[0] - at[0]) * push, p[1] + (p[1] - at[1]) * push]);
  });
}

for (const [i, p] of spread) nodes[i] = p;

// --- Heights. ---

const neighbours = nodes.map(() => new Set());
const grounded = nodes.map(() => false);

for (const { path, lifted } of paths) {
  path.forEach((i, k) => {
    if (k > 0) neighbours[i].add(path[k - 1]);

    if (k < path.length - 1) neighbours[i].add(path[k + 1]);

    if (!lifted[k]) grounded[i] = true;
  });
}

const sampled = await Promise.all(
  nodes.map(async ([e, n], i) => {
    const [a, b] = [...neighbours[i]];
    const de = nodes[b ?? i][0] - nodes[a][0];
    const dn = nodes[b ?? i][1] - nodes[a][1];
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

    return known[Math.floor(known.length / 2)];
  })
);

let heights = [...sampled];

for (let round = 0; round < SMOOTHING; round++) {
  heights = heights.map((h, i) => {
    if (!grounded[i]) return h;
    const around = [...neighbours[i]].filter((j) => grounded[j]);
    const sum = around.reduce((s, j) => s + heights[j], sampled[i]);

    return sum / (around.length + 1);
  });
}

const bottomIndex = nodeIndex.get(bottom);

heights[bottomIndex] = await groundHeight(...toNztm(...LAMBTON_STREET));

const distance = (a, b) =>
  Math.hypot(nodes[b][0] - nodes[a][0], nodes[b][1] - nodes[a][1]);

// Through each run of lifted points along a car's way, straight between the
// grounded points either side (the terminus counts as one).
for (const { path, lifted } of paths) {
  let k = 0;

  while (k < path.length) {
    if (!lifted[k] || path[k] === bottomIndex) {
      k++;
      continue;
    }

    const from = k - 1;
    let to = k;

    while (to < path.length - 1 && lifted[to] && path[to] !== bottomIndex) to++;

    const along = [0];

    for (let j = from + 1; j <= to; j++) {
      along.push(along.at(-1) + distance(path[j - 1], path[j]));
    }

    const [h0, h1] = [heights[path[from]], heights[path[to]]];

    for (let j = from + 1; j < to; j++) {
      const t = along[j - from] / along.at(-1);
      heights[path[j]] = h0 + (h1 - h0) * t;
    }

    k = to + 1;
  }
}

const topIndex = nodeIndex.get(top);

for (let round = 0; round < FAIRING; round++) {
  heights = heights.map((h, i) => {
    if (i === topIndex || i === bottomIndex) return h;
    const around = [...neighbours[i]];

    return (
      (h + around.reduce((s, j) => s + heights[j], 0)) / (around.length + 1)
    );
  });
}

// --- Stops: how far down each car's way, as a share of its length. ---

const round = (x) => Math.round(x * 10) / 10;

const cars = paths.map(({ path }) => {
  const along = [0];

  for (let k = 1; k < path.length; k++) {
    const [a, b] = [path[k - 1], path[k]];
    const rise = heights[b] - heights[a];
    along.push(along.at(-1) + Math.hypot(distance(a, b), rise));
  }

  const length = along.at(-1);
  const stops = {};

  for (const node of stopNodes) {
    const [e, n] = points.get(node.id);
    let nearest = { gap: Infinity, k: 0 };

    path.forEach((i, k) => {
      const gap = Math.hypot(nodes[i][0] - e, nodes[i][1] - n);

      if (gap < nearest.gap) nearest = { gap, k };
    });

    // Talavera's on both sides of the loop: each car's own.
    const known = stops[node.tags.ref];

    if (known && known.gap <= nearest.gap) continue;
    stops[node.tags.ref] = { gap: nearest.gap, at: along[nearest.k] / length };
  }

  return {
    path,
    length,
    stops: Object.fromEntries(
      Object.entries(stops).map(([ref, { at }]) => [
        ref,
        Math.round(at * 1e4) / 1e4,
      ])
    ),
  };
});

// --- Out. ---

const network = {
  // Generated by scripts/trains/build_cablecar.mjs. Track © OpenStreetMap
  // contributors (ODbL). NZTM2000 metres; heights are bare-earth ground,
  // before the terrain's vertical scale.
  flags: { tunnel: TUNNEL, bridge: BRIDGE, model: MODEL },
  /** easting, northing, height, … */
  nodes: nodes.flatMap(([e, n], i) => [round(e), round(n), round(heights[i])]),
  /** [flags, point, point, …] */
  ways: [...graphWays.values()].map(({ flags, run }) => [flags, ...run]),
  platforms: [],
  /**
   * Each car's way down, Kelburn to Lambton Quay, as track points, and
   * where its stops are along it (0 at the top, 1 at the bottom), by
   * Metlink's stop id.
   */
  cars: cars.map(({ path, stops }) => ({ path, stops })),
};

await mkdir(OUT_DIR, { recursive: true });

const json = JSON.stringify(network);

await writeFile(path.join(OUT_DIR, "cablecar.json"), json);

console.log(
  `${nodes.length} points, ${ways.length} ways; cars' ways ` +
    cars.map(({ length }) => `${length.toFixed(0)} m`).join(" and ") +
    `, ${heights[topIndex].toFixed(1)} m down to ` +
    `${heights[bottomIndex].toFixed(1)} m; stops ` +
    JSON.stringify(cars.map(({ stops }) => stops)) +
    `; ${(json.length / 1024).toFixed(1)} KB`
);
