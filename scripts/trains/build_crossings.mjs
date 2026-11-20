// Builds public/rail/crossings.json: where the railway crosses roads and
// paths on the level, with what stands at each (flashing lights, bells,
// barrier arms) and where its masts go.
//
//   node scripts/trains/build_crossings.mjs [--osm cached.json]
//
// Crossings come from OpenStreetMap (© OpenStreetMap contributors, ODbL):
// `railway=level_crossing` where a road crosses and `railway=crossing`
// where a path does, with their `crossing:*` tags. They're tied to the
// tracks already in public/rail/network.json by where they are, not by
// OSM's ids, so run build_rail.mjs first; that file isn't rewritten here.
// Only crossings of running lines in it are kept, and of those only the
// ones with lights: trains in the scene run on no other tracks, and the
// rest have nothing to show one coming. Ground heights are read from the
// terrain tiles in public/terrain.
//
// Without --osm the answer's fetched from Overpass and kept in
// .cache/trains/osm_crossings.json.

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
const CACHE = path.join(ROOT, ".cache/trains/osm_crossings.json");

/** As build_rail.mjs's: generous around the terrain root. */
const BBOX = "-41.62,174.52,-40.88,175.45";

const QUERY = `[out:json][timeout:180];
node["railway"~"^(level_crossing|crossing)$"](${BBOX})->.x;
.x out body;
way(bn.x)->.w;
.w out body;
node(w.w);
out skel qt;`;

/** A crossing's node is this near a track in the network, m, or it's left out. */
const ON_TRACK = 3;

/** Nodes of one road's crossing are within this of each other, m. */
const SAME_ROAD = 30;

/** A footpath crossing this near a road's, m, is the road's own footpath. */
const BESIDE_ROAD = 25;

/**
 * Nodes of one path's crossing (a track each) are within this, m: the
 * tracks either side of an island platform are 13 m apart.
 */
const SAME_PATH = 20;

// Kerb-to-kerb widths, m, as the streets painted on the terrain have them
// (scripts/terrain/build_tiles.py, ROAD_WIDTHS and road_width): guesses by
// class there too. Masts stand at these kerbs.
const ROAD_WIDTHS = {
  motorway: 9,
  trunk: 8.5,
  primary: 11,
  secondary: 10,
  tertiary: 9,
  unclassified: 6,
  residential: 7,
  living_street: 5,
  busway: 7,
  pedestrian: 6,
  service: 4,
  track: 3.5,
};

const LINK_WIDTH = 5.5;
const LANE_WIDTH = 3.3;

/** Footpaths and cycleways, m: a guess. */
const PATH_WIDTH = 2.5;

const PATHS = ["footway", "path", "cycleway", "pedestrian", "steps"];

/** Roads the public don't drive: farm and yard crossings, mostly unsignalled. */
const PRIVATE = ["track", "service"];

function roadWidth(tags) {
  const { highway } = tags;

  if (PATHS.includes(highway)) return PATH_WIDTH;

  const width = Number.parseFloat(tags.width ?? "");

  if (width >= 2 && width <= 40) return width;

  const lanes = Number.parseInt(tags.lanes ?? "", 10);

  if (lanes >= 1 && lanes <= 8) {
    return lanes * LANE_WIDTH + (highway === "trunk" ? 2 : 1.5);
  }

  if (highway.endsWith("_link")) return LINK_WIDTH;

  const known = ROAD_WIDTHS[highway] ?? 6;

  return tags.oneway === "yes" && highway !== "trunk" ? known * 0.65 : known;
}

// Masts, m. Their places are guesses at the usual arrangement: one each
// side of the line, on the left of the road for those driving up to it.
/** From the nearest rail to a road's mast, square to the track. */
const MAST_FROM_RAIL = 3.4;

/** From the kerb out to the mast. */
const MAST_FROM_KERB = 0.9;

/** A path's masts stand nearer in, and its gates are short. */
const PATH_MAST_FROM_RAIL = 2.6;
const PATH_MAST_FROM_EDGE = 0.5;

/** Half the gauge, to the rail from the track's centre line. */
const HALF_GAUGE = 0.535;

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

  const text = await response.text();
  await mkdir(path.dirname(CACHE), { recursive: true });
  await writeFile(CACHE, text);

  return JSON.parse(text);
}

const { manifest, groundHeight } = await createGroundSampler(TERRAIN);
const half = manifest.rootSize / 2;

