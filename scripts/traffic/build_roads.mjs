// Builds public/roads/roads.json: State Highways 1, 2, 58 and 59 around
// Wellington as one-way carriageways for the scene's traffic to drive, with
// where NZTA's live speeds apply along each, and the Mungavin Interchange's
// raised roundabout over SH59 at Porirua with its ramps.
//
//   node scripts/traffic/build_roads.mjs [--osm cached.json] [--nzta cached.json]
//     [--save-osm to.json]
//
// Road geometry, lanes and limits come from OpenStreetMap (© OpenStreetMap
// contributors, ODbL); speeds from NZTA's traffic API (CC BY 4.0), whose
// journeys are split into legs and legs into links, each with a speed.
// Links carry no geometry of their own, so each is placed by its length
// along its leg, and legs by their end points. Heights are read from the
// terrain tiles in public/terrain (so run this after build_tiles.py),
// smoothed along the road, and carried straight from end to end over
// bridges and through tunnels. Run build_decks.py after it: that lifts the
// bridges' decks to where the lidar found them.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGroundSampler, toNztm } from "../lib/geo.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const TERRAIN = path.join(ROOT, "public/terrain");
const OUT_DIR = path.join(ROOT, "public/roads");

/** Generous around the terrain root; clipped to it below. */
const BBOX = "-41.62,174.52,-40.88,175.45";
const SH = `["highway"]["ref"~"(^|;) *SH ?(1|2|58|59)($|;)"]`;

/** The highways the scene draws, as refsOf has them. */
const HIGHWAYS = ["SH1", "SH2", "SH58", "SH59"];

/**
 * SH59's raised roundabout at Porirua: its ring, as OSM names it, and how
 * far from the ring its ramps reach, m.
 */
const RING = "Mungavin Interchange";
const RAMP_REACH = 700;

/**
 * OSM leaves SH58's and SH59's ref off some of their pieces: roundabouts,
 * and stretches redrawn since. Roads like theirs without a ref, this near
 * them, m, can fill the gaps.
 */
const GAP_REACH = 20;

// The highways, the interchange, what might fill the gaps in SH58 and SH59,
// and every road that meets them, for where traffic joins and leaves.
const QUERY = `[out:json][timeout:180];
way${SH}(${BBOX})->.sh;
way["highway"]["ref"~"(^|;) *SH ?(58|59)($|;)"](${BBOX})->.minor;
way["highway"~"^(trunk|primary)$"][!"ref"](around.minor:${GAP_REACH})->.gaps;
way["highway"]["junction"="roundabout"]["name"="${RING}"](${BBOX})->.ring;
way["highway"~"_link$"](around.ring:${RAMP_REACH})->.ramps;
(.sh; .gaps; .ring; .ramps;)->.core;
node(w.core)->.n;
way(bn.n)["highway"]->.touching;
(.core; .touching;)->.ways;
.ways out body;
node(w.core);
out skel qt;`;

const NZTA =
  "http://trafficnz.info/service/traffic/rest/4/journeys/byregion/9/14";

/** Where SH1 ends, at the airport, and SH2 meets it, at Ngauranga. */
const AIRPORT = toNztm(-41.3259, 174.8099);
const NGAURANGA = toNztm(-41.249, 174.8115);

/** Carriageway points are at most this far apart, m; in tunnels, this. */
const STEP = 8;
const TUNNEL_STEP = 25;

/** Lanes, m: motorway and open road, and town streets at 50 or less. */
const LANE = 3.5;
const TOWN_LANE = 3.2;

/** Ground's sampled this far across the road as well as on it, m. */
const SAMPLE_SPREAD = 0.3;

/** Rounds of smoothing between neighbouring points. */
const SMOOTHING = 40;

/** Bits of a span's flags. */
const TUNNEL = 1;
const BRIDGE = 2;

/** Traffic comes the other way on the same road, past the right edge. */
const TWO_WAY = 4;

/** Bits of a junction's kind. */
const JOINS = 1;
const LEAVES = 2;

