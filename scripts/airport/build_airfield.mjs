// Builds Wellington Airport's airfield for the scene:
//
//   src/components/scene/airport/airfield.ts  the runway, its PAPIs and lights
//   public/airport/lines.png                  taxiway markings, 1 m texels
//   public/airport/ground.png                 paving and grass, 2 m texels
//
//   node scripts/airport/build_airfield.mjs [--osm cached.json]
//
// Geometry comes from OpenStreetMap (© OpenStreetMap contributors, ODbL).
// Lights are laid out to ICAO Annex 14 spacing along it, not surveyed. Ground
// heights are read from the terrain tiles in public/terrain, so run this after
// build_tiles.py.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { createGroundSampler, toNztm } from "../lib/geo.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const TERRAIN = path.join(ROOT, "public/terrain");
const OUT_TS = path.join(ROOT, "src/components/scene/airport/airfield.ts");
const OUT_DIR = path.join(ROOT, "public/airport");

const QUERY = `[out:json][timeout:60][bbox:-41.345,174.795,-41.31,174.82];
nwr["aeroway"];
out geom;`;

/** Taxiways aren't tagged with a width; WLG's are code C/D, about 23 m. */
const TAXIWAY_WIDTH = 23;
/** Texture extent beyond the aerodrome boundary, metres. */
const MARGIN = 16;
/** Metres per texel of the line and ground textures. */
const LINE_TEXEL = 1;
const GROUND_TEXEL = 2;
/** Encoded range of the line offsets and of the paving's signed distance. */
const LINE_RANGE = 4;
const PAVE_RANGE = 8;
/** Runway-holding bars run across the taxiway, this deep. */
const HOLDING_DEPTH = 1.2;

/** ICAO Annex 14 light spacing, metres. */
const EDGE_SPACING = 60;
const TAXI_EDGE_SPACING = 30;
const THRESHOLD_SPACING = 3;
const END_LIGHTS = 8;
/** PAPI boxes: 9 m apart; from the runway outward, these angles (degrees). */
const PAPI_SPACING = 9;
const PAPI_ANGLES = [3.5, 3 + 10 / 60, 2 + 50 / 60, 2.5];

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

const project = (geometry) => geometry.map(({ lat, lon }) => toNztm(lat, lon));

/** Joins member ways that share end points into rings. */
function stitch(ways) {
  const pending = ways.filter((w) => w.length >= 2);
  const rings = [];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  while (pending.length) {
    let ring = [...pending.pop()];
    while (!same(ring[0], ring.at(-1))) {
      const i = pending.findIndex(
        (w) =>
          same(w[0], ring.at(-1)) ||
          same(w.at(-1), ring.at(-1)) ||
          same(w.at(-1), ring[0]) ||
          same(w[0], ring[0])
      );
      if (i < 0) break; // Clipped or broken: filling closes it anyway.
      const [way] = pending.splice(i, 1);
      if (same(way[0], ring.at(-1))) ring = [...ring, ...way.slice(1)];
      else if (same(way.at(-1), ring.at(-1)))
        ring = [...ring, ...way.slice(0, -1).reverse()];
      else if (same(way.at(-1), ring[0])) ring = [...way.slice(0, -1), ...ring];
      else ring = [...way.slice(1).reverse(), ...ring];
    }
    rings.push(ring);
  }
  return rings;
}

/** Rings of an area: a closed way, or a multipolygon's members. */
function rings(element) {
  if (element.type === "way") return [project(element.geometry)];
  return stitch(
    element.members
      .filter((m) => m.type === "way" && m.geometry)
      .map((m) => project(m.geometry))
  );
}

// --- Sort the features. ---

const osm = await loadOsm();
const elements = osm.elements;
const tagged = (aeroway) =>
  elements.filter((e) => e.tags?.aeroway === aeroway);

const aerodrome = tagged("aerodrome").find((e) => e.tags.icao === "NZWN");
if (!aerodrome) throw new Error("no NZWN aerodrome");
const aerodromeRings = stitch(
  aerodrome.members
    .filter((m) => m.role === "outer" && m.geometry)
    .map((m) => project(m.geometry))
);

const runwayWays = tagged("runway").filter((e) => e.tags.ref === "16/34");
const stopways = tagged("stopway");
const width = Number(runwayWays[0].tags.width);

