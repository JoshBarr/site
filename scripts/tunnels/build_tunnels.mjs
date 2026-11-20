// Builds public/tunnels/tunnels.json: the road tunnels around Wellington,
// for the scene to line and put portals on, and for the buses' routes to go
// through (build_routes.mjs) rather than over the hill.
//
//   node scripts/tunnels/build_tunnels.mjs [--osm cached.json]
//
// The highways' tunnels are taken as their traffic drives them, from
// public/roads/roads.json (so run this after build_roads.mjs); every other
// road's from OpenStreetMap (© OpenStreetMap contributors, ODbL), with its
// floor carried straight from the ground at one portal to the ground at the
// other, read from the terrain tiles in public/terrain. Only tunnels the
// terrain covers are kept: an underpass beneath a bridge or a building,
// which bare earth doesn't have, would be a trench with a lid.
//
// The railway's tunnels aren't here: the scene takes those from the rail
// network itself.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGroundSampler, toNztm } from "../lib/geo.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const TERRAIN = path.join(ROOT, "public/terrain");
const ROADS = path.join(ROOT, "public/roads/roads.json");
const OUT_DIR = path.join(ROOT, "public/tunnels");

/** Generous around the terrain root; clipped to it below. */
const BBOX = "-41.62,174.52,-40.88,175.45";

const QUERY = `[out:json][timeout:180];
way["highway"]["tunnel"](${BBOX})->.ways;
.ways out body;
node(w.ways);
out skel qt;`;

/** Roads traffic drives: not driveways, service ways or paths. */
const DRIVEN = new Set(
  [
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
  ].flatMap((h) => [h, `${h}_link`])
);

/** Floor points are at most this far apart, m. */
const STEP = 12;

/** The ground over a tunnel is read this often along it, m. */
const COVER_STEP = 4;

/**
 * The most ground over a tunnel's floor must be at least this, m, for it to
 * be one in the terrain.
 */
const LEAST_COVER = 4;

/**
 * Lanes, m, and the seal beyond the outer ones, as roads.ts and the road
 * surfaces have them: motorway and open road, and town streets at 50 or
 * less.
 */
const LANE = 3.5;
const TOWN_LANE = 3.2;
const SHOULDER = 1.2;
const TOWN_SHOULDER = 0.4;

/**
 * The highways' surface, above the ground it's laid on, m: ROAD_TOP in
 * roads.ts.
 */
const ROAD_TOP = 0.25;

/**
 * From the floor to the crown, m: the highways', and the most a street's
 * has; it's lower where there's less ground over it, down to the least.
 */
const HEIGHT = 5.4;
const STREET_HEIGHT = 5;
const LEAST_HEIGHT = 4.2;

/** Ground is sampled this far around a portal as well, m, and the middle kept. */
const SAMPLE_SPREAD = 2.5;

/** A way ending this near a highway's tunnel, m, is that tunnel. */
const SAME = 20;

/** A span's flag for a tunnel, in roads.json. */
const TUNNEL = 1;

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

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const round = (x) => Math.round(x * 10) / 10;

const osm = await loadOsm();
const points = new Map();

for (const e of osm.elements) {
  if (e.type === "node") points.set(e.id, toNztm(e.lat, e.lon));
}

const isTunnel = (w) =>
  w.tags.tunnel && !["no", "building_passage"].includes(w.tags.tunnel);

const tunnelWays = osm.elements.filter(
  (e) => e.type === "way" && isTunnel(e) && DRIVEN.has(e.tags.highway)
);

const nameOf = (w) => w.tags["tunnel:name"] ?? w.tags.name ?? "";

/** The name of the OSM tunnel with an end nearest `p`, if one's near. */
function nameNear(p) {
  let best = "";
  let nearest = SAME;

  for (const w of tunnelWays) {
    for (const id of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
      const d = distance(points.get(id), p);

      if (d < nearest) {
        nearest = d;
        best = nameOf(w);
      }
    }
  }

  return best;
}

