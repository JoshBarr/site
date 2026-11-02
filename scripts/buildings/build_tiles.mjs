// Builds public/buildings: Wellington's buildings as low-poly tiles for the
// homepage scene, on the terrain's quadtree so they stream the same way.
//
//   node scripts/buildings/build_tiles.mjs
//
// Source: Wellington City Council's 3D building models, captured Jan-Mar 2022
// (© Wellington City Council and AAM Ltd, CC BY 4.0), read from the
// council's I3S scene services. Ground heights come from public/terrain, so
// run build_tiles.py first. Downloads are cached in .cache/buildings.
//
// Each building keeps its roof, simplified, and gets new walls dropped
// straight down from the roof's outline to below the ground. The source's
// walls (window reveals, ledges, balconies) are most of its triangles and
// none of its silhouette; rebuilt, they're two triangles per roof edge and
// exactly vertical.
//
// Output (public/buildings/):
//   manifest.json          levels, per-tile bounds, vertex encoding
//   {z}/{x}/{y}.bin        one tile: meshopt-compressed vertices and indices
//
// Levels are terrain quadtree levels: every building is in each level whose
// filter it passes, in the tile under its centre, so a tile's buildings are
// exactly its children's (less the ones too small to keep) and the client
// can swap between them. Every building is also a light, for night: a
// point, or a stack of them up a tall one. The ones a level leaves out are
// only that, so the city's glow doesn't end where the finest tiles do; the
// ones it draws hand over from their windows once those are too small to see.
//
// Tile file, little-endian: u32 magic "BLD3", vertexCount, indexCount,
// indexSize (2 or 4), vertexBytes, indexBytes, lightCount, lightBytes; the
// encoded vertex buffer, the encoded index buffer and the encoded lights,
// each padded to 4 bytes.
//
// Vertex: six u16, all unsigned and normalised:
//   x, z     world position across the tile's bounds (manifest)
//   rel      height above the building's ground, metres (encoding.rel)
//   delta    DEM height here less the building's ground (encoding.rel)
//   ground   DEM height under the building's centre (encoding.ground)
//   seed     random per building in the low 15 bits; the top bit marks a
//            building with no windows to light (see windowless)
// The terrain is drawn exaggerated, so the client places a vertex at
// ground * verticalScale + rel, and it's rel - delta * verticalScale above
// the drawn ground.
//
// Light: eight u16, unsigned:
//   x, z     the building's centre across the tile's bounds, normalised
//   ground   as for vertices (encoding.ground), normalised
//   height   the light's, above ground (encoding.rel), normalised
//   seed     as for vertices
//   wall     wall area it stands for, at the finest level, m²
//   top      roof height above ground (encoding.rel), normalised
//   drawn    1 if the tile draws the building too, else 0

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";
import draco3d from "draco3d";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { createGroundSampler, fromWebMercator, toNztm } from "../lib/geo.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const TERRAIN = path.join(ROOT, "public/terrain");
const OUT_DIR = path.join(ROOT, "public/buildings");
const CACHE_DIR = path.join(ROOT, ".cache/buildings");

const SERVICE_ROOT =
  "https://tiles.arcgis.com/tiles/CPYspmTk3abe6d7i/arcgis/rest/services";

/**
 * The city's wards. Lambton is the CBD, Thorndon, Te Aro, Kelburn, Oriental
 * Bay and Mt Vic; the rest are suburbs, which only show up close.
 */
const SERVICES = [
  { name: "Lambton_Ward_3D_Buildings_Untextured" },
  { name: "Northern_Ward_3D_Buildings_Untextured", suburban: true },
  { name: "Onslow_Western_Ward_3D_Buildings_Untextured", suburban: true },
  { name: "Eastern_Ward_3D_Buildings_Untextured", suburban: true },
  { name: "Southern_Ward_3D_Buildings_Untextured", suburban: true },
];

/**
 * Detail per level. `error` is the roof simplifier's tolerance in metres;
 * buildings with less roof than `minArea` m² are left out (the terrain
 * already shades footprints), as are roof islands under `islandArea`.
 * Suburban buildings need `suburbMinArea`: only the big ones (hospital,
 * malls, terminal) are drawn from afar.
 */