// The runway's axis, south pavement end to north, and distances along it.
const pavement = runwayWays.flatMap((w) => project(w.geometry));
const south = pavement.reduce((a, b) => (b[1] < a[1] ? b : a));
const north = pavement.reduce((a, b) => (b[1] > a[1] ? b : a));
const length = Math.hypot(north[0] - south[0], north[1] - south[1]);
const axis = [(north[0] - south[0]) / length, (north[1] - south[1]) / length];
const along = ([e, n]) => (e - south[0]) * axis[0] + (n - south[1]) * axis[1];
/** Positive to the east of the centreline. */
const across = ([e, n]) => (e - south[0]) * axis[1] - (n - south[1]) * axis[0];
const at = (a, c) => [
  south[0] + axis[0] * a + axis[1] * c,
  south[1] + axis[1] * a - axis[0] * c,
];

const stopwayAlong = stopways.flatMap((w) => project(w.geometry).map(along));
const stopway = [
  Math.max(0, -Math.min(...stopwayAlong)),
  Math.max(0, Math.max(...stopwayAlong) - length),
];

const thresholds = Object.fromEntries(
  tagged("threshold").map((t) => [t.tags.ref, along(toNztm(t.lat, t.lon))])
);
if (thresholds["34"] === undefined || thresholds["16"] === undefined) {
  throw new Error("missing a threshold");
}

// --- Texture grid over the aerodrome. ---

const all = aerodromeRings.flat();
const west = Math.floor(Math.min(...all.map((p) => p[0])) - MARGIN);
const southEdge = Math.floor(Math.min(...all.map((p) => p[1])) - MARGIN);
// Whole ground texels, so both textures span the same bounds.
const cols = Math.ceil(
  (Math.max(...all.map((p) => p[0])) + MARGIN - west) / GROUND_TEXEL
) * (GROUND_TEXEL / LINE_TEXEL);
const rows = Math.ceil(
  (Math.max(...all.map((p) => p[1])) + MARGIN - southEdge) / GROUND_TEXEL
) * (GROUND_TEXEL / LINE_TEXEL);
const northEdge = southEdge + rows * LINE_TEXEL;
const east = west + cols * LINE_TEXEL;

/** Centre of texel (i, j), row 0 at the north edge. */
const texel = (i, j) => [
  west + (i + 0.5) * LINE_TEXEL,
  northEdge - (j + 0.5) * LINE_TEXEL,
];

/** Even-odd fill of rings, sampled at texel centres. */
function fill(ringList, out) {
  const inside = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const n = northEdge - (j + 0.5) * LINE_TEXEL;
    const crossings = [];
    for (const ring of ringList) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        if (a[1] > n !== b[1] > n) {
          crossings.push(a[0] + ((n - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((crossings[k] - west) / LINE_TEXEL - 0.5));
      const i1 = Math.min(
        cols - 1,
        Math.floor((crossings[k + 1] - west) / LINE_TEXEL - 0.5)
      );
      for (let i = i0; i <= i1; i++) inside[j * cols + i] ^= 1;
    }
  }
  if (out) for (let k = 0; k < inside.length; k++) out[k] |= inside[k];
  return inside;
}

/**
 * Distance from each texel within `reach` of a segment to it, kept where
 * nearer than `distance` holds already; `nearest` gets the nearest point.
 */
function stamp(a, b, reach, distance, nearest) {
  const [x0, x1] = [Math.min(a[0], b[0]) - reach, Math.max(a[0], b[0]) + reach];
  const [y0, y1] = [Math.min(a[1], b[1]) - reach, Math.max(a[1], b[1]) + reach];
  const i0 = Math.max(0, Math.floor((x0 - west) / LINE_TEXEL));
  const i1 = Math.min(cols - 1, Math.ceil((x1 - west) / LINE_TEXEL));
  const j0 = Math.max(0, Math.floor((northEdge - y1) / LINE_TEXEL));
  const j1 = Math.min(rows - 1, Math.ceil((northEdge - y0) / LINE_TEXEL));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy || 1;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const [px, py] = texel(i, j);
      const t = Math.min(
        Math.max(((px - a[0]) * dx + (py - a[1]) * dy) / length2, 0),
        1
      );
      const qx = a[0] + t * dx;
      const qy = a[1] + t * dy;
      const d = Math.hypot(px - qx, py - qy);
      const k = j * cols + i;
      if (d < distance[k]) {
        distance[k] = d;
        if (nearest) {
          nearest[k * 2] = qx - px;
          nearest[k * 2 + 1] = qy - py;
        }
      }
    }
  }
}