const onMap = ([e, n]) =>
  Math.abs(e - manifest.origin[0]) < half &&
  Math.abs(n - manifest.origin[1]) < half;

// --- The tracks, as build_rail.mjs left them. ---

const network = JSON.parse(
  await readFile(path.join(OUT_DIR, "network.json"), "utf8")
);

const trackPoint = (i) => network.nodes.slice(i * 3, i * 3 + 3);

/** Every piece of open track, in cells, for finding those near a point. */
const CELL = 100;
const cells = new Map();

network.ways.forEach(([flags, ...run], way) => {
  if (flags & network.flags.tunnel) return;
  let along = 0;

  for (let k = 1; k < run.length; k++) {
    const a = trackPoint(run[k - 1]);
    const b = trackPoint(run[k]);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const piece = { way, a, b, along, length };
    along += length;

    for (
      let i = Math.floor(Math.min(a[0], b[0]) / CELL);
      i <= Math.floor(Math.max(a[0], b[0]) / CELL);
      i++
    ) {
      for (
        let j = Math.floor(Math.min(a[1], b[1]) / CELL);
        j <= Math.floor(Math.max(a[1], b[1]) / CELL);
        j++
      ) {
        const key = `${i},${j}`;

        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(piece);
      }
    }
  }
});

/** The nearest place on the tracks to a point, within ON_TRACK, or null. */
function onTrack([e, n]) {
  let best = null;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const key = `${Math.floor(e / CELL) + i},${Math.floor(n / CELL) + j}`;

      for (const { way, a, b, along, length } of cells.get(key) ?? []) {
        const de = b[0] - a[0];
        const dn = b[1] - a[1];

        const t = Math.min(
          Math.max(
            ((e - a[0]) * de + (n - a[1]) * dn) / (length * length || 1),
            0
          ),
          1
        );

        const distance = Math.hypot(a[0] + de * t - e, a[1] + dn * t - n);

        if (distance < (best?.distance ?? ON_TRACK)) {
          best = {
            distance,
            way,
            along: along + t * length,
            height: a[2] + (b[2] - a[2]) * t,
            bearing: Math.atan2(de, dn),
          };
        }
      }
    }
  }

  return best;
}

// --- OSM's crossings, each with its road and its place on the tracks. ---

const osm = await loadOsm();
const points = new Map();

for (const e of osm.elements) {
  if (e.type === "node") points.set(e.id, toNztm(e.lat, e.lon));
}

const ways = osm.elements.filter((e) => e.type === "way");
const roads = ways.filter((w) => w.tags?.highway);

/** Where passenger trains run, as build_rail.mjs has it: not yards or sidings. */
const running = ways.filter(
  (w) =>
    w.tags?.railway === "rail" &&
    (!w.tags.service || w.tags.service === "crossover") &&
    !["tourism", "industrial", "military"].includes(w.tags.usage)
);

const counted = {
  offMap: 0,
  sidings: 0,
  offNetwork: 0,
  noRoad: 0,
  besideRoad: 0,
  plainRoad: 0,
  plainPath: 0,
};

/** A road's direction through one of its nodes, as a bearing, radians. */
function bearingThrough(way, id) {
  const k = way.nodes.indexOf(id);
  const a = points.get(way.nodes[Math.max(k - 1, 0)]);
  const b = points.get(way.nodes[Math.min(k + 1, way.nodes.length - 1)]);

  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}

const found = [];

for (const node of osm.elements) {
  if (node.type !== "node" || !node.tags?.railway) continue;
  const at = points.get(node.id);

  if (!onMap(at)) {
    counted.offMap++;
    continue;
  }

  const over = roads.filter((w) => w.nodes.includes(node.id));

  if (!over.length) {
    counted.noRoad++;
    continue;
  }

  if (!running.some((w) => w.nodes.includes(node.id))) {
    counted.sidings++;
    continue;
  }

  const track = onTrack(at);

  if (!track) {
    counted.offNetwork++;
    continue;
  }

  found.push({
    at,
    track,
    tags: node.tags,
    path: over.every((w) => PATHS.includes(w.tags.highway)),
    roads: over.map((w) => ({
      name: w.tags.name,
      highway: w.tags.highway,
      half: roadWidth(w.tags) / 2,
      bearing: bearingThrough(w, node.id),
    })),
  });
}

// --- Gathered: one crossing for all the tracks a road goes over. ---

