// Builds public/buses/routes.json: the way each of Metlink's bus routes goes
// around Wellington, along the roads, for the scene's buses to run along
// between their fixes without a road network.
//
//   node scripts/buses/build_routes.mjs [--gtfs cached.zip]
//
// The routes come from Metlink's GTFS timetable: its shapes, the roads each
// trip drives. Shapes share most of their points with others (variants of a
// route, and routes down the same streets), so the roads are kept once, as
// chains between where shapes join, part or end, and each shape is the
// chains it takes. Rebuild when a new timetable changes a route.
//
// Heights are read from the terrain tiles in public/terrain (so run this
// after build_tiles.py): bare earth, with dips under bridges filled and
// rises cut by limiting the grade, then smoothed. Through a road tunnel
// (public/tunnels/tunnels.json, so run it after build_tunnels.mjs too) a
// route keeps to the tunnel's floor, and to the middle of it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { strFromU8, unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { createGroundSampler, toNztm } from "../lib/geo.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const TERRAIN = path.join(ROOT, "public/terrain");
const TUNNELS = path.join(ROOT, "public/tunnels/tunnels.json");
const OUT_DIR = path.join(ROOT, "public/buses");

const GTFS = "https://static.opendata.metlink.org.nz/v1/gtfs/full.zip";

/** GTFS route types that are buses: plain, and Metlink's school buses. */
const BUS_TYPES = new Set(["3", "712"]);

/** Points are at most this far apart while heights are found, m. */
const STEP = 8;

/** Ground is sampled this far either side as well, and the middle kept. */
const SAMPLE_SPREAD = 2.5;

/**
 * Steepest grade a road is let climb or fall: steeper and it's the DEM
 * dropping under a bridge, or rising up a bank beside the road.
 */
const GRADE = 0.2;

/**
 * A road this near a tunnel's line, m, running this nearly the way it does
 * (as a cosine), goes through it: a street crossing over the hill doesn't.
 */
const IN_TUNNEL = 6;
const ALONG_TUNNEL = 0.8;

/**
 * Out from a portal, a road's brought onto the tunnel's line over this
 * far, m: a timetable's shape and the map's tunnel are a metre or three
 * apart, and a bus would come in through the wall.
 */
const APPROACH = 40;

/** Rounds of smoothing between neighbouring points. */
const SMOOTHING = 8;

/**
 * Drop points while a road stays within this of a straight line, m, with
 * heights counting for less: a metre or two up or down doesn't show.
 */
const SIMPLIFY = 1;
const SIMPLIFY_HEIGHT = 0.5;

/** A point this near a shape's step, m, is taken to be on it. */
const NODE_TOLERANCE = 0.5;

/** Grid cell for finding points near a step, m. */
const NODE_CELL = 20;

/** Shorter than this on the map, m, and a shape isn't worth keeping. */
const SHORTEST = 200;

async function loadGtfs() {
  const cached = process.argv.indexOf("--gtfs");

  if (cached > 0) {
    return new Uint8Array(await readFile(process.argv[cached + 1]));
  }

  const response = await fetch(GTFS);

  if (!response.ok) throw new Error(`gtfs: ${response.status}`);

  return new Uint8Array(await response.arrayBuffer());
}

/** Rows of a CSV file as objects, by its header. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);

      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }

  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  const keys = header.map((k) => k.replace(/^﻿/, ""));

  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]])));
}

const files = unzipSync(await loadGtfs(), {
  filter: ({ name }) =>
    ["routes.txt", "trips.txt", "shapes.txt"].includes(name),
});

const table = (name) => parseCsv(strFromU8(files[name]));

const routes = table("routes.txt").filter((r) => BUS_TYPES.has(r.route_type));
const busRoutes = new Set(routes.map((r) => r.route_id));
const trips = table("trips.txt").filter((t) => busRoutes.has(t.route_id));
const wanted = new Set(trips.map((t) => t.shape_id));

const { manifest, groundHeight } = await createGroundSampler(TERRAIN);
const half = manifest.rootSize / 2;

const onMap = ([e, n]) =>
  Math.abs(e - manifest.origin[0]) < half &&
  Math.abs(n - manifest.origin[1]) < half;

const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// --- Points, once each: shapes down the same road share them exactly. ---

/** NZTM easting and northing of each point. */
const nodes = [];
const nodeOf = new Map();

/** Each shape's points in order, by GTFS shape_id. */
const raw = new Map();