/** Roads traffic joins from and leaves by: not driveways or paths. */
const ROADS = new Set(
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

/**
 * NZTA's own journeys loop round the network, link after link: these runs
 * of them, first to last link, are placed along a carriageway by their
 * lengths between the links placed already, for the directions whose legs
 * list the whole loop instead of their own links. `end` is where the last
 * link finishes, when no placed link's there to say.
 */
const CHAINS = [
  {
    carriageway: "SH1N",
    from: "Wellington Airport To Lane Merge",
    to: "Emergency Breakdown Area Sh1 Nb Rail Crossing To Ngauranga",
    end: NGAURANGA,
  },
  {
    carriageway: "SH2N",
    from: "Ngauranga Interchange Sh1/Sh2 To Nguaranga On Ramp",
    to: "Fergusson Drive Off Ramp South To Fergusson Drive Off Ramp",
  },
  {
    carriageway: "SH2S",
    from: "Manor Park Vms To Manor Park Vms",
    to: "Petone On Ramp To Ngauranga Off Ramp",
  },
];

async function loadJson(flag, fetchIt) {
  const cached = process.argv.indexOf(flag);

  if (cached > 0)
    return JSON.parse(await readFile(process.argv[cached + 1], "utf8"));

  return fetchIt();
}

const loadOsm = () =>
  loadJson("--osm", async () => {
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
    const osm = await response.json();
    const save = process.argv.indexOf("--save-osm");

    if (save > 0) await writeFile(process.argv[save + 1], JSON.stringify(osm));

    return osm;
  });

const loadNzta = () =>
  loadJson("--nzta", async () => {
    const response = await fetch(NZTA, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) throw new Error(`nzta: ${response.status}`);

    return response.json();
  });

const { manifest, groundHeight } = await createGroundSampler(TERRAIN);
const half = manifest.rootSize / 2;

const onMap = ([e, n]) =>
  Math.abs(e - manifest.origin[0]) < half &&
  Math.abs(n - manifest.origin[1]) < half;

const [osm, nzta] = await Promise.all([loadOsm(), loadNzta()]);
const points = new Map();

for (const e of osm.elements) {
  if (e.type === "node") points.set(e.id, toNztm(e.lat, e.lon));
}

const allWays = osm.elements.filter((e) => e.type === "way");

const refsOf = (w) =>
  (w.tags.ref ?? "").split(";").map((r) => r.replace(/\s+/g, "").toUpperCase());

const highwayWays = allWays.filter((w) =>
  refsOf(w).some((r) => HIGHWAYS.includes(r))
);

const isTunnel = (w) => w.tags.tunnel && w.tags.tunnel !== "building_passage";
const isBridge = (w) => w.tags.bridge && w.tags.bridge !== "no";

/** 1 one way along the way, -1 the other, 0 both. */
const onewayOf = (w) => {
  const o = w.tags.oneway;

  if (o === "-1") return -1;

  if (o === "yes" || o === "true" || o === "1") return 1;

  if (o === "no") return 0;

  return w.tags.highway === "motorway" || w.tags.junction === "roundabout"
    ? 1
    : 0;
};

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// --- Carriageways: one way along each highway, start to end. ---

/**
 * The shortest way along `ways` from any of `sources` to any of `targets`
 * (node ids), keeping to their one-way rules: each step's node and way.
 * Each metre on a way costs `cost(way)`. Sources and targets can be Maps
 * of node to what starting or finishing there costs on top, to favour the
 * ends of a road over the nodes just short of them.
 */
function route(ways, sources, targets, cost = () => 1) {
  const out = new Map();

  for (const w of ways) {
    const way = onewayOf(w);

    for (let i = 0; i < w.nodes.length - 1; i++) {
      const [a, b] = [w.nodes[i], w.nodes[i + 1]];

      if (!points.has(a) || !points.has(b)) continue;

      if (!onMap(points.get(a)) || !onMap(points.get(b))) continue;

      const add = (from, to) => {
        if (!out.has(from)) out.set(from, []);
        out.get(from).push([to, w, cost(w)]);
      };

      if (way >= 0) add(a, b);

      if (way <= 0) add(b, a);
    }
  }

  const costs = new Map();
  /** How each node was reached: the node before, and the way between. */
  const previous = new Map();
  const open = new Heap();

  const extra = (set, node) => (set instanceof Map ? set.get(node) : 0);

  // Queued: a node reached, or (`finished`) one finished at, once what
  // finishing there costs on top is counted.
  for (const s of sources.keys()) {
    costs.set(s, extra(sources, s));
    open.push(extra(sources, s), { node: s, finished: false });
  }

  const done = new Set();

  while (open.size) {
    const [c0, { node, finished }] = open.pop();

    if (!finished && done.has(node)) continue;
    done.add(node);

    // Finishing here, short of the end, costs more: queued, and on past it.
    const short = !finished && targets.has(node) && extra(targets, node) > 0;

    if (short) {
      open.push(c0 + extra(targets, node), { node, finished: true });
    }

    if (targets.has(node) && !short) {
      // Each step: a node, and the way on to the next.
      const steps = [[node, null]];

      for (let at = node; previous.has(at);) {
        const [from, way] = previous.get(at);
        steps.unshift([from, way]);
        at = from;
      }

      return steps;
    }

    for (const [next, way, perMetre] of out.get(node) ?? []) {
      const c =
        costs.get(node) +
        distance(points.get(node), points.get(next)) * perMetre;

      if (c < (costs.get(next) ?? Infinity)) {
        costs.set(next, c);
        previous.set(next, [node, way]);
        open.push(c, { node: next, finished: false });
      }
    }
  }

  throw new Error("no route");
}

class Heap {
  items = [];
  get size() {
    return this.items.length;
  }
  push(cost, value) {
    const items = this.items;
    items.push([cost, value]);

    for (let i = items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;

      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();

    if (items.length) {
      items[0] = last;

      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;

        if (l < items.length && items[l][0] < items[m][0]) m = l;

        if (r < items.length && items[r][0] < items[m][0]) m = r;

        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }

    return top;
  }
}

const nodesOf = (ways) =>
  [...new Set(ways.flatMap((w) => w.nodes))].filter(
    (id) => points.has(id) && onMap(points.get(id))
  );

const sh1 = highwayWays.filter((w) => refsOf(w).includes("SH1"));
const sh2 = highwayWays.filter((w) => refsOf(w).includes("SH2"));
const sh1Nodes = nodesOf(sh1);
const sh2Nodes = nodesOf(sh2);

const northmost = Math.max(...sh1Nodes.map((id) => points.get(id)[1]));

const sh1North = new Set(
  sh1Nodes.filter((id) => points.get(id)[1] > northmost - 300)
);

const sh1Airport = new Set(
  sh1Nodes.filter((id) => distance(points.get(id), AIRPORT) < 150)
);

const furthest = Math.max(
  ...sh2Nodes.map((id) => distance(points.get(id), NGAURANGA))
);

const sh2Far = new Set(
  sh2Nodes.filter((id) => distance(points.get(id), NGAURANGA) > furthest - 300)
);

const sh1Set = new Set(sh1Nodes);
const sh2Meets = new Set(sh2Nodes.filter((id) => sh1Set.has(id)));

// SH58 over Haywards Hill, from SH2 at Haywards to SH59 at Paremata; SH59,
// the old SH1, from where it leaves Transmission Gully at Linden north
// through Porirua and Paremata to the terrain's edge.
const gapWays = allWays.filter(
  (w) =>
    !w.tags.ref && (w.tags.highway === "trunk" || w.tags.highway === "primary")
);

/** Gaps are filled only where the highway's own ways don't go. */
const GAP_COST = 4;
const gapCost = (w) => (w.tags.ref ? 1 : GAP_COST);

const sh58 = highwayWays.filter((w) => refsOf(w).includes("SH58"));
const sh59 = highwayWays.filter((w) => refsOf(w).includes("SH59"));
const sh58Nodes = nodesOf(sh58);
const sh59Nodes = nodesOf(sh59);

/** `nodes` toward the furthest any goes along `axis` (0 east, 1 north), `sign` ways. */
const endOf = (nodes, axis, sign) => {
  const most = Math.max(...nodes.map((id) => sign * points.get(id)[axis]));

  return towardEnd(nodes, (id) => most - sign * points.get(id)[axis]);
};

/**
 * Within 300 m of an end, by how far short of it, m, costing this many
 * times that: more than a gap costs to cross, so a road's carried through
 * an unnamed roundabout at its end rather than stopping short of it.
 */
const SHORT_COST = 2 * GAP_COST;

const towardEnd = (nodes, short) =>
  new Map(
    nodes
      .map((id) => [id, short(id)])
      .filter(([, d]) => d < 300)
      .map(([id, d]) => [id, SHORT_COST * d])
  );

// Its southernmost, at the Haywards roundabout above SH2 (the hill bulges
// further east), and its westernmost, at Paremata.
const sh58East = endOf(sh58Nodes, 1, -1);
const sh58West = endOf(sh58Nodes, 0, -1);
const sh59North = endOf(sh59Nodes, 1, 1);
const sh59Leaves = new Set(sh59Nodes.filter((id) => sh1Set.has(id)));

const routes = {
  SH1S: { road: "SH1", steps: route(sh1, sh1North, sh1Airport) },
  SH1N: { road: "SH1", steps: route(sh1, sh1Airport, sh1North) },
  SH2S: { road: "SH2", steps: route(sh2, sh2Far, sh2Meets) },
  SH2N: { road: "SH2", steps: route(sh2, sh2Meets, sh2Far) },
  SH58W: {
    road: "SH58",
    steps: route([...sh58, ...gapWays], sh58East, sh58West, gapCost),
  },
  SH58E: {
    road: "SH58",
    steps: route([...sh58, ...gapWays], sh58West, sh58East, gapCost),
  },
  SH59S: {
    road: "SH59",
    steps: route([...sh59, ...gapWays], sh59North, sh59Leaves, gapCost),
  },
  SH59N: {
    road: "SH59",
    steps: route([...sh59, ...gapWays], sh59Leaves, sh59North, gapCost),
  },
};

// --- The Mungavin Interchange: a roundabout raised over SH59, and ramps. ---

/** The ways through each node. */
const byNode = new Map();

for (const w of allWays) {
  for (const id of w.nodes) {
    if (!byNode.has(id)) byNode.set(id, []);
    byNode.get(id).push(w);
  }
}

// The ring's one way round, clockwise as NZ drives them, as steps like a
// route's: from a point clear of the ramps and bridges, back to it. Cars
// that reach its end carry on at its start.
const ringWays = allWays.filter(
  (w) => w.tags.junction === "roundabout" && w.tags.name === RING
);

const rampWays = allWays.filter(
  (w) => w.tags.highway.endsWith("_link") && !ringWays.includes(w)
);

const ringNodes = new Set(ringWays.flatMap((w) => w.nodes));
const sh59Set = new Set(sh59Nodes);

/** A ramp's from its first node to its last, by the way each is drawn. */
function chainsBetween(starts, ends) {
  const chains = [];
  const from = new Map();

  for (const w of rampWays) {
    const nodes = onewayOf(w) < 0 ? [...w.nodes].reverse() : w.nodes;

    if (!from.has(nodes[0])) from.set(nodes[0], []);
    from.get(nodes[0]).push({ w, nodes });
  }

  const walk = (node, steps, seen) => {
    for (const { w, nodes } of from.get(node) ?? []) {
      if (seen.has(w)) continue;
      const next = [...steps];

      for (let k = 0; k < nodes.length - 1; k++) next.push([nodes[k], w]);
      const end = nodes[nodes.length - 1];

      if (ends.has(end)) chains.push([...next, [end, null]]);
      else if (next.length < 400) walk(end, next, new Set([...seen, w]));
    }
  };

  for (const start of starts) walk(start, [], new Set());

  return chains;
}

const interchange = {};

if (ringWays.length) {
  // Round the ring: each way leads into the one starting where it ends.
  const byFirst = new Map(ringWays.map((w) => [w.nodes[0], w]));
  const loop = [];

  for (let w = ringWays[0]; w && !loop.some(([, v]) => v === w);) {
    for (let k = 0; k < w.nodes.length - 1; k++) loop.push([w.nodes[k], w]);
    w = byFirst.get(w.nodes[w.nodes.length - 1]);
  }

  if (loop[0][0] !== byFirst.get(loop.at(-1)[1].nodes.at(-1))?.nodes[0]) {
    throw new Error(`${RING} isn't a closed ring`);
  }

  // Start halfway between its bridges, so their decks have ground either
  // side to be measured from (build_decks.py doesn't go round a loop).
  const avoid = loop.filter(([, w]) => isBridge(w));

  const clearance = ([node, w]) =>
    isBridge(w)
      ? -Infinity
      : Math.min(
          ...avoid.map(([m]) => distance(points.get(node), points.get(m)))
        );

  const start = loop.reduce(
    (best, step, k) => (clearance(step) > clearance(loop[best]) ? k : best),
    0
  );

  const ring = [...loop.slice(start), ...loop.slice(0, start)];
  interchange.MUNGAVIN = { road: RING, steps: [...ring, [ring[0][0], null]] };

  // Off SH59 onto the ring, and off the ring back onto SH59.
  const ramps = [
    ...chainsBetween(sh59Set, ringNodes).map((steps) => ["OFF", steps]),
    ...chainsBetween(ringNodes, sh59Set).map((steps) => ["ON", steps]),
  ];

  for (const [kind, steps] of ramps) {
    const [, n] = points.get(steps[0][0]);
    const [, nn] = points.get(steps.at(-1)[0]);
    // Named for which way the ramp heads: north or south.
    const way = nn > n ? "N" : "S";
    const name = `MUNGAVIN_${kind}_${way}`;

    if (interchange[name]) {
      console.warn(`${name}: a second ramp, left out`);
      continue;
    }

    interchange[name] = { road: RING, steps };
  }

  console.log(
    `${RING}: ring of ${ring.length} nodes, ramps ${Object.keys(interchange)
      .filter((k) => k !== "MUNGAVIN")
      .join(" ")}`
  );
}

Object.assign(routes, interchange);

/** Ways the interchange's ramps run on: one way, tagged so or not. */
const rampsOneWay = new Set(
  Object.entries(interchange)
    .filter(([name]) => name !== "MUNGAVIN")
    .flatMap(([, { steps }]) => steps.map(([, w]) => w).filter(Boolean))
);

// --- Each carriageway densified, with what the road's like along it. ---

/** This direction's lanes on `w`, travelling `forward` along it, and all. */
function lanesOf(w, forward) {
  const total = Math.max(Number.parseInt(w.tags.lanes) || 0, 1);

  if (onewayOf(w) !== 0 || rampsOneWay.has(w)) return [total, total];
  const f = Number.parseInt(w.tags["lanes:forward"]);
  const b = Number.parseInt(w.tags["lanes:backward"]);
  const ahead = forward ? f : b;

  if (ahead > 0) return [ahead, Math.max(total, f + (b || 0))];

  return [Math.max(Math.floor(total / 2), 1), Math.max(total, 2)];
}

const carriageways = {};

for (const [name, { road, steps }] of Object.entries(routes)) {
  const pts = [];
  /** Per segment (after each point): [lanes, total, flags, maxspeed]. */
  const attrs = [];

  for (let i = 0; i < steps.length - 1; i++) {
    const [a, w] = steps[i];
    const [b] = steps[i + 1];
    const ia = w.nodes.indexOf(a);
    const ib = w.nodes.indexOf(b);
    const forward = ib > ia;
    const [lanes, total] = lanesOf(w, forward);

    const flags =
      (isTunnel(w) ? TUNNEL : 0) |
      (isBridge(w) ? BRIDGE : 0) |
      (lanes < total ? TWO_WAY : 0);

    const maxspeed = Number.parseInt(w.tags.maxspeed) || 50;
    const pa = points.get(a);
    const pb = points.get(b);
    const step = flags & TUNNEL ? TUNNEL_STEP : STEP;
    const pieces = Math.max(Math.ceil(distance(pa, pb) / step), 1);

    for (let k = 0; k < pieces; k++) {
      pts.push({
        e: pa[0] + ((pb[0] - pa[0]) * k) / pieces,
        n: pa[1] + ((pb[1] - pa[1]) * k) / pieces,
        node: k === 0 ? a : null,
        way: w,
      });
      attrs.push([lanes, total, flags, maxspeed]);
    }
  }

  const [last] = steps[steps.length - 1];
  pts.push({ e: points.get(last)[0], n: points.get(last)[1], node: last });
  attrs.push(attrs[attrs.length - 1]);

  const s = [0];

  for (let i = 1; i < pts.length; i++) {
    s.push(
      s[i - 1] + Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n)
    );
  }

  carriageways[name] = { road, pts, attrs, s };
}

// --- Room between each highway's two directions. ---

// OSM draws a divided highway's carriageways as two lines, but not always
// as far apart as their lanes are wide: between Ngauranga and Thorndon
// SH1's are ~10 m apart with 3 lanes south and 4 north, which need 12.3,
// so the scene laid the north side's lanes over the south side's third.
// Where the lanes either side would come closer than MEDIAN, each line's
// moved out by half of what's missing, tapered in and out along the road.

/** Between the lanes of a highway's two directions, at least, m. */
const MEDIAN = 1;

/** The other direction's line within this, m, is the other carriageway. */
const OPPOSITE_WITHIN = 25;

/** Closer than this, m, it's the same road (a two-way one), not the other. */
const SAME_LINE = 2;

/** Pointing this nearly the other way (cosine), it's running opposite. */
const OPPOSITE = -0.8;

/**
 * Sideways per metre along that a move's eased in and out by: 1 m over 20.
 * Where the road turns two-way, both directions share one line, which
 * doesn't move, so a move's eased out before it at the same rate.
 */
const TAPER = 0.05;

const PAIRS = [
  ["SH1S", "SH1N"],
  ["SH2S", "SH2N"],
  ["SH58W", "SH58E"],
  ["SH59S", "SH59N"],
];

/** Lanes' width at a segment's attrs, as the scene has it. */
const laneWidthOf = (attrs) => (attrs[3] > 50 ? LANE : TOWN_LANE);

/** Unit vectors along each point of `pts`, and to its right. */
function frames(pts) {
  return pts.map((_, i) => {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, pts.length - 1)];
    const length = Math.hypot(b.e - a.e, b.n - a.n) || 1;
    const along = [(b.e - a.e) / length, (b.n - a.n) / length];

    return { along, right: [along[1], -along[0]] };
  });
}