/** Groups of `items` chained together by being within `reach` of another. */
function gather(items, reach) {
  const group = items.map((_, i) => i);
  const top = (i) => (group[i] === i ? i : (group[i] = top(group[i])));

  items.forEach((a, i) => {
    items.forEach((b, j) => {
      if (j > i && Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) < reach) {
        group[top(i)] = top(j);
      }
    });
  });

  const groups = new Map();

  items.forEach((item, i) => {
    if (!groups.has(top(i))) groups.set(top(i), []);
    groups.get(top(i)).push(item);
  });

  return [...groups.values()];
}

/** The mean of directions that are the same turned right round, radians. */
function meanAxis(bearings) {
  let s = 0;
  let c = 0;

  for (const b of bearings) {
    s += Math.sin(2 * b);
    c += Math.cos(2 * b);
  }

  return Math.atan2(s, c) / 2;
}

const round = (x, places = 1) => Math.round(x * 10 ** places) / 10 ** places;
const degrees = (radians) => round((((radians * 180) / Math.PI) % 360) + 0, 1);

/** What OSM says of a crossing, across its nodes: the first that says. */
const tagged = (nodes, key) =>
  nodes.map(({ tags }) => tags[key]).find((value) => value !== undefined);

async function describe(nodes, path) {
  const roadBearing = meanAxis(
    nodes.flatMap((node) => node.roads.map((r) => r.bearing))
  );

  const trackBearing = meanAxis(nodes.map((node) => node.track.bearing));
  const along = [Math.sin(roadBearing), Math.cos(roadBearing)];
  const across = [along[1], -along[0]];

  // Where the nodes lie along the road and across it, and so its middle:
  // tracks spread along it, carriageways across.
  const span = (axis, pad) => {
    const at = nodes.map((node, i) => {
      const d = node.at[0] * axis[0] + node.at[1] * axis[1];

      return [d - pad(i), d + pad(i)];
    });

    const low = Math.min(...at.map(([a]) => a));
    const high = Math.max(...at.map(([, b]) => b));

    return { middle: (low + high) / 2, half: (high - low) / 2 };
  };

  const tracks = span(along, () => 0);

  const road = span(across, (i) =>
    Math.max(...nodes[i].roads.map((r) => r.half))
  );

  const centre = [
    along[0] * tracks.middle + across[0] * road.middle,
    along[1] * tracks.middle + across[1] * road.middle,
  ];

  // How square the road is to the track: 1 at a right angle.
  const square = Math.max(Math.abs(Math.sin(roadBearing - trackBearing)), 0.5);

  // What's there. Tags OSM lacks are guessed, and listed as such.
  const guessed = [];
  const said = (key) => tagged(nodes, key);

  const isPrivate = nodes.every((node) =>
    node.roads.every((r) => PRIVATE.includes(r.highway))
  );

  const guess = (key, value) => {
    guessed.push(key);

    return value;
  };

  // A public road's crossing mostly has lights and bells; a farm track's,
  // or a path's that OSM says nothing of, signs alone.
  const lights =
    said("crossing:light") !== undefined
      ? said("crossing:light") === "yes"
      : guess("light", !path && !isPrivate);

  const bells =
    said("crossing:bell") !== undefined
      ? said("crossing:bell") === "yes"
      : guess("bell", lights);

  // No barriers unless OSM says so.
  const barrier = said("crossing:barrier") ?? guess("barrier", "no");

  const arms =
    lights && ["half", "full", "gate", "double_half"].includes(barrier);

  // Masts: one each side of the line. A road's is on the left for those
  // driving up to it, its arm reaching to the middle of the road; a path's
  // to its left too, its gate reaching right across.
  const fromRail = path ? PATH_MAST_FROM_RAIL : MAST_FROM_RAIL;
  const fromEdge = path ? PATH_MAST_FROM_EDGE : MAST_FROM_KERB;
  const setBack = tracks.half + (HALF_GAUGE + fromRail) / square;

  const masts = await Promise.all(
    [1, -1].map(async (side) => {
      // Driving toward the crossing from this side, and that driver's left.
      const heading = [-side * along[0], -side * along[1]];
      const left = [-heading[1], heading[0]];
      const out = road.half + fromEdge;
      const e = centre[0] + side * along[0] * setBack + left[0] * out;
      const n = centre[1] + side * along[1] * setBack + left[1] * out;
      const ground = await groundHeight(e, n);

      return [
        round(e),
        round(n),
        round(ground ?? 0),
        // Which way its lights face: back along the road, at those coming.
        degrees(Math.atan2(-heading[0], -heading[1])),
      ];
    })
  );

  const names = [
    ...new Set(nodes.flatMap((node) => node.roads.map((r) => r.name))),
  ].filter(Boolean);

  // One track for each way of the network it's on: a road of two
  // carriageways meets each track twice.
  const trackCount = new Set(nodes.map((node) => node.track.way)).size;

  return {
    name: names.join(" / "),
    kind: path ? "path" : "road",
    /** Its middle, on the track bed: easting, northing, height. */
    at: [
      round(centre[0]),
      round(centre[1]),
      round(
        nodes.reduce((sum, node) => sum + node.track.height, 0) / nodes.length
      ),
    ],
    /** Bearings, degrees, of the road and of the track through it. */
    road: degrees(roadBearing),
    track: degrees(trackBearing),
    /** Half the road, kerb to kerb, and half the tracks' spread along it, m. */
    half: round(road.half, 2),
    spread: round(tracks.half, 2),
    /** How many tracks, and where on the network: [way, m along it]. */
    count: trackCount,
    tracks: nodes.map((node) => [node.track.way, round(node.track.along)]),
    lights,
    bells,
    barrier,
    /** The arm's reach from each mast, m: 0 where there are none. */
    arm: arms
      ? round(
          path || barrier === "full"
            ? road.half * 2 + fromEdge
            : road.half + fromEdge,
          2
        )
      : 0,
    /** Which of light, bell and barrier OSM didn't say, so are guesses. */
    guessed,
    /** Each mast: easting, northing, ground height, facing (degrees). */
    masts,
  };
}