for (const p of table("shapes.txt")) {
  if (!wanted.has(p.shape_id)) continue;
  const key = `${p.shape_pt_lat},${p.shape_pt_lon}`;

  if (!nodeOf.has(key)) {
    nodeOf.set(key, nodes.length);
    nodes.push(toNztm(Number(p.shape_pt_lat), Number(p.shape_pt_lon)));
  }

  if (!raw.has(p.shape_id)) raw.set(p.shape_id, []);
  raw.get(p.shape_id).push([Number(p.shape_pt_sequence), nodeOf.get(key)]);
}

/** The longest stretch of a shape on the map, without repeated points. */
function onMapRun(sequence) {
  let best = [];
  let run = [];

  for (const i of [...sequence, -1]) {
    if (i >= 0 && onMap(nodes[i])) {
      if (run[run.length - 1] !== i) run.push(i);
      continue;
    }

    if (run.length > best.length) best = run;
    run = [];
  }

  return best;
}

const lengthOf = (run) =>
  run.slice(1).reduce((s, i, k) => s + distance(nodes[run[k]], nodes[i]), 0);

// Shapes down the same road don't always have all the same points: one
// skips a point the other has. Each step picks up any points lying on it,
// so both go the same way through them.
const grid = new Map();

const cellOf = (e, n) =>
  `${Math.floor(e / NODE_CELL)},${Math.floor(n / NODE_CELL)}`;

nodes.forEach(([e, n], i) => {
  const key = cellOf(e, n);

  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push(i);
});

/** A shape with the points along each of its steps put in. */
function noded(run) {
  const out = [run[0]];

  for (let k = 1; k < run.length; k++) {
    const [ae, an] = nodes[run[k - 1]];
    const [be, bn] = nodes[run[k]];
    const de = be - ae;
    const dn = bn - an;
    const length = Math.hypot(de, dn);
    const between = [];

    if (length > NODE_TOLERANCE) {
      const cells = new Set();
      const steps = Math.ceil(length / NODE_CELL) + 1;

      for (let s = 0; s <= steps; s++) {
        const e = ae + (de * s) / steps;
        const n = an + (dn * s) / steps;

        for (const oe of [-1, 0, 1]) {
          for (const on of [-1, 0, 1]) {
            cells.add(cellOf(e + oe * NODE_CELL, n + on * NODE_CELL));
          }
        }
      }

      for (const cell of cells) {
        for (const i of grid.get(cell) ?? []) {
          if (i === run[k - 1] || i === run[k]) continue;
          const [e, n] = nodes[i];
          const t = ((e - ae) * de + (n - an) * dn) / length ** 2;

          if (t <= 0 || t >= 1) continue;
          const off = Math.abs((e - ae) * dn - (n - an) * de) / length;

          if (off < NODE_TOLERANCE) between.push([t, i]);
        }
      }
    }

    between.sort((a, b) => a[0] - b[0]);

    for (const [, i] of between) out.push(i);
    out.push(run[k]);
  }

  return out;
}

/** Each kept shape's points, by GTFS shape_id. */
const sequences = new Map();
let dropped = 0;

for (const [id, points] of raw) {
  points.sort((a, b) => a[0] - b[0]);
  const run = onMapRun(noded(points.map(([, i]) => i)));

  if (lengthOf(run) < SHORTEST) dropped++;
  else sequences.set(id, run);
}

// --- Chains: the roads between where shapes join, part, end or turn. ---

const neighbours = nodes.map(() => new Set());
const junction = new Uint8Array(nodes.length);

for (const run of sequences.values()) {
  junction[run[0]] = junction[run[run.length - 1]] = 1;
  run.forEach((i, k) => {
    if (k > 0) neighbours[i].add(run[k - 1]);

    if (k < run.length - 1) neighbours[i].add(run[k + 1]);

    // Turning back on itself.
    if (k > 0 && run[k - 1] === run[k + 1]) junction[i] = 1;
  });
}

neighbours.forEach((n, i) => {
  if (n.size && n.size !== 2) junction[i] = 1;
});

/** Each chain's points, junction to junction. */
const chains = [];

/** Which chain the step from a to b is on, keyed `a,b`: [chain, forward]. */
const stepOf = new Map();

const walk = (from, next) => {
  const chain = [from, next];

  while (!junction[chain[chain.length - 1]]) {
    const [a, b] = chain.slice(-2);
    const [c] = [...neighbours[b]].filter((n) => n !== a);
    chain.push(c);
  }

  const id = chains.length;
  chains.push(chain);
  chain.slice(1).forEach((b, k) => {
    stepOf.set(`${chain[k]},${b}`, [id, true]);
    stepOf.set(`${b},${chain[k]}`, [id, false]);
  });
};