const LODS = [
  { level: 5, error: 4, minArea: 400, suburbMinArea: Infinity, islandArea: 60 },
  { level: 6, error: 2, minArea: 120, suburbMinArea: 1500, islandArea: 15 },
  { level: 7, error: 0.75, minArea: 0, suburbMinArea: 0, islandArea: 1.5 },
];

/** Steeper than this (|normal.z|) is wall, which gets rebuilt. */
const ROOF_MIN_NZ = 0.25;

/** Triangles this close to the building's base are its floor. */
const FLOOR_TOLERANCE = 0.3;

/** Walls reach this far below the lowest ground under the building. */
const WALL_SINK = 2;

/**
 * A wall is left out when there's roof this far past its edge, no more than
 * HIDDEN_STEP below it, at every probe HIDDEN_SPACING apart along it.
 */
const HIDDEN_PROBE = 0.03;
const HIDDEN_STEP = 0.05;
const HIDDEN_SPACING = 0.5;

/** Slack for the terrain's vertical exaggeration on sloping sites. */
const MAX_VERTICAL_SCALE = 1.3;

/**
 * Low and broad (stadium, port sheds, warehouses, big-box shops): blank
 * walls, so no lit windows at night. Under this height for its footprint's
 * width, with at least this much roof (m²).
 */
const WINDOWLESS_ASPECT = 0.3;
const WINDOWLESS_MIN_AREA = 1000;
const WINDOWLESS_BIT = 0x8000;

function windowless({ area, top, base }) {
  return (
    area >= WINDOWLESS_MIN_AREA &&
    top - base < WINDOWLESS_ASPECT * Math.sqrt(area)
  );
}

const LIGHT_BYTES = 16;

/**
 * A building's light sits halfway up it; a tall one gets one every this
 * many metres up instead, so it reads as tall from afar.
 */
const LIGHT_SPACING = 14;

/** A building as lights, sharing out its wall. */
function buildingLights(building, shift, drawn, toWorld) {
  const top = building.top + shift - building.ground;
  const count = Math.max(1, Math.round(top / LIGHT_SPACING));
  const world = toWorld(...building.centre);

  return Array.from({ length: count }, (_, i) => ({
    building,
    world,
    height: ((i + 0.5) / count) * top,
    wall: building.wall / count,
    top,
    drawn,
  }));
}

const ENCODING = {
  rel: { min: -100, range: 655.35 },
  ground: { min: -50, range: 6553.5 },
};

// --- Fetching ---

async function fetchCached(url, file) {
  if (existsSync(file)) return readFile(file);
  const response = await fetch(url);

  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  let body = Buffer.from(await response.arrayBuffer());

  // ArcGIS serves some resources gzipped without saying so.
  if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
  await writeFile(file, body);

  return body;
}

async function loadNodes(service) {
  const layerUrl = `${SERVICE_ROOT}/${service}/SceneServer/layers/0`;
  const dir = path.join(CACHE_DIR, service);
  await mkdir(dir, { recursive: true });
  const nodes = [];

  for (let page = 0; ; page++) {
    const body = await fetchCached(
      `${layerUrl}/nodepages/${page}`,
      path.join(dir, `nodepage-${page}.json`)
    ).catch(() => null);

    const parsed = body && JSON.parse(body);

    if (!parsed?.nodes) {
      // Past the last page; don't keep the error response.
      await rm(path.join(dir, `nodepage-${page}.json`), { force: true });
      break;
    }

    nodes.push(...parsed.nodes);
  }

  const leaves = nodes.filter((n) => !n.children?.length && n.mesh);

  return { layerUrl, dir, leaves };
}

async function inBatches(items, size, fn) {
  const results = [];

  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }

  return results;
}

// --- Decoding ---

const draco = await draco3d.createDecoderModule({});