const tunnels = [];

// --- The highways', from the carriageways traffic drives. ---

const roads = JSON.parse(await readFile(ROADS, "utf8"));

for (const carriageway of Object.values(roads.carriageways)) {
  const count = carriageway.points.length / 3;

  carriageway.spans.forEach(([from, , total, flags, maxspeed], k) => {
    if (!(flags & TUNNEL)) return;

    // Carried on by the next span, or carrying on the one before: one run.
    if (k > 0 && carriageway.spans[k - 1][3] & TUNNEL) return;
    let last = k;

    while (carriageway.spans[last + 1]?.[3] & TUNNEL) last++;
    const to = carriageway.spans[last + 1]?.[0] ?? count - 1;

    const line = [];

    for (let i = from; i <= to; i++) {
      line.push(carriageway.points.slice(i * 3, i * 3 + 3));
    }

    // A two-way road's other carriageway is the same tunnel, backwards.
    const ends = [line[0], line[line.length - 1]];

    const known = tunnels.some(({ line: other }) =>
      [other[0], other[other.length - 1]].every((end) =>
        ends.some((p) => distance(p, end) < SAME)
      )
    );

    if (known) return;
    const fast = maxspeed > 50;
    const lane = fast ? LANE : TOWN_LANE;

    tunnels.push({
      name: nameNear(line[0]) || nameNear(line[line.length - 1]),
      lanes: total,
      // Both ways' lanes and a shoulder each side, as the road outside is
      // built (traffic/geometry.ts).
      width: total * lane + 2 * (fast ? SHOULDER : TOWN_SHOULDER),
      lane,
      height: HEIGHT,
      top: ROAD_TOP,
      line,
    });
  });
}

const highways = tunnels.length;

// --- Every other road's, from OpenStreetMap. ---

const refsOf = (w) =>
  (w.tags.ref ?? "").split(";").map((r) => r.replace(/\s+/g, "").toUpperCase());

const others = tunnelWays.filter(
  (w) =>
    !refsOf(w).some((r) => r === "SH1" || r === "SH2") &&
    w.nodes.every((id) => onMap(points.get(id)))
);

// A tunnel mapped as several ways end to end is one tunnel.
const runs = [];
const taken = new Set();

for (const w of others) {
  if (taken.has(w)) continue;
  taken.add(w);
  const nodes = [...w.nodes];
  const ways = [w];

  for (let grown = true; grown;) {
    grown = false;

    for (const other of others) {
      if (taken.has(other)) continue;
      const first = other.nodes[0];
      const last = other.nodes[other.nodes.length - 1];

      if (first === nodes[nodes.length - 1]) {
        nodes.push(...other.nodes.slice(1));
      } else if (last === nodes[0]) {
        nodes.unshift(...other.nodes.slice(0, -1));
      } else if (last === nodes[nodes.length - 1]) {
        nodes.push(...other.nodes.toReversed().slice(1));
      } else if (first === nodes[0]) {
        nodes.unshift(...other.nodes.toReversed().slice(0, -1));
      } else continue;

      taken.add(other);
      ways.push(other);
      grown = true;
    }
  }

  runs.push({ ways, nodes });
}

const median = (heights) => {
  const known = heights.filter((h) => h !== undefined).sort((x, y) => x - y);

  return known.length ? Math.max(known[Math.floor(known.length / 2)], 0) : 0;
};

/** The ground at a portal: the middle of it and four places around. */
const portalHeight = async ([e, n]) => {
  const s = SAMPLE_SPREAD;

  return median(
    await Promise.all(
      [
        [0, 0],
        [s, 0],
        [-s, 0],
        [0, s],
        [0, -s],
      ].map(([de, dn]) => groundHeight(e + de, n + dn))
    )
  );
};

/** Points along `line` no more than `step` apart. */
function densify(line, step) {
  const out = [line[0]];

  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const pieces = Math.max(Math.ceil(distance(a, b) / step), 1);

    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }

  return out;
}