for (let i = 0; i < nodes.length; i++) {
  if (!junction[i]) continue;

  for (const n of neighbours[i]) if (!stepOf.has(`${i},${n}`)) walk(i, n);
}

// Rings with nothing joining them: start anywhere.
for (let i = 0; i < nodes.length; i++) {
  for (const n of neighbours[i]) {
    if (stepOf.has(`${i},${n}`)) continue;
    junction[i] = 1;
    walk(i, n);
  }
}

// --- Tunnels: a road through one keeps to its line, and its floor. ---

const tunnels = JSON.parse(await readFile(TUNNELS, "utf8")).tunnels.map(
  ({ points }) => {
    const line = [];

    for (let i = 0; i < points.length; i += 3) {
      line.push(points.slice(i, i + 3));
    }

    const along = [0];

    for (let i = 1; i < line.length; i++) {
      along.push(along[i - 1] + distance(line[i - 1], line[i]));
    }

    return { line, along, length: along[along.length - 1] };
  }
);

/**
 * Where the point `p` of a road is in a tunnel, or on its way into one,
 * given the ways the road runs there (unit vectors): how far to the right
 * of the tunnel's line, which way that is, how far out from the portal (0
 * inside), and the floor's height inside. Null if it's in neither.
 */
function tunnelAt(p, directions) {
  let best = null;

  for (const { line, along, length } of tunnels) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const l = distance(a, b);

      if (l < 1e-6) continue;
      const te = (b[0] - a[0]) / l;
      const tn = (b[1] - a[1]) / l;
      const s = (p[0] - a[0]) * te + (p[1] - a[1]) * tn;

      // The line runs straight on out of each portal.
      if (s < (i === 1 ? -APPROACH : 0)) continue;

      if (s > (i === line.length - 1 ? l + APPROACH : l)) continue;
      const lateral = (p[0] - a[0]) * tn - (p[1] - a[1]) * te;

      if (Math.abs(lateral) > IN_TUNNEL) continue;

      if (
        !directions.some(([e, n]) => Math.abs(e * te + n * tn) > ALONG_TUNNEL)
      )
        continue;

      if (best && Math.abs(lateral) >= Math.abs(best.lateral)) continue;
      const at = along[i - 1] + s;
      const out = Math.max(-at, at - length, 0);

      best = {
        lateral,
        right: [tn, -te],
        out,
        floor:
          out > 0
            ? null
            : a[2] + (b[2] - a[2]) * Math.min(Math.max(s / l, 0), 1),
      };
    }
  }

  return best;
}

/**
 * `p` on the line of the tunnel it's in, and brought over to it by degrees
 * on the way in; where it was, with no `tunnel`.
 */
function onLine(p, tunnel) {
  if (!tunnel) return p;
  const by = -tunnel.lateral * (1 - tunnel.out / APPROACH);

  return [p[0] + tunnel.right[0] * by, p[1] + tunnel.right[1] * by];
}

// The shapes' own points first, each by where it was, so every shape
// through one still shares it. (The points put between them are moved as
// heights are found, below: a shape may have none from portal to portal.)
{
  const mapped = nodes.map((p) => [...p]);

  mapped.forEach((p, i) => {
    const directions = [...neighbours[i]].flatMap((n) => {
      const l = distance(p, mapped[n]);

      return l > 1e-6
        ? [[(mapped[n][0] - p[0]) / l, (mapped[n][1] - p[1]) / l]]
        : [];
    });

    nodes[i] = onLine(p, tunnelAt(p, directions));
  });
}

/** A shape as the chains it takes, 1-based, negative where it goes back. */
function chainsOf(run) {
  const refs = [];

  for (let k = 0; k < run.length - 1; k++) {
    const [id, forward] = stepOf.get(`${run[k]},${run[k + 1]}`);
    const chain = chains[id];

    // Each chain's taken whole: a step from its start (or end, going back)
    // begins it.
    if (run[k] === (forward ? chain[0] : chain[chain.length - 1])) {
      refs.push(forward ? id + 1 : -(id + 1));
    }
  }

  return refs;
}

const median = (heights) => {
  const known = heights.filter((h) => h !== undefined).sort((x, y) => x - y);

  return known.length ? Math.max(known[Math.floor(known.length / 2)], 0) : 0;
};

/** Ground at a junction: shared by every chain there, so not across one. */
const junctionHeight = new Map();

async function heightAtJunction(i) {
  if (!junctionHeight.has(i)) {
    const [e, n] = nodes[i];
    const s = SAMPLE_SPREAD;
    junctionHeight.set(
      i,
      median(
        await Promise.all(
          [
            [0, 0],
            [s, 0],
            [-s, 0],
            [0, s],
            [0, -s],
          ].map(([de, dn]) => groundHeight(e + de, n + dn))
        )
      )
    );
  }

  return junctionHeight.get(i);
}