/** Segments of `cw` by 50 m squares, for the nearest one to a place. */
function segmentGrid(cw) {
  const grid = new Map();

  for (let j = 0; j < cw.pts.length - 1; j++) {
    const a = cw.pts[j];
    const b = cw.pts[j + 1];

    for (const p of [a, b]) {
      const key = `${Math.floor(p.e / 50)},${Math.floor(p.n / 50)}`;

      if (!grid.has(key)) grid.set(key, new Set());
      grid.get(key).add(j);
    }
  }

  return grid;
}

/** Per point of `own`, how far right to move it from `other`, m. */
function pushesFrom(own, other) {
  const ownFrames = frames(own.pts);
  const grid = segmentGrid(other);

  return own.pts.map((p, i) => {
    const attrs = own.attrs[Math.min(i, own.attrs.length - 1)];

    if (attrs[2] & TWO_WAY) return 0;

    const { along, right } = ownFrames[i];
    const cx = Math.floor(p.e / 50);
    const cy = Math.floor(p.n / 50);
    let best = null;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          const a = other.pts[j];
          const b = other.pts[j + 1];
          const de = b.e - a.e;
          const dn = b.n - a.n;
          const ll = de * de + dn * dn || 1e-9;
          const length = Math.sqrt(ll);

          if ((along[0] * de + along[1] * dn) / length > OPPOSITE) continue;

          if (other.attrs[j][2] & TWO_WAY) continue;

          const t = Math.min(
            Math.max(((p.e - a.e) * de + (p.n - a.n) * dn) / ll, 0),
            1
          );

          const off = [a.e + de * t - p.e, a.n + dn * t - p.n];
          const d = Math.hypot(off[0], off[1]);

          if (!best || d < best.d) best = { d, off, j };
        }
      }
    }

    if (!best || best.d < SAME_LINE || best.d > OPPOSITE_WITHIN) return 0;

    const theirs = other.attrs[best.j];

    const need =
      (attrs[0] * laneWidthOf(attrs) + theirs[0] * laneWidthOf(theirs)) / 2 +
      MEDIAN;

    const lateral = best.off[0] * right[0] + best.off[1] * right[1];
    const missing = need - Math.abs(lateral);

    return missing > 0 ? (-Math.sign(lateral) * missing) / 2 : 0;
  });
}