const segments = (points) =>
  points.slice(1).map((p, k) => [points[k], p]);

// Taxiway centrelines, and the areas mapped as polygons.
const taxiways = tagged("taxiway");
const centrelines = taxiways
  .filter((w) => w.tags.area !== "yes")
  .map((w) => ({ way: w, points: project(w.geometry) }));
const paveRings = [
  ...tagged("apron").flatMap(rings),
  ...tagged("helipad").flatMap(rings),
  ...taxiways.filter((w) => w.tags.area === "yes").flatMap(rings),
];
const concreteRings = tagged("apron")
  .filter((e) => e.tags.surface === "concrete")
  .flatMap(rings);

const size = cols * rows;
const taxiDistance = new Float32Array(size).fill(Infinity);
const taxiNearest = new Float32Array(size * 2);
const halfWidth = TAXIWAY_WIDTH / 2;
for (const { points } of centrelines) {
  for (const [a, b] of segments(points)) {
    stamp(a, b, halfWidth + PAVE_RANGE, taxiDistance, taxiNearest);
  }
}

// Paving as a union of polygons and taxiway corridors: signed depth, inside
// positive.
const paveInside = new Uint8Array(size);
for (const ring of paveRings) fill([ring], paveInside);
const edgeDistance = new Float32Array(size).fill(Infinity);
for (const ring of paveRings) {
  for (const [a, b] of segments([...ring, ring[0]])) {
    stamp(a, b, PAVE_RANGE + 1, edgeDistance);
  }
}
const paveDepth = new Float32Array(size);
for (let k = 0; k < size; k++) {
  const polygon = paveInside[k]
    ? Math.min(edgeDistance[k], PAVE_RANGE)
    : -Math.min(edgeDistance[k], PAVE_RANGE);
  const corridor = halfWidth - taxiDistance[k];
  paveDepth[k] = Math.max(polygon, corridor);
}
const pavedAt = ([e, n]) => {
  const i = Math.floor((e - west) / LINE_TEXEL);
  const j = Math.floor((northEdge - n) / LINE_TEXEL);
  if (i < 0 || j < 0 || i >= cols || j >= rows) return -PAVE_RANGE;
  return paveDepth[j * cols + i];
};

// Runway-holding positions: a bar across the taxiway at each.
const nodeWays = new Map();
for (const { way, points } of centrelines) {
  way.nodes.forEach((id, k) => {
    if (!nodeWays.has(id)) nodeWays.set(id, { points, k });
  });
}
const holdingDistance = new Float32Array(size).fill(Infinity);
const holds = tagged("holding_position").filter((h) =>
  ["runway", "ILS"].includes(h.tags["holding_position:type"])
);
let holdingBars = 0;
for (const hold of holds) {
  const found = nodeWays.get(hold.id);
  if (!found) continue;
  const { points, k } = found;
  const a = points[Math.max(k - 1, 0)];
  const b = points[Math.min(k + 1, points.length - 1)];
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const normal = [-(b[1] - a[1]) / d, (b[0] - a[0]) / d];
  const centre = points[k];
  stamp(
    [centre[0] - normal[0] * halfWidth, centre[1] - normal[1] * halfWidth],
    [centre[0] + normal[0] * halfWidth, centre[1] + normal[1] * halfWidth],
    LINE_RANGE,
    holdingDistance
  );
  holdingBars++;
}

const aerodromeInside = fill(aerodromeRings);
const concreteInside = new Uint8Array(size);
for (const ring of concreteRings) fill([ring], concreteInside);

// --- Encode. ---

const byte = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 255);

const lines = Buffer.alloc(size * 3);
for (let k = 0; k < size; k++) {
  // Offset to the nearest centreline point in world x (east) and z (south).
  let x = taxiNearest[k * 2];
  let z = -taxiNearest[k * 2 + 1];
  const d = Math.hypot(x, z);
  if (!Number.isFinite(taxiDistance[k])) x = z = LINE_RANGE;
  else if (d > LINE_RANGE) {
    x *= LINE_RANGE / d;
    z *= LINE_RANGE / d;
  }
  lines[k * 3] = byte(0.5 + x / (2 * LINE_RANGE));
  lines[k * 3 + 1] = byte(0.5 + z / (2 * LINE_RANGE));
  lines[k * 3 + 2] = byte(holdingDistance[k] / LINE_RANGE);
}

