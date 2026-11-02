// Builds public/roads/roads.json: State Highways 1 and 2 around Wellington
// as one-way carriageways for the scene's traffic to drive, with where
// NZTA's live speeds apply along each.
//
//   node scripts/traffic/build_roads.mjs [--osm cached.json] [--nzta cached.json]
//
// Road geometry, lanes and limits come from OpenStreetMap (© OpenStreetMap
// contributors, ODbL); speeds from NZTA's traffic API (CC BY 4.0), whose
// journeys are split into legs and legs into links, each with a speed.
// Links carry no geometry of their own, so each is placed by its length
// along its leg, and legs by their end points. Heights are read from the
// terrain tiles in public/terrain (so run this after build_tiles.py),
// smoothed along the road, and carried straight from end to end over
// bridges and through tunnels.

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
const SH = `["highway"]["ref"~"(^|;) *SH ?(1|2)($|;)"]`;
// The highways, and every road that meets them, for where traffic joins
// and leaves.
const QUERY = `[out:json][timeout:180];
way${SH}(${BBOX})->.sh;
node(w.sh)->.n;
way(bn.n)["highway"]->.touching;
(.sh; .touching;)->.ways;
.ways out body;
node(w.sh);
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
    return response.json();
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
  refsOf(w).some((r) => r === "SH1" || r === "SH2")
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
 */
function route(ways, sources, targets) {
  const out = new Map();
  for (const w of ways) {
    const way = onewayOf(w);
    for (let i = 0; i < w.nodes.length - 1; i++) {
      const [a, b] = [w.nodes[i], w.nodes[i + 1]];
      if (!points.has(a) || !points.has(b)) continue;
      if (!onMap(points.get(a)) || !onMap(points.get(b))) continue;
      const add = (from, to) => {
        if (!out.has(from)) out.set(from, []);
        out.get(from).push([to, w]);
      };
      if (way >= 0) add(a, b);
      if (way <= 0) add(b, a);
    }
  }
  const cost = new Map();
  /** How each node was reached: the node before, and the way between. */
  const previous = new Map();
  const open = new Heap();
  for (const s of sources) {
    cost.set(s, 0);
    open.push(0, s);
  }
  const done = new Set();
  while (open.size) {
    const [, node] = open.pop();
    if (done.has(node)) continue;
    done.add(node);
    if (targets.has(node)) {
      // Each step: a node, and the way on to the next.
      const steps = [[node, null]];
      for (let at = node; previous.has(at); ) {
        const [from, way] = previous.get(at);
        steps.unshift([from, way]);
        at = from;
      }
      return steps;
    }
    for (const [next, way] of out.get(node) ?? []) {
      const c = cost.get(node) + distance(points.get(node), points.get(next));
      if (c < (cost.get(next) ?? Infinity)) {
        cost.set(next, c);
        previous.set(next, [node, way]);
        open.push(c, next);
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
    for (let i = items.length - 1; i > 0; ) {
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
      for (let i = 0; ; ) {
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

const routes = {
  SH1S: { road: "SH1", steps: route(sh1, sh1North, sh1Airport) },
  SH1N: { road: "SH1", steps: route(sh1, sh1Airport, sh1North) },
  SH2S: { road: "SH2", steps: route(sh2, sh2Far, sh2Meets) },
  SH2N: { road: "SH2", steps: route(sh2, sh2Meets, sh2Far) },
};

// --- Each carriageway densified, with what the road's like along it. ---

const byNode = new Map();
for (const w of allWays) {
  for (const id of w.nodes) {
    if (!byNode.has(id)) byNode.set(id, []);
    byNode.get(id).push(w);
  }
}

/** This direction's lanes on `w`, travelling `forward` along it, and all. */
function lanesOf(w, forward) {
  const total = Math.max(Number.parseInt(w.tags.lanes) || 0, 1);
  if (onewayOf(w) !== 0) return [total, total];
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

const directionOf = {
  SH1: { I: "SH1S", D: "SH1N" },
  SH2: { I: "SH2S", D: "SH2N" },
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
  const first = cw.pts[0];
  const last = cw.pts[cw.pts.length - 1];
  for (const [other, ocw] of Object.entries(carriageways)) {
    if (other === name || ocw.road === cw.road) continue;
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