/**
 * `pushes` held where they're needed, tapering off either side, and down to
 * nothing at a point on a two-way road (`shared`).
 */
function eased(pushes, s, shared) {
  const reach = Math.max(...pushes.map(Math.abs)) / TAPER;

  // How far along to the nearest shared point, either way.
  const toShared = s.map(() => Infinity);
  let last = -Infinity;

  for (let i = 0; i < s.length; i++) {
    if (shared[i]) last = s[i];
    toShared[i] = s[i] - last;
  }

  last = Infinity;

  for (let i = s.length - 1; i >= 0; i--) {
    if (shared[i]) last = s[i];
    toShared[i] = Math.min(toShared[i], last - s[i]);
  }

  return pushes.map((_, i) => {
    let most = 0;
    let sign = 0;

    for (let k = i; k >= 0 && s[i] - s[k] < reach; k--) {
      const v = Math.abs(pushes[k]) - TAPER * (s[i] - s[k]);

      if (v > most) [most, sign] = [v, Math.sign(pushes[k])];
    }

    for (let k = i + 1; k < pushes.length && s[k] - s[i] < reach; k++) {
      const v = Math.abs(pushes[k]) - TAPER * (s[k] - s[i]);

      if (v > most) [most, sign] = [v, Math.sign(pushes[k])];
    }

    return sign * Math.min(most, TAPER * toShared[i]);
  });
}