const scale = GROUND_TEXEL / LINE_TEXEL;
const groundCols = cols / scale;
const groundRows = rows / scale;
const ground = Buffer.alloc(groundCols * groundRows * 3);
for (let j = 0; j < groundRows; j++) {
  for (let i = 0; i < groundCols; i++) {
    let depth = 0;
    let field = 0;
    let concrete = 0;
    for (let v = 0; v < scale; v++) {
      for (let u = 0; u < scale; u++) {
        const k = (j * scale + v) * cols + i * scale + u;
        depth += paveDepth[k];
        field += aerodromeInside[k];
        concrete += concreteInside[k];
      }
    }
    const n = scale * scale;
    const p = (j * groundCols + i) * 3;
    ground[p] = byte(0.5 + depth / n / (2 * PAVE_RANGE));
    ground[p + 1] = byte(field / n);
    ground[p + 2] = byte(concrete / n);
  }
}

await mkdir(OUT_DIR, { recursive: true });
const png = (data, width, height, file) =>
  sharp(data, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(path.join(OUT_DIR, file));
await png(lines, cols, rows, "lines.png");
await png(ground, groundCols, groundRows, "ground.png");

// --- Lights. ---

const { groundHeight: sampleGround } = await createGroundSampler(TERRAIN);
async function groundHeight([e, n]) {
  const height = await sampleGround(e, n);
  if (height === undefined) throw new Error(`no terrain under ${e}, ${n}`);
  return height;
}

/** Bearing, degrees clockwise from grid north, of a direction. */
const bearing = ([e, n]) => ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
const northward = bearing(axis);
const southward = (northward + 180) % 360;

const lights = { edge: [], threshold: [], end: [], taxiway: [], papi: [] };
const push = async (list, point, ...rest) =>
  list.push([...point, await groundHeight(point), ...rest]);

// Edge lights a metre off the pavement, both sides, end to end.
const edgeCount = Math.ceil(length / EDGE_SPACING);
for (let k = 0; k <= edgeCount; k++) {
  for (const side of [-1, 1]) {
    await push(lights.edge, at((k / edgeCount) * length, side * (width / 2 + 1)));
  }
}

// Thresholds, green toward the approach; runway ends, red back along it.
for (const [a, facing] of [
  [thresholds["34"], southward],
  [thresholds["16"], northward],
]) {
  const count = Math.round(width / THRESHOLD_SPACING);
  for (let k = 0; k < count; k++) {
    const c = -width / 2 + (k + 0.5) * (width / count);
    await push(lights.threshold, at(a, c), facing);
  }
}
for (const [a, facing] of [
  [0, northward],
  [length, southward],
]) {
  for (let k = 0; k < END_LIGHTS; k++) {
    const c = -width / 2 + 1.5 + (k * (width - 3)) / (END_LIGHTS - 1);
    await push(lights.end, at(a, c), facing);
  }
}

// PAPIs: each mapped node is the middle of a row of four boxes, square to
// the runway; the box nearest the runway is set highest.
for (const node of tagged("navigationaid").filter(
  (n) => n.tags.navigationaid === "papi"
)) {
  const point = toNztm(node.lat, node.lon);
  const a = along(point);
  const c = across(point);
  const serves =
    Math.abs(a - thresholds["34"]) < Math.abs(a - thresholds["16"])
      ? "34"
      : "16";
  const facing = serves === "34" ? southward : northward;
  const side = Math.sign(c);
  for (let k = 0; k < 4; k++) {
    const offset = (k - 1.5) * PAPI_SPACING;
    await push(lights.papi, at(a, c + side * offset), facing, PAPI_ANGLES[k]);
  }
}

// Taxiway edges, where they border grass rather than more paving, and clear
// of the runway.
const onRunway = (p) =>
  Math.abs(across(p)) < width / 2 + 10 &&
  along(p) > -stopway[0] - 10 &&
  along(p) < length + stopway[1] + 10;
const taxiLights = [];
for (const { points } of centrelines) {
  let carried = 0;
  for (const [a, b] of segments(points)) {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const normal = [-(b[1] - a[1]) / d, (b[0] - a[0]) / d];
    for (let s = carried; s < d; s += TAXI_EDGE_SPACING) {
      const t = s / d;
      const centre = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (const side of [-1, 1]) {
        const p = [
          centre[0] + normal[0] * side * (halfWidth + 1),
          centre[1] + normal[1] * side * (halfWidth + 1),
        ];
        if (pavedAt(p) > -0.5 || onRunway(p)) continue;
        if (taxiLights.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 12))
          continue;
        taxiLights.push(p);
      }
    }
    carried = (carried - d) % TAXI_EDGE_SPACING;
    if (carried < 0) carried += TAXI_EDGE_SPACING;
  }
}
for (const p of taxiLights) await push(lights.taxiway, p);