/** Positions, per-vertex feature index, feature ids and triangles. */
function decodeDraco(buf) {
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  buffer.Init(
    new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    buf.byteLength
  );
  const mesh = new draco.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);

  if (!status.ok()) throw new Error(status.error_msg());

  const readFloats = (attr, components) => {
    const n = mesh.num_points() * components;
    const array = new draco.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attr, array);
    const out = new Float32Array(n);

    for (let i = 0; i < n; i++) out[i] = array.GetValue(i);
    draco.destroy(array);

    return out;
  };

  const position = readFloats(
    decoder.GetAttribute(mesh, decoder.GetAttributeId(mesh, draco.POSITION)),
    3
  );

  // The feature index is the generic attribute tagged "feature-index"; its
  // metadata also lists the features' ids.
  let feature = null;
  let featureIds = null;
  const querier = new draco.MetadataQuerier();

  for (let i = 0; i < mesh.num_attributes(); i++) {
    const attr = decoder.GetAttribute(mesh, i);

    if (attr.attribute_type() !== draco.GENERIC) continue;
    const metadata = decoder.GetAttributeMetadata(mesh, i);

    if (!metadata.ptr) continue;

    if (
      querier.GetStringEntry(metadata, "i3s-attribute-type") !== "feature-index"
    )
      continue;
    feature = readFloats(attr, 1);
    const ids = new draco.DracoInt32Array();

    if (querier.GetIntEntryArray(metadata, "i3s-feature-ids", ids)) {
      featureIds = Array.from({ length: ids.size() }, (_, k) =>
        ids.GetValue(k)
      );
    }

    draco.destroy(ids);
  }

  draco.destroy(querier);

  const faces = mesh.num_faces();
  const index = new Uint32Array(faces * 3);
  const face = new draco.DracoInt32Array();

  for (let f = 0; f < faces; f++) {
    decoder.GetFaceFromMesh(mesh, f, face);
    index[f * 3] = face.GetValue(0);
    index[f * 3 + 1] = face.GetValue(1);
    index[f * 3 + 2] = face.GetValue(2);
  }

  draco.destroy(face);
  draco.destroy(mesh);
  draco.destroy(decoder);
  draco.destroy(buffer);

  return { position, feature, featureIds, index };
}

/**
 * The leaf's buildings, as triangle soups in NZTM easting, northing and
 * height. I3S positions are offsets from the node's centre, here in Web
 * Mercator metres.
 */
function leafBuildings(node, buf) {
  const { position, feature, featureIds, index } = decodeDraco(buf);
  const [cx, cy, cz] = node.obb.center;
  const world = new Float64Array(position.length);

  for (let i = 0; i < position.length; i += 3) {
    const [lat, lon] = fromWebMercator(cx + position[i], cy + position[i + 1]);
    const [e, n] = toNztm(lat, lon);
    world[i] = e;
    world[i + 1] = n;
    world[i + 2] = cz + position[i + 2];
  }

  const byFeature = new Map();

  for (let t = 0; t < index.length; t += 3) {
    const f = feature ? Math.round(feature[index[t]]) : 0;
    let soup = byFeature.get(f);

    if (!soup) byFeature.set(f, (soup = []));

    for (let k = 0; k < 3; k++) {
      const v = index[t + k] * 3;
      soup.push(world[v], world[v + 1], world[v + 2]);
    }
  }

  return [...byFeature].map(([f, soup]) => ({
    id: featureIds?.[f] ?? node.mesh.geometry.resource * 65536 + f,
    soup,
  }));
}

// --- Geometry ---

/** Merges vertices within 1 cm and drops degenerate triangles. */
function weld(soup) {
  const ids = new Map();
  const positions = [];
  const index = [];

  for (let i = 0; i < soup.length; i += 9) {
    const tri = [0, 1, 2].map((k) => {
      const [e, n, h] = soup.slice(i + k * 3, i + k * 3 + 3);
      const key = `${Math.round(e * 100)},${Math.round(n * 100)},${Math.round(h * 100)}`;
      let id = ids.get(key);

      if (id === undefined) {
        id = positions.length / 3;
        ids.set(key, id);
        positions.push(e, n, h);
      }

      return id;
    });

    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) {
      index.push(...tri);
    }
  }

  return { positions: new Float64Array(positions), index };
}

function triangleNormal(p, a, b, c) {
  const ux = p[b * 3] - p[a * 3];
  const uy = p[b * 3 + 1] - p[a * 3 + 1];
  const uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3];
  const vy = p[c * 3 + 1] - p[a * 3 + 1];
  const vz = p[c * 3 + 2] - p[a * 3 + 2];

  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/**
 * Splits triangles into connected pieces (sharing vertices) and keeps the
 * ones with at least `minArea` m² of plan area.
 */