/** Per point of `cw`, whether it's on a two-way stretch, at either side. */
const sharedOf = (cw) =>
  cw.pts.map(
    (_, i) =>
      (cw.attrs[i][2] & TWO_WAY) !== 0 ||
      (i > 0 && (cw.attrs[i - 1][2] & TWO_WAY) !== 0)
  );

const movesOf = (own, other) =>
  eased(pushesFrom(own, other), own.s, sharedOf(own));

{
  // Every move's measured on the lines as OSM has them, then made.
  const moves = PAIRS.flatMap(([a, b]) => [
    [a, movesOf(carriageways[a], carriageways[b])],
    [b, movesOf(carriageways[b], carriageways[a])],
  ]);

  for (const [name, shifts] of moves) {
    const cw = carriageways[name];
    const { pts, s } = cw;
    const rights = frames(pts).map(({ right }) => right);

    pts.forEach((p, i) => {
      p.e += rights[i][0] * shifts[i];
      p.n += rights[i][1] * shifts[i];
    });

    for (let i = 1; i < pts.length; i++) {
      s[i] =
        s[i - 1] + Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n);
    }

    const moved = shifts.filter((v) => Math.abs(v) > 0.05);

    if (moved.length) {
      const most = Math.max(...moved.map(Math.abs));

      console.log(
        `${name}: ${moved.length} points moved apart from the other way, up to ${most.toFixed(1)} m`
      );
    }
  }
}