/** Points no more than STEP apart. */
function resample(points) {
  const out = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.ceil(distance(a, b) / STEP);

    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }

  return out;
}

/** Ground under each point between the ends, the middle of three across. */
async function sampleHeights(points, start, end) {
  return Promise.all(
    points.map(async ([e, n], i) => {
      if (i === 0) return start;

      if (i === points.length - 1) return end;
      const a = points[i - 1];
      const b = points[i + 1];
      const length = distance(a, b) || 1;
      const across = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];

      return median(
        await Promise.all(
          [-1, 0, 1].map((s) =>
            groundHeight(
              e + across[0] * s * SAMPLE_SPREAD,
              n + across[1] * s * SAMPLE_SPREAD
            )
          )
        )
      );
    })
  );
}

/**
 * Heights no steeper than GRADE between the ends, which stay put, as do
 * any that are `fixed` (a tunnel's floor): dips filled from either side
 * (bridges), then rises cut (banks), then smoothed.
 */
function limitGrade(points, sampled, fixed) {
  const h = [...sampled];
  const last = h.length - 1;
  const gaps = points.slice(1).map((p, i) => distance(points[i], p));

  const pass = (pick, sign) => {
    for (let i = 1; i < last; i++) {
      if (fixed[i]) continue;
      h[i] = pick(h[i], h[i - 1] + sign * GRADE * gaps[i - 1]);
    }

    for (let i = last - 1; i > 0; i--) {
      if (fixed[i]) continue;
      h[i] = pick(h[i], h[i + 1] + sign * GRADE * gaps[i]);
    }
  };

  pass(Math.max, -1);
  pass(Math.min, 1);
  let smoothed = h;

  for (let round = 0; round < SMOOTHING; round++) {
    smoothed = smoothed.map((x, i) =>
      i === 0 || i === last || fixed[i]
        ? x
        : (smoothed[i - 1] + 2 * x + smoothed[i + 1]) / 4
    );
  }

  return smoothed;
}

/** Douglas–Peucker: fewer points where the road runs straight. */
function simplify(points) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const scaled = points.map(([e, n, h]) => [e, n, h * SIMPLIFY_HEIGHT]);
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = scaled[a];
    const d = scaled[b].map((x, k) => x - pa[k]);
    const dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1e-9;
    let worst = 0;
    let at = -1;

    for (let i = a + 1; i < b; i++) {
      const v = scaled[i].map((x, k) => x - pa[k]);

      const t = Math.min(
        Math.max((v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / dd, 0),
        1
      );

      const off = Math.hypot(v[0] - d[0] * t, v[1] - d[1] * t, v[2] - d[2] * t);

      if (off > worst) {
        worst = off;
        at = i;
      }
    }

    if (worst > SIMPLIFY) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

// --- Shapes, once each however many trips or timetables share them. ---

const shapes = [];
const shapeOf = new Map();
const byChains = new Map();

for (const [id, run] of sequences) {
  const refs = chainsOf(run);
  const key = refs.join(",");

  if (!byChains.has(key)) {
    byChains.set(key, shapes.length);
    shapes.push(refs);
  }

  shapeOf.set(id, byChains.get(key));
}

// Chains numbered, and turned, in the order shapes first take them: a
// shape's chains then mostly count up one at a time, which packs small.
const renumbered = new Map();
const order = [];

for (const refs of shapes) {
  for (const ref of refs) {
    const id = Math.abs(ref) - 1;

    if (renumbered.has(id)) continue;
    renumbered.set(id, { id: order.length, flip: ref < 0 });
    order.push(ref < 0 ? [...chains[id]].reverse() : chains[id]);
  }
}

const renumber = (ref) => {
  const { id, flip } = renumbered.get(Math.abs(ref) - 1);

  return (id + 1) * Math.sign(ref) * (flip ? -1 : 1);
};

// --- Heights along each chain, then fewer points. ---

const roads = [];

/** Chains through each tunnel, for the tally. */
let tunnelled = 0;

for (const chain of order) {
  const mapped = resample(chain.map((i) => nodes[i]));

  const through = mapped.map((p, i) => {
    const a = mapped[Math.max(i - 1, 0)];
    const b = mapped[Math.min(i + 1, mapped.length - 1)];
    const l = distance(a, b) || 1;

    return tunnelAt(p, [[(b[0] - a[0]) / l, (b[1] - a[1]) / l]]);
  });

  const points = mapped.map((p, i) => onLine(p, through[i]));

  const sampled = await sampleHeights(
    points,
    await heightAtJunction(chain[0]),
    await heightAtJunction(chain[chain.length - 1])
  );

  // Through a tunnel, its floor: not the hill over it.
  const floors = through.map((tunnel) => tunnel?.floor ?? null);

  if (floors.some((floor) => floor !== null)) tunnelled++;

  const heights = limitGrade(
    points,
    sampled.map((h, i) => floors[i] ?? h),
    floors.map((floor) => floor !== null)
  );

  roads.push(simplify(points.map(([e, n], i) => [e, n, heights[i]])));
}

// In decimetres, each point after the first as the change from the one
// before; each chain's first from the first of the chain before.
let previous = [0, 0, 0];

const encoded = roads.map((points) => {
  const out = [];
  let last = previous;
  points.forEach((p, k) => {
    const q = p.map((x) => Math.round(x * 10));
    out.push(q[0] - last[0], q[1] - last[1], q[2] - last[2]);

    if (k === 0) previous = q;
    last = q;
  });

  return out;
});

/** Each shape's chains, each after the first as the change from the last. */
const encodedShapes = shapes.map((refs) =>
  refs.map(renumber).map((ref, k, all) => (k ? ref - all[k - 1] : ref))
);

// --- Routes: which shapes each one's trips take, each way, and what the
// front of the bus says on each. ---

const out = {};
const headsigns = [];
const headsignOf = new Map();

/** A headsign's place in `headsigns`, or -1 for none. */
const signed = (text) => {
  if (!text) return -1;

  if (!headsignOf.has(text)) {
    headsignOf.set(text, headsigns.length);
    headsigns.push(text);
  }

  return headsignOf.get(text);
};

/** The one counted most often in `counts`, a Map; undefined if it's empty. */
const commonest = (counts) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];