function dropSmallIslands(p, index, minArea) {
  const parent = new Map();

  const find = (v) => {
    while (parent.has(v) && parent.get(v) !== v) v = parent.get(v);

    return v;
  };

  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);

    if (!parent.has(ra)) parent.set(ra, ra);

    if (ra !== rb) parent.set(rb, ra);
  };

  for (let t = 0; t < index.length; t += 3) {
    union(index[t], index[t + 1]);
    union(index[t], index[t + 2]);
  }

  const area = new Map();

  for (let t = 0; t < index.length; t += 3) {
    const root = find(index[t]);

    const a =
      Math.abs(triangleNormal(p, index[t], index[t + 1], index[t + 2])[2]) / 2;

    area.set(root, (area.get(root) ?? 0) + a);
  }

  const kept = [];

  for (let t = 0; t < index.length; t += 3) {
    if (area.get(find(index[t])) >= minArea) {
      kept.push(index[t], index[t + 1], index[t + 2]);
    }
  }

  return kept;
}

/**
 * One building's roof (triangles facing up, wound counter-clockwise from
 * above) and stats, from its source triangles.
 */
function prepareBuilding({ id, soup }) {
  const { positions, index } = weld(soup);
  let base = Infinity;
  let top = -Infinity;

  for (let i = 2; i < positions.length; i += 3) {
    base = Math.min(base, positions[i]);
    top = Math.max(top, positions[i]);
  }

  const roof = [];

  for (let t = 0; t < index.length; t += 3) {
    let [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    const normal = triangleNormal(positions, a, b, c);
    const length = Math.hypot(...normal);

    if (length < 1e-6 || Math.abs(normal[2]) / length < ROOF_MIN_NZ) continue;

    const floor = [a, b, c].every(
      (v) => positions[v * 3 + 2] < base + FLOOR_TOLERANCE
    );

    if (floor) continue;

    // The source is double-sided, so its winding means nothing.
    if (normal[2] < 0) [b, c] = [c, b];
    roof.push(a, b, c);
  }

  if (!roof.length) return null;

  // Simplify in a local frame, where Float32 keeps millimetres.
  const [e0, n0, h0] = positions;
  const local = new Float32Array(positions.length);

  for (let i = 0; i < positions.length; i += 3) {
    local[i] = positions[i] - e0;
    local[i + 1] = positions[i + 1] - n0;
    local[i + 2] = positions[i + 2] - h0;
  }

  // Centre of the roof's plan area.
  let ce = 0;
  let cn = 0;
  let total = 0;

  for (let t = 0; t < roof.length; t += 3) {
    const a =
      Math.abs(
        triangleNormal(positions, roof[t], roof[t + 1], roof[t + 2])[2]
      ) / 2;

    for (let k = 0; k < 3; k++) {
      ce += (positions[roof[t + k] * 3] * a) / 3;
      cn += (positions[roof[t + k] * 3 + 1] * a) / 3;
    }

    total += a;
  }

  if (total < 1e-3) return null;

  return {
    id,
    positions,
    local,
    roof: new Uint32Array(roof),
    area: total,
    base,
    top,
    centre: [ce / total, cn / total],
    sourceTriangles: index.length / 3,
  };
}

/**
 * The building at one level of detail: simplified roof, plus walls from each
 * outline edge down to `bottom` (NZTM height). Returns positions (e, n, h)
 * and triangles wound counter-clockwise seen from outside.
 */
function lodMesh(building, { error, islandArea }, bottom) {
  const { positions, local, roof } = building;

  const [simplified] = MeshoptSimplifier.simplify(roof, local, 3, 0, error, [
    "ErrorAbsolute",
    "Prune",
  ]);

  const kept = dropSmallIslands(positions, simplified, islandArea);

  if (!kept.length) return null;

  // Renumber to the vertices in use.
  const remap = new Map();
  const out = [];

  const vertex = (v) => {
    let id = remap.get(v);

    if (id === undefined) {
      id = out.length / 3;
      remap.set(v, id);
      out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }

    return id;
  };

  const triangles = kept.map(vertex);

  // The simplifier occasionally folds a triangle over; walls are built
  // outward from each triangle's winding, so face them all up again.
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = triangles.slice(t, t + 3);

    if (triangleNormal(out, a, b, c)[2] < 0) {
      triangles[t + 1] = c;
      triangles[t + 2] = b;
    }
  }

  const roofCount = triangles.length;

  // Outline: edges used by one triangle. Walls face away from it.
  const edges = new Map();

  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      const edge = edges.get(key);

      if (edge) edge.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  }

  const below = new Map();

  const foot = (v) => {
    let id = below.get(v);

    if (id === undefined) {
      id = out.length / 3;
      below.set(v, id);
      out.push(out[v * 3], out[v * 3 + 1], bottom);
    }

    return id;
  };

  let wallLength = 0;

  for (const { a, b, count } of edges.values()) {
    if (count !== 1 || hidden(out, triangles, roofCount, a, b)) continue;
    triangles.push(a, foot(b), b, a, foot(a), foot(b));
    wallLength += Math.hypot(
      out[b * 3] - out[a * 3],
      out[b * 3 + 1] - out[a * 3 + 1]
    );
  }

  return { positions: out, triangles, wallLength };
}