// --- Heights: the ground across the whole road, smoothed along it. ---

for (const cw of Object.values(carriageways)) {
  const { pts, attrs } = cw;

  const sampled = await Promise.all(
    pts.map(async (p, i) => {
      const a = pts[Math.max(i - 1, 0)];
      const b = pts[Math.min(i + 1, pts.length - 1)];
      const length = Math.hypot(b.e - a.e, b.n - a.n) || 1;
      const across = [-(b.n - a.n) / length, (b.e - a.e) / length];
      // Across the whole road, both ways, so a two-way road's halves agree.
      const [, total, , maxspeed] = attrs[i];
      const width = total * (maxspeed > 50 ? LANE : TOWN_LANE);

      const heights = await Promise.all(
        [-2, -1, 0, 1, 2].map((k) =>
          groundHeight(
            p.e + across[0] * k * width * SAMPLE_SPREAD,
            p.n + across[1] * k * width * SAMPLE_SPREAD
          )
        )
      );

      const known = heights
        .filter((h) => h !== undefined)
        .sort((x, y) => x - y);

      return known.length
        ? Math.max(known[Math.floor(known.length / 2)], 0)
        : 0;
    })
  );

  // Off the ground: in a tunnel or on a bridge, on either side of a point.
  const lifted = pts.map(
    (_, i) =>
      i > 0 &&
      i < pts.length - 1 &&
      (attrs[i - 1][2] & (TUNNEL | BRIDGE)) !== 0 &&
      (attrs[i][2] & (TUNNEL | BRIDGE)) !== 0
  );

  let heights = [...sampled];

  for (let round = 0; round < SMOOTHING; round++) {
    heights = heights.map((h, i) => {
      if (lifted[i]) return h;
      let sum = sampled[i];
      let count = 1;

      for (const j of [i - 1, i + 1]) {
        if (j >= 0 && j < pts.length && !lifted[j]) {
          sum += heights[j];
          count++;
        }
      }

      return sum / count;
    });
  }

  // Straight across each structure, by distance from its ends.
  for (let i = 0; i < pts.length; i++) {
    if (!lifted[i]) continue;
    const start = i - 1;
    let end = i;

    while (end < pts.length - 1 && lifted[end]) end++;

    for (let k = start + 1; k < end; k++) {
      const t = (cw.s[k] - cw.s[start]) / (cw.s[end] - cw.s[start]);
      heights[k] = heights[start] + (heights[end] - heights[start]) * t;
    }

    i = end;
  }

  cw.heights = heights;
}

// --- Junctions: where other roads meet a carriageway. ---

for (const cw of Object.values(carriageways)) {
  const junctions = [];
  cw.pts.forEach((p, i) => {
    if (p.node === null || i === 0 || i === cw.pts.length - 1) return;
    const own = new Set([cw.pts[i - 1].way, p.way]);
    let kind = 0;

    for (const w of byNode.get(p.node) ?? []) {
      if (own.has(w) || !ROADS.has(w.tags.highway)) continue;
      // The same road's other carriageway isn't a way on or off it.
      const sameRoad = refsOf(w).includes(cw.road);

      if (sameRoad && !w.tags.highway.endsWith("_link")) continue;
      const at = w.nodes.indexOf(p.node);
      const way = onewayOf(w);
      const first = at === 0;
      const last = at === w.nodes.length - 1;

      if (way === 0 || (!first && !last)) kind |= JOINS | LEAVES;
      else if ((way === 1) === first) kind |= LEAVES;
      else kind |= JOINS;
    }

    if (kind) junctions.push([Math.round(cw.s[i]), kind]);
  });
  cw.junctions = junctions;
}

// --- NZTA's legs and links, placed along the carriageways. ---

const projectOnto = (cw, [e, n]) => {
  let best = { s: 0, distance: Infinity };

  for (let i = 0; i < cw.pts.length - 1; i++) {
    const a = cw.pts[i];
    const b = cw.pts[i + 1];
    const de = b.e - a.e;
    const dn = b.n - a.n;
    const ll = de * de + dn * dn || 1e-9;
    const t = Math.min(Math.max(((e - a.e) * de + (n - a.n) * dn) / ll, 0), 1);
    const d = Math.hypot(a.e + de * t - e, a.n + dn * t - n);

    if (d < best.distance) {
      best = { s: cw.s[i] + (cw.s[i + 1] - cw.s[i]) * t, distance: d };
    }
  }

  return best;
};