const count = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

for (const route of routes) {
  // Each way: its shapes, with how many trips show each headsign on each,
  // and over them all.
  const directions = [new Map(), new Map()];
  const overall = [new Map(), new Map()];

  for (const trip of trips) {
    if (trip.route_id !== route.route_id) continue;
    const shape = shapeOf.get(trip.shape_id);
    const direction = Number(trip.direction_id) ? 1 : 0;

    if (shape === undefined) continue;

    if (!directions[direction].has(shape)) {
      directions[direction].set(shape, new Map());
    }

    const headsign = trip.trip_headsign?.trim();

    if (headsign) {
      count(directions[direction].get(shape), headsign);
      count(overall[direction], headsign);
    }
  }

  if (directions.some((d) => d.size)) {
    out[route.route_id] = {
      name: route.route_short_name,
      directions: directions.map((d) => [...d.keys()]),
      headsigns: directions.map((d) =>
        [...d.values()].map((counts) => signed(commonest(counts)))
      ),
      usual: overall.map((counts) => signed(commonest(counts))),
    };
  }
}

const file = {
  // Generated by scripts/buses/build_routes.mjs from Metlink's GTFS
  // (opendata.metlink.org.nz). Chains are NZTM2000 decimetres: easting,
  // northing, and bare-earth height before the terrain's vertical scale,
  // each point after a chain's first as the change from the one before, and
  // its first from the first of the chain before.
  chains: encoded,
  /**
   * Chains taken in order, 1-based and negative for back along one; each
   * after the first as the change from the one before.
   */
  shapes: encodedShapes,
  /** What the fronts of buses say: trip_headsign, each once. */
  headsigns,
  /**
   * By GTFS route_id: its name, and its shapes each way (direction_id);
   * the headsign most trips show on each of those shapes, and on the route
   * that way whichever shape, as places in `headsigns` (-1 for none).
   */
  routes: out,
};

await mkdir(OUT_DIR, { recursive: true });

const json = JSON.stringify(file);

await writeFile(path.join(OUT_DIR, "routes.json"), json);

const pointCount = roads.reduce((sum, r) => sum + r.length, 0);

const km = roads.reduce(
  (sum, r) => sum + r.slice(1).reduce((s, p, k) => s + distance(r[k], p), 0),
  0
);

console.log(
  `${chains.length} chains (${(km / 1000).toFixed(0)} km, ${pointCount} points; ` +
    `${tunnelled} through ${tunnels.length} tunnels), ` +
    `${shapes.length} shapes (${raw.size} in the timetable, ${dropped} off ` +
    `the map), ${Object.keys(out).length} routes, ` +
    `${headsigns.length} headsigns; ` +
    `${(json.length / 1024).toFixed(0)} KB`
);