/**
 * True when roof at least as high runs on all along the outside of outline
 * edge a-b, so a wall dropped from it would be inside the building. Roof
 * pieces meeting without sharing vertices leave a lot of these; separately
 * simplified, they also leave slivers of gap between them, which the walls
 * have to keep covering.
 */
function hidden(p, triangles, roofCount, a, b) {
  const [ax, ay, ah] = [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]];
  const [bx, by, bh] = [p[b * 3], p[b * 3 + 1], p[b * 3 + 2]];
  const length = Math.hypot(bx - ax, by - ay);

  if (length < 1e-6) return true;
  // Just outside the edge: to its right, as the roof is wound
  // counter-clockwise from above.
  const nx = ((by - ay) / length) * HIDDEN_PROBE;
  const ny = (-(bx - ax) / length) * HIDDEN_PROBE;
  const probes = Math.max(3, Math.ceil(length / HIDDEN_SPACING));

  for (let s = 1; s <= probes; s++) {
    const f = s / (probes + 1);
    const x = ax + (bx - ax) * f + nx;
    const y = ay + (by - ay) * f + ny;

    if (!roofAbove(p, triangles, roofCount, x, y, ah + (bh - ah) * f)) {
      return false;
    }
  }

  return true;
}

/** True when a roof triangle covers x, y no more than HIDDEN_STEP below height. */
function roofAbove(p, triangles, roofCount, x, y, height) {
  for (let t = 0; t < roofCount; t += 3) {
    const [i, j, k] = [triangles[t], triangles[t + 1], triangles[t + 2]];

    const x0 = p[i * 3],
      y0 = p[i * 3 + 1];

    const x1 = p[j * 3],
      y1 = p[j * 3 + 1];

    const x2 = p[k * 3],
      y2 = p[k * 3 + 1];

    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);

    if (Math.abs(det) < 1e-9) continue;
    const w0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / det;
    const w1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / det;
    const w2 = 1 - w0 - w1;

    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
    const there = w0 * p[i * 3 + 2] + w1 * p[j * 3 + 2] + w2 * p[k * 3 + 2];

    if (there >= height - HIDDEN_STEP) return true;
  }

  return false;
}

// --- Tiles ---