// --- Write. ---

const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);
const rowsOf = (list, format) =>
  list.map((entry) => `  [${format(entry).join(", ")}],`).join("\n");
const point = ([e, n, g]) => [f1(e), f1(n), f2(g)];

await writeFile(
  OUT_TS,
  `// Generated by scripts/airport/build_airfield.mjs. Do not edit.
//
// Wellington Airport's runway, taxiways and aprons from OpenStreetMap
// (© OpenStreetMap contributors, ODbL). Points are NZTM2000 metres; ground
// is the bare-earth DEM height, before the terrain's vertical scale. Lights
// follow ICAO Annex 14 spacing along the mapped runway, not a survey.

export type Light = [easting: number, northing: number, ground: number];
/** Bearing (degrees from grid north) the light shines toward. */
export type DirectedLight = [...Light, facing: number];
/** And the angle above the horizon (degrees) above which it shows white. */
export type PapiLight = [...DirectedLight, angle: number];

/** Runway 16/34: its south end and the direction to its north end. */
export const RUNWAY = {
  south: [${f1(south[0])}, ${f1(south[1])}] as [number, number],
  axis: [${axis[0].toFixed(6)}, ${axis[1].toFixed(6)}] as [number, number],
  length: ${f1(length)},
  width: ${width},
  /** Stopway beyond the south and north ends. */
  stopway: [${f1(stopway[0])}, ${f1(stopway[1])}] as [number, number],
  /** Displaced thresholds, metres along from the south end. */
  threshold34: ${f1(thresholds["34"])},
  threshold16: ${f1(thresholds["16"])},
};

/**
 * lines.png and ground.png cover these NZTM bounds [west, south, east,
 * north], row 0 at the north edge.
 *
 * lines.png, ${LINE_TEXEL} m texels: R, G the offset from the texel to the
 * nearest taxiway centreline in world x and z, 0.5 + offset / (2 *
 * lineRange); B the distance to a runway-holding bar / lineRange.
 *
 * ground.png, ${GROUND_TEXEL} m texels: R the paving's signed depth, 0.5 +
 * depth / (2 * paveRange), inside positive (taxiways and aprons; not the
 * runway); G within the aerodrome; B concrete.
 */
export const AIRFIELD_TEXTURES = {
  bounds: [${west}, ${southEdge}, ${east}, ${northEdge}] as [
    number,
    number,
    number,
    number,
  ],
  lineRange: ${LINE_RANGE},
  paveRange: ${PAVE_RANGE},
  holdingDepth: ${HOLDING_DEPTH},
};

/** Runway edge lights, white. */
export const EDGE_LIGHTS: Light[] = [
${rowsOf(lights.edge, point)}
];

/** Threshold lights, green, toward the approach. */
export const THRESHOLD_LIGHTS: DirectedLight[] = [
${rowsOf(lights.threshold, (l) => [...point(l), f1(l[3])])}
];

/** Runway end lights, red, back along the runway. */
export const END_LIGHTS: DirectedLight[] = [
${rowsOf(lights.end, (l) => [...point(l), f1(l[3])])}
];

/** PAPI boxes. */
export const PAPI_LIGHTS: PapiLight[] = [
${rowsOf(lights.papi, (l) => [...point(l), f1(l[3]), l[4].toFixed(3)])}
];

/** Taxiway edge lights. */
export const TAXIWAY_LIGHTS: Light[] = [
${rowsOf(lights.taxiway, point)}
];
`
);

console.log(
  `runway ${f1(length)} m, thresholds 34 at ${f1(thresholds["34"])}, 16 at ${f1(
    thresholds["16"]
  )}, stopways ${stopway.map(f1).join("/")}`
);
console.log(
  `textures ${cols}x${rows} (lines), ${groundCols}x${groundRows} (ground); ${holdingBars} holding bars`
);
console.log(
  Object.entries(lights)
    .map(([name, list]) => `${name}: ${list.length}`)
    .join(", ")
);