/** Each point of `line` with the floor's height, straight from end to end. */
function floored(line, start, end) {
  const along = [0];

  for (let i = 1; i < line.length; i++) {
    along.push(along[i - 1] + distance(line[i - 1], line[i]));
  }

  const length = along[along.length - 1] || 1;

  return line.map(([e, n], i) => [
    e,
    n,
    start + ((end - start) * along[i]) / length,
  ]);
}

const skipped = [];

for (const { ways, nodes } of runs) {
  const line = nodes.map((id) => points.get(id));
  const name = ways.map(nameOf).find(Boolean) ?? "";

  // One of the highways', mapped without its number.
  const ends = [line[0], line[line.length - 1]];

  const known = tunnels.some(({ line: other }) =>
    [other[0], other[other.length - 1]].every((end) =>
      ends.some((p) => distance(p, end) < SAME)
    )
  );

  if (known) continue;

  const [start, end] = await Promise.all(ends.map(portalHeight));

  const fine = floored(densify(line, COVER_STEP), start, end);

  const ground = await Promise.all(
    fine.map(([e, n]) => groundHeight(e, n).then((h) => h ?? 0))
  );

  const cover = Math.max(...fine.map(([, , floor], i) => ground[i] - floor));

  if (cover < LEAST_COVER) {
    skipped.push(`${name || ways[0].id} (${cover.toFixed(1)} m)`);
    continue;
  }

  const lanes = Math.max(
    ...ways.map(
      (w) =>
        Number.parseInt(w.tags.lanes) ||
        (["yes", "true", "1", "-1"].includes(w.tags.oneway) ? 1 : 2)
    )
  );

  tunnels.push({
    name,
    lanes,
    // Never narrower than two lanes: buses each way keep to their own side
    // of the middle, even through a single lane taken in turns.
    width: Math.max(lanes, 2) * TOWN_LANE + 2 * TOWN_SHOULDER,
    lane: TOWN_LANE,
    height: Math.min(Math.max(cover - 0.3, LEAST_HEIGHT), STREET_HEIGHT),
    top: 0,
    line: floored(densify(line, STEP), start, end),
  });
}

// --- Out. ---

const file = {
  // Generated by scripts/tunnels/build_tunnels.mjs. The highways' tunnels
  // from public/roads/roads.json; the rest © OpenStreetMap contributors
  // (ODbL). NZTM2000 metres; heights are the ground before the terrain's
  // vertical scale, and the road's surface is `top` above that after it.
  tunnels: tunnels
    .toSorted(
      (a, b) => a.line[0][1] - b.line[0][1] || a.line[0][0] - b.line[0][0]
    )
    .map(({ name, lanes, lane, width, height, top, line }) => ({
      name,
      /** Marked on the floor, `lane` m wide; the floor is `width` across. */
      lanes,
      lane,
      width: round(width),
      /** Floor to crown, m. */
      height: round(height),
      top,
      /** easting, northing, height, … */
      points: line.flatMap(([e, n, h]) => [round(e), round(n), round(h)]),
    })),
};

await mkdir(OUT_DIR, { recursive: true });

const json = JSON.stringify(file);

await writeFile(path.join(OUT_DIR, "tunnels.json"), json);

const length = (line) =>
  line.slice(1).reduce((sum, p, i) => sum + distance(line[i], p), 0);

for (const { name, lanes, width, height, line } of tunnels) {
  console.log(
    `  ${(name || "(unnamed)").padEnd(24)} ${length(line).toFixed(0).padStart(4)} m, ` +
      `${lanes} lane${lanes === 1 ? "" : "s"}, ${width.toFixed(1)} m wide, ` +
      `${height.toFixed(1)} m high`
  );
}

console.log(
  `${tunnels.length} tunnels (${highways} on the highways); ` +
    `${(json.length / 1024).toFixed(1)} KB` +
    (skipped.length
      ? `\nnot covered by the terrain: ${skipped.join(", ")}`
      : "")
);