/** Deterministic 0..1 from an integer. */
function random(seed) {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A building's seed for the client's shading (see the vertex format). */
function seedOf(building) {
  return (
    Math.floor(random(building.id) * (WINDOWLESS_BIT - 1)) |
    (windowless(building) ? WINDOWLESS_BIT : 0)
  );
}

const quantise = (value, { min, range }) =>
  Math.max(0, Math.min(65535, Math.round(((value - min) / range) * 65535)));

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;

  const { manifest: terrain, groundHeight: dem } =
    await createGroundSampler(TERRAIN);

  // Wharves stand over water, where the bare-earth DEM is the seabed; the
  // ground they stand on, visibly, is sea level.
  const groundHeight = async (e, n) => {
    const height = await dem(e, n);

    return height === undefined ? undefined : Math.max(height, 0);
  };

  const { origin, rootSize } = terrain;
  const toWorld = (e, n) => [e - origin[0], -(n - origin[1])];

  // Load every building. Wards overlap a little at their edges, so a building
  // already seen (same spot, size and height) is skipped.
  let buildings = [];
  const seen = new Set();
  let duplicates = 0;
  let sourceTriangles = 0;

  for (const { name, suburban = false } of SERVICES) {
    const { layerUrl, dir, leaves } = await loadNodes(name);
    let count = 0;
    await inBatches(leaves, 8, async (node) => {
      const resource = node.mesh.geometry.resource;

      const buf = await fetchCached(
        `${layerUrl}/nodes/${resource}/geometries/1`,
        path.join(dir, `geometry-${resource}.drc`)
      );

      for (const raw of leafBuildings(node, buf)) {
        const building = prepareBuilding(raw);

        if (!building) continue;

        const key = [...building.centre, building.area, building.top]
          .map((v) => Math.round(v))
          .join(",");

        if (seen.has(key)) {
          duplicates++;
          continue;
        }

        seen.add(key);
        building.suburban = suburban;
        buildings.push(building);
        sourceTriangles += building.sourceTriangles;
        count++;
      }
    });
    console.log(`${name}: ${leaves.length} leaf nodes, ${count} buildings`);
  }

  console.log(
    `${buildings.length} buildings (${duplicates} duplicates skipped), ` +
      `${sourceTriangles} source triangles, ` +
      `${buildings.filter(windowless).length} windowless`
  );

  // Ground under each: at the centre, and lowest under the roof's vertices.
  // The model's heights are on a datum of their own; compare its base with
  // the DEM where the model is lowest. Buildings off the terrain are dropped.
  const onTerrain = [];

  for (const b of buildings) {
    b.ground = await groundHeight(...b.centre);

    if (b.ground !== undefined) onTerrain.push(b);
  }

  if (onTerrain.length < buildings.length) {
    console.log(
      `${buildings.length - onTerrain.length} buildings off the terrain`
    );
  }

  buildings = onTerrain;
  const offsets = [];

  for (const b of buildings) {
    let lowest = Infinity;
    let lowestAt = 0;

    for (let i = 0; i < b.positions.length; i += 3) {
      if (b.positions[i + 2] < lowest) {
        lowest = b.positions[i + 2];
        lowestAt = i;
      }
    }

    const dem = await groundHeight(
      b.positions[lowestAt],
      b.positions[lowestAt + 1]
    );

    b.baseOffset = dem === undefined ? undefined : b.base - dem;

    if (b.baseOffset !== undefined) offsets.push(b.baseOffset);
  }

  offsets.sort((a, b) => a - b);
  const datum = percentile(offsets, 0.5);
  console.log(
    `model base - DEM: p10 ${percentile(offsets, 0.1).toFixed(2)}, ` +
      `median ${datum.toFixed(2)}, p90 ${percentile(offsets, 0.9).toFixed(2)} m`
  );

  await rm(OUT_DIR, { recursive: true, force: true });
  const manifestLevels = [];
  let totalBytes = 0;

  // Finest first: it decides which buildings exist at all, and their walls
  // size the coarser levels' lights.
  const finest = Math.max(...LODS.map((lod) => lod.level));

  for (const lod of [...LODS].sort((a, b) => b.level - a.level)) {
    const size = rootSize / 2 ** lod.level;
    const tiles = new Map();
    let triangles = 0;
    let kept = 0;
    let lights = 0;

    const tileFor = (b) => {
      const [cx, cz] = toWorld(...b.centre);
      const tx = Math.floor((cx + rootSize / 2) / size);
      const ty = Math.floor((cz + rootSize / 2) / size);
      const key = `${tx}/${ty}`;
      let tile = tiles.get(key);

      if (!tile) {
        tiles.set(key, (tile = { x: tx, y: ty, parts: [], lights: [] }));
      }

      return tile;
    };

    for (const b of buildings) {
      if (lod.level !== finest && !b.wall) continue;

      const light = () => {
        if (lod.level === finest) return;
        const left = buildingLights(b, -datum, false, toWorld);
        tileFor(b).lights.push(...left);
        lights += left.length;
      };

      if (b.area < (b.suburban ? lod.suburbMinArea : lod.minArea)) {
        light();
        continue;
      }

      const shift = -datum;

      const lowestGround = Math.min(
        b.ground,
        ...(
          await Promise.all(
            [...Array(Math.min(b.positions.length / 3, 64)).keys()].map((k) => {
              const v = Math.floor((k * b.positions.length) / 3 / 64) * 3;

              return groundHeight(b.positions[v], b.positions[v + 1]);
            })
          )
        ).filter((h) => h !== undefined)
      );

      const bottom =
        Math.min(
          b.base + shift,
          b.ground + (lowestGround - b.ground) * MAX_VERTICAL_SCALE
        ) -
        WALL_SINK -
        shift;

      const mesh = lodMesh(b, lod, bottom);

      if (!mesh) {
        light();
        continue;
      }

      kept++;

      if (lod.level === finest) {
        b.wall = mesh.wallLength * (b.top - b.base);
      }

      tileFor(b).parts.push({ building: b, mesh, shift });
      triangles += mesh.triangles.length / 3;

      // Blank walls keep their lamps, which the material draws at any range.
      if (!windowless(b)) {
        const drawn = buildingLights(b, shift, true, toWorld);
        tileFor(b).lights.push(...drawn);
        lights += drawn.length;
      }
    }

    const entries = [];

    for (const tile of tiles.values()) {
      const entry = await writeTile(lod.level, tile, toWorld, groundHeight);
      entries.push(entry.manifest);
      totalBytes += entry.bytes;
    }

    entries.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    manifestLevels.push({
      level: lod.level,
      error: lod.error,
      // [x, y, minX, minZ, maxX, maxZ, minGround, maxGround, maxRel,
      // triangles, bytes, lights, windowWall]
      tiles: entries,
    });
    const bytes = entries.reduce((sum, t) => sum + t[10], 0);
    console.log(
      `level ${lod.level}: ${kept} buildings, ${triangles} triangles, ` +
        `${lights} lights, ${entries.length} tiles, ` +
        `${(bytes / 1e6).toFixed(2)} MB`
    );
  }

  manifestLevels.sort((a, b) => a.level - b.level);

  await writeFile(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify({
      attribution:
        "3D buildings © Wellington City Council and AAM Ltd, CC BY 4.0",
      origin,
      rootSize,
      encoding: ENCODING,
      levels: manifestLevels,
    })
  );
  console.log(`total ${(totalBytes / 1e6).toFixed(2)} MB`);
}