const crossings = [];

const roadGroups = gather(
  found.filter((node) => !node.path),
  SAME_ROAD
);

// Only those with lights are kept: the rest (farm and access tracks, by
// OSM or for want of tags) have nothing to show a train's coming, and the
// streets painted on the terrain don't reach them.
for (const nodes of roadGroups) {
  const crossing = await describe(nodes, false);

  if (crossing.lights) crossings.push(crossing);
  else counted.plainRoad++;
}

// Paths: not those that are a road crossing's own footpaths, nor those with
// nothing to see (no lights and no gates, by OSM or for want of tags).
const paths = found.filter((node) => {
  if (!node.path) return false;

  const beside = roadGroups.some((nodes) =>
    nodes.some(
      (road) =>
        Math.hypot(road.at[0] - node.at[0], road.at[1] - node.at[1]) <
        BESIDE_ROAD
    )
  );

  if (beside) counted.besideRoad++;

  return !beside;
});

for (const nodes of gather(paths, SAME_PATH)) {
  const crossing = await describe(nodes, true);

  if (crossing.lights) crossings.push(crossing);
  else counted.plainPath++;
}

// South to north, so the file's steady from build to build.
crossings.sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);

// --- Out. ---

const json = JSON.stringify({ crossings });

await mkdir(OUT_DIR, { recursive: true });

await writeFile(path.join(OUT_DIR, "crossings.json"), json);

const count = (test) => crossings.filter(test).length;

console.log(
  `${crossings.length} crossings: ${count((c) => c.kind === "road")} roads ` +
    `(${count((c) => c.kind === "road" && c.lights)} with lights, ` +
    `${count((c) => c.kind === "road" && c.arm > 0)} with barriers), ` +
    `${count((c) => c.kind === "path")} paths with lights ` +
    `(${count((c) => c.kind === "path" && c.arm > 0)} gated); ` +
    `${count((c) => c.guessed.length > 0)} part guessed; ` +
    `${(json.length / 1024).toFixed(1)} KB`
);

console.log(
  `left out: ${counted.offMap} nodes off the map, ${counted.sidings} on ` +
    `yards, sidings and other lines, ${counted.offNetwork} on track not in ` +
    `the network, ${counted.noRoad} with no road, ` +
    `${counted.besideRoad} footpaths beside a road's crossing, ` +
    `${counted.plainRoad} roads and ${counted.plainPath} paths with no lights`
);

for (const c of crossings) {
  console.log(
    `  ${c.kind} ${c.name || "(unnamed)"}: ${c.count} track(s), ` +
      `${c.lights ? "lights" : "no lights"}, ${c.bells ? "bells" : "no bells"}, ` +
      `barrier ${c.barrier}` +
      (c.guessed.length ? ` [guessed: ${c.guessed.join(", ")}]` : "")
  );
}