// I is the way a highway's route positions increase: south on SH1, SH2 and
// SH59 (which start in the north), west on SH58 (from SH2).
const directionOf = {
  SH1: { I: "SH1S", D: "SH1N" },
  SH2: { I: "SH2S", D: "SH2N" },
  SH58: { I: "SH58W", D: "SH58E" },
  SH59: { I: "SH59S", D: "SH59N" },
};

const parseLine = (wkt) =>
  wkt
    .replace(/^[A-Z]+\s*\(+|\)+$/g, "")
    .split(/\)?\s*,\s*\(?/)
    .map((p) => p.trim().split(/\s+/).map(Number))
    .map(([lon, lat]) => toNztm(lat, lon));

/** As lib/nzta.ts keys them: lengths come as numbers or strings. */
const linkKey = (k) => `${k.linkName}|${Number(k.linkLength)}`;

/** A leg's links, with their lengths as numbers, km. */
const linksOf = (leg) =>
  [].concat(leg.lengths ?? []).map((k) => ({
    ...k,
    linkLength: Number(k.linkLength),
    totalLength: Number(k.totalLength),
  }));

const legKey = (road, leg) => `${road} ${leg.direction} ${leg.sequenceNumber}`;

const linkKeys = [];
const linkIndex = new Map();

const keyIndex = (key) => {
  if (!linkIndex.has(key)) {
    linkIndex.set(key, linkKeys.length);
    linkKeys.push(key);
  }

  return linkIndex.get(key);
};

for (const cw of Object.values(carriageways)) {
  cw.links = [];
  cw.legs = [];
}

const placedOn = (cw, key) => cw.links.filter(([, , k]) => linkKeys[k] === key);

/** After each link in NZTA's loops, the next; and every link, by key. */
const next = new Map();
const known = new Map();
const legKeys = [];

for (const journey of [].concat(nzta.response.journey)) {
  const road = journey.name;

  if (!directionOf[road]) continue;
  const legs = [].concat(journey.legs ?? []);

  for (const leg of legs) {
    const cw = carriageways[directionOf[road][leg.direction]];
    const links = linksOf(leg);
    links.forEach((k, i) => {
      known.set(linkKey(k), k);

      if (i > 0) next.set(linkKey(links[i - 1]), k);
    });

    const line = parseLine(leg.geometry);
    const a = projectOnto(cw, line[0]);
    const b = projectOnto(cw, line[line.length - 1]);

    // The airport's end of SH1 is 130 m off OSM's.
    if (a.distance > 150 || b.distance > 150) continue;
    const [s0, s1] = a.s < b.s ? [a.s, b.s] : [b.s, a.s];

    if (s1 - s0 < 50) continue;
    cw.legs.push([Math.round(s0), Math.round(s1), legKeys.length]);
    legKeys.push(legKey(road, leg));

    // Links listed in the leg, if they're the leg's own: their lengths add
    // up to it, or fall short where the leg runs off NZTA's network.
    const sum = links.reduce((t, k) => t + k.totalLength, 0);
    const legLength = Number(leg.totalLength);

    if (!links.length || sum > legLength * 1.04) continue;
    const scale = (s1 - s0) / (legLength * 1000);

    // Short, they're at the end that runs on into the next leg.
    const following = legs.find(
      (l) =>
        l.direction === leg.direction &&
        l.sequenceNumber === leg.sequenceNumber + 1
    );

    const runsOn =
      following &&
      linkKey(linksOf(following)[0] ?? {}) === linkKey(links[links.length - 1]);

    let at = s0 + (runsOn ? (legLength - sum) * 1000 * scale : 0);

    for (const k of links) {
      const length = k.totalLength * 1000 * scale;
      cw.links.push([
        Math.round(at),
        Math.round(at + length),
        keyIndex(linkKey(k)),
      ]);
      at += length;
    }
  }
}

for (const chain of CHAINS) {
  const cw = carriageways[chain.carriageway];
  const run = [];
  let link = [...known.values()].find((k) => k.linkName.startsWith(chain.from));

  while (link) {
    run.push(link);

    if (link.linkName.startsWith(chain.to)) break;
    link = next.get(linkKey(link));

    if (run.length > 500) throw new Error(`chain ${chain.from} loops`);
  }

  if (!link) throw new Error(`chain ${chain.from} never reaches ${chain.to}`);

  // Anchors: links placed already. Between them, the rest by length.
  const anchors = run.map((k) => {
    const spans = placedOn(cw, linkKey(k));

    return spans.length
      ? [
          Math.min(...spans.map(([a]) => a)),
          Math.max(...spans.map(([, b]) => b)),
        ]
      : null;
  });

  const startAt = anchors[0] ? null : 0;
  const endAt = chain.end ? projectOnto(cw, chain.end).s : null;
  let i = 0;

  while (i < run.length) {
    if (anchors[i]) {
      i++;
      continue;
    }

    let j = i;

    while (j < run.length && !anchors[j]) j++;
    const from = i > 0 ? anchors[i - 1][1] : startAt;
    const to = j < run.length ? anchors[j][0] : endAt;
    const length = run.slice(i, j).reduce((t, k) => t + k.linkLength * 1000, 0);
    let scale = 1;
    let at;

    if (from !== null && to !== null) {
      scale = (to - from) / length;
      at = from;
    } else if (from !== null) {
      at = from;
    } else {
      at = to - length;
    }

    if (scale < 0.75 || scale > 1.33) {
      console.warn(
        `${chain.carriageway}: links ${run[i].linkName} … ${run[j - 1].linkName} ` +
          `stretched ×${scale.toFixed(2)} to fit`
      );
    }

    for (let k = i; k < j; k++) {
      const l = run[k].linkLength * 1000 * scale;
      cw.links.push([
        Math.round(at),
        Math.round(at + l),
        keyIndex(linkKey(run[k])),
      ]);
      at += l;
    }

    i = j;
  }
}