/** Encodes one tile's buildings and writes it; returns its manifest entry. */
async function writeTile(
  level,
  { x, y, parts, lights },
  toWorld,
  groundHeight
) {
  // World positions first, for the tile's bounds.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let minGround = Infinity;
  let maxGround = -Infinity;
  let maxRel = -Infinity;

  const placed = parts.map(({ building, mesh, shift }) => {
    const world = [];

    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [wx, wz] = toWorld(mesh.positions[i], mesh.positions[i + 1]);
      world.push(wx, wz);
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz);
      maxZ = Math.max(maxZ, wz);
    }

    minGround = Math.min(minGround, building.ground);
    maxGround = Math.max(maxGround, building.ground);

    return { building, mesh, shift, world };
  });

  for (const { building, world, top } of lights) {
    minX = Math.min(minX, world[0]);
    maxX = Math.max(maxX, world[0]);
    minZ = Math.min(minZ, world[1]);
    maxZ = Math.max(maxZ, world[1]);
    minGround = Math.min(minGround, building.ground);
    maxGround = Math.max(maxGround, building.ground);
    maxRel = Math.max(maxRel, top);
  }

  const vertexCount = parts.reduce(
    (s, p) => s + p.mesh.positions.length / 3,
    0
  );

  const vertices = new Uint16Array(vertexCount * 6);

  const indices = new Uint32Array(
    parts.reduce((s, p) => s + p.mesh.triangles.length, 0)
  );

  const spanX = Math.max(maxX - minX, 1e-3);
  const spanZ = Math.max(maxZ - minZ, 1e-3);
  let v = 0;
  let i = 0;

  for (const { building, mesh, shift, world } of placed) {
    const first = v;
    const seed = seedOf(building);
    const ground = quantise(building.ground, ENCODING.ground);
    const deltas = new Map();

    for (let k = 0; k < mesh.positions.length / 3; k++) {
      const e = mesh.positions[k * 3];
      const n = mesh.positions[k * 3 + 1];
      const rel = mesh.positions[k * 3 + 2] + shift - building.ground;
      maxRel = Math.max(maxRel, rel);
      // Walls share their top's spot: sample once per position.
      const spot = `${e},${n}`;

      if (!deltas.has(spot)) {
        const dem = await groundHeight(e, n);
        deltas.set(spot, (dem ?? building.ground) - building.ground);
      }

      const o = v * 6;
      vertices[o] = Math.round(((world[k * 2] - minX) / spanX) * 65535);
      vertices[o + 1] = Math.round(((world[k * 2 + 1] - minZ) / spanZ) * 65535);
      vertices[o + 2] = quantise(rel, ENCODING.rel);
      vertices[o + 3] = quantise(deltas.get(spot), ENCODING.rel);
      vertices[o + 4] = ground;
      vertices[o + 5] = seed;
      v++;
    }

    for (const t of mesh.triangles) indices[i++] = first + t;
  }

  // West to east, then north to south, so neighbours compress together.
  const lit = [...lights].sort(
    (a, b) => a.world[1] - b.world[1] || a.world[0] - b.world[0]
  );

  const lightData = new Uint16Array(lit.length * 8);
  lit.forEach(({ building, world, height, wall, top, drawn }, k) => {
    lightData.set(
      [
        Math.round(((world[0] - minX) / spanX) * 65535),
        Math.round(((world[1] - minZ) / spanZ) * 65535),
        quantise(building.ground, ENCODING.ground),
        quantise(height, ENCODING.rel),
        seedOf(building),
        Math.min(Math.round(wall), 65535),
        quantise(top, ENCODING.rel),
        drawn ? 1 : 0,
      ],
      k * 8
    );
  });

  const encodedLights = lit.length
    ? MeshoptEncoder.encodeVertexBuffer(
        new Uint8Array(lightData.buffer),
        lit.length,
        LIGHT_BYTES
      )
    : new Uint8Array(0);

  // Windowed wall under the tile, for the glow it puts into the sky.
  const windowWall = [
    ...new Set([...parts, ...lights].map(({ building }) => building)),
  ].reduce((sum, b) => sum + (windowless(b) ? 0 : b.wall), 0);

  // Reorder for the GPU's vertex cache and for compression. A coarse tile
  // can be all lights.
  const [remap, unique] = indices.length
    ? MeshoptEncoder.reorderMesh(indices, true, true)
    : [new Uint32Array(0), 0];

  const reordered = new Uint16Array(unique * 6);

  for (let k = 0; k < vertexCount; k++) {
    if (remap[k] === 0xffffffff) continue;
    reordered.set(vertices.subarray(k * 6, k * 6 + 6), remap[k] * 6);
  }

  const indexSize = unique > 65535 ? 4 : 2;

  const indexData = indexSize === 4 ? indices : Uint16Array.from(indices);

  const encodedVertices = unique
    ? MeshoptEncoder.encodeVertexBuffer(
        new Uint8Array(reordered.buffer),
        unique,
        12
      )
    : new Uint8Array(0);

  const encodedIndices = indices.length
    ? MeshoptEncoder.encodeIndexBuffer(
        new Uint8Array(indexData.buffer),
        indices.length,
        indexSize
      )
    : new Uint8Array(0);

  const header = new Uint32Array([
    0x33444c42, // "BLD3"
    unique,
    indices.length,
    indexSize,
    encodedVertices.length,
    encodedIndices.length,
    lit.length,
    encodedLights.length,
  ]);

  const padded = (bytes) => [
    Buffer.from(bytes),
    Buffer.alloc((4 - (bytes.length % 4)) % 4),
  ];

  const file = Buffer.concat([
    Buffer.from(header.buffer),
    ...padded(encodedVertices),
    ...padded(encodedIndices),
    ...padded(encodedLights),
  ]);

  const dir = path.join(OUT_DIR, String(level), String(x));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${y}.bin`), file);

  const round = (value) => Math.round(value * 100) / 100;

  return {
    bytes: file.length,
    manifest: [
      x,
      y,
      round(minX),
      round(minZ),
      round(maxX),
      round(maxZ),
      round(minGround),
      round(maxGround),
      round(maxRel),
      indices.length / 3,
      file.length,
      lit.length,
      Math.round(windowWall),
    ],
  };
}

await main();