// --- Where carriageways meet: SH2 into SH1 and out of it at Ngauranga. ---

const meets = {};

for (const [name, cw] of Object.entries(carriageways)) {
  if (interchange[name]) continue;
  const first = cw.pts[0];
  const last = cw.pts[cw.pts.length - 1];

  for (const [other, ocw] of Object.entries(carriageways)) {
    if (other === name || ocw.road === cw.road || interchange[other]) continue;
    const into = projectOnto(ocw, [last.e, last.n]);

    if (into.distance < 5 && into.s > 1) {
      meets[name] = { ...meets[name], into: [other, Math.round(into.s)] };
    }

    const out = projectOnto(ocw, [first.e, first.n]);

    if (out.distance < 5 && out.s < ocw.s[ocw.s.length - 1] - 1) {
      meets[name] = { ...meets[name], from: [other, Math.round(out.s)] };
    }
  }
}

// The interchange: the ring runs on into itself; each ramp leaves the
// carriageway its first point's on and runs into the one its last is on.
// The ramps' ends are nodes the roads share, but SH59's lines may have
// been moved apart a little for the median since.
const RAMP_MEETS = 8;

if (interchange.MUNGAVIN) {
  meets.MUNGAVIN = { into: ["MUNGAVIN", 0] };

  const nearest = (names, p) =>
    names
      .map((other) => [other, projectOnto(carriageways[other], [p.e, p.n])])
      .sort((a, b) => a[1].distance - b[1].distance)[0];

  for (const name of Object.keys(interchange)) {
    if (name === "MUNGAVIN") continue;
    const { pts } = carriageways[name];
    const off = name.includes("_OFF_");
    const highway = ["SH59N", "SH59S"];
    const [fromName, from] = nearest(off ? highway : ["MUNGAVIN"], pts[0]);
    const [intoName, into] = nearest(off ? ["MUNGAVIN"] : highway, pts.at(-1));

    if (from.distance > RAMP_MEETS || into.distance > RAMP_MEETS) {
      throw new Error(
        `${name} doesn't meet ${fromName} (${from.distance.toFixed(1)} m) ` +
          `and ${intoName} (${into.distance.toFixed(1)} m)`
      );
    }

    meets[name] = {
      from: [fromName, Math.round(from.s)],
      into: [intoName, Math.round(into.s)],
    };
  }
}

// --- Out. ---

const round = (x) => Math.round(x * 10) / 10;

const roads = {
  // Generated by scripts/traffic/build_roads.mjs. Roads © OpenStreetMap
  // contributors (ODbL); links from NZTA (CC BY 4.0). NZTM2000 metres;
  // heights are bare-earth ground, before the terrain's vertical scale.
  flags: { tunnel: TUNNEL, bridge: BRIDGE, twoWay: TWO_WAY },
  junction: { joins: JOINS, leaves: LEAVES },
  /** "name|length" of each NZTA link, as the API gives them. */
  links: linkKeys,
  /** "road direction sequence" of each NZTA leg. */
  legs: legKeys,
  carriageways: Object.fromEntries(
    Object.entries(carriageways).map(([name, cw]) => {
      // Spans: from this point on, [point, lanes, all lanes, flags, limit].
      const spans = [];
      cw.attrs.forEach((a, i) => {
        const prev = spans[spans.length - 1];

        if (
          i < cw.attrs.length - 1 &&
          (!prev || a.some((v, k) => v !== prev[k + 1]))
        ) {
          spans.push([i, ...a]);
        }
      });

      return [
        name,
        {
          road: cw.road,
          /** easting, northing, height, … */
          points: cw.pts.flatMap((p, i) => [
            round(p.e),
            round(p.n),
            round(cw.heights[i]),
          ]),
          spans,
          /** [s, kind]: where other roads join and leave, m along. */
          junctions: cw.junctions,
          /** [s from, s to, link]. */
          links: cw.links.sort((a, b) => a[0] - b[0]),
          /** [s from, s to, leg]. */
          legs: cw.legs,
          ...meets[name],
        },
      ];
    })
  ),
};

await mkdir(OUT_DIR, { recursive: true });

const json = JSON.stringify(roads);

await writeFile(path.join(OUT_DIR, "roads.json"), json);

for (const [name, cw] of Object.entries(carriageways)) {
  const length = cw.s[cw.s.length - 1];

  const covered = (spans) => {
    const sorted = spans.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
    let total = 0;
    let reach = -Infinity;

    for (const [a, b] of sorted) {
      total += Math.max(0, b - Math.max(a, reach));
      reach = Math.max(reach, b);
    }

    return total;
  };

  console.log(
    `${name}: ${(length / 1000).toFixed(1)} km, ${cw.pts.length} points, ` +
      `${cw.junctions.length} junctions; links ${cw.links.length} over ` +
      `${(covered(cw.links) / 1000).toFixed(1)} km, legs ${cw.legs.length} over ` +
      `${(covered(cw.legs) / 1000).toFixed(1)} km` +
      (meets[name] ? ` ${JSON.stringify(meets[name])}` : "")
  );
}

console.log(`${(json.length / 1024).toFixed(0)} KB`);
