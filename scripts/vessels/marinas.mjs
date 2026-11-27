// The marinas' pontoons and breakwaters, for build_berths.mjs: what's in
// OpenStreetMap round each marina, less what the terrain already has, as
// outlines in NZTM. Where OpenStreetMap has a marina's walkways but not the
// fingers off them (Evans Bay), the fingers are put in from the survey's
// berths, one down the side of each pen.

import { toNztm } from "../lib/geo.mjs";

/** Round each marina, m: what's in it. */
export const REACH = 350;

/**
 * A pier whose ground is higher than this, m, in the middle, is a wharf the
 * terrain has; one lower floats, or stands on piles, over the water.
 */
const PIER_GROUND = 2.0;

/** As PIER_GROUND for a breakwater: lower, the terrain's lost it. */
const BREAKWATER_GROUND = 1.0;

/**
 * Widths of a pontoon OpenStreetMap has as a line, m, when it doesn't say:
 * a walkway, as the outlines at Chaffers and Seaview, or a finger off one.
 */
const WALKWAY_WIDTH = 2.2;
const FINGER_WIDTH = 0.9;

/** A line longer than this, m, is a walkway; shorter, a finger. */
const FINGER_LONGEST = 25;

/** A breakwater OpenStreetMap has as a line: as Clyde Quay's, m. */
const BREAKWATER_WIDTH = 1.6;

/** Wider than this on average, m, a breakwater's a mound of rock. */
const ROCK_WIDTH = 3;

/** Of a pen's length, how far its finger reaches. */
const FINGER_REACH = 0.8;

/** A pen's end nearer a walkway than this, m, is the end it's entered from. */
const HEAD_GAP = 6;

/** The Overpass query: piers and breakwaters round each site (lat, lon). */
export function osmQuery(sites) {
  const around = sites
    .flatMap(([lat, lon]) =>
      ["way", "rel"].map(
        (type) =>
          `  ${type}["man_made"~"^(pier|breakwater)$"](around:${REACH},${lat},${lon});`
      )
    )
    .join("\n");

  return `[out:json][timeout:90];\n(\n${around}\n);\nout geom;`;
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Twice the signed area of a ring, positive anticlockwise (east, north). */
function signedArea(ring) {
  let sum = 0;

  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    sum += ax * by - bx * ay;
  }

  return sum;
}

/** The ring wound anticlockwise (an outside) or clockwise (a hole). */
function wound(ring, anticlockwise) {
  return signedArea(ring) > 0 === anticlockwise ? ring : [...ring].reverse();
}

function perimeter(ring) {
  let sum = 0;

  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    sum += Math.hypot(bx - ax, by - ay);
  }

  return sum;
}

function lineLength(line) {
  let sum = 0;

  for (let i = 1; i < line.length; i++) {
    sum += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  }

  return sum;
}

/** Whether point p is inside the ring. */
function inside([px, py], ring) {
  let within = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      within = !within;
    }
  }

  return within;
}

/** Distance from p to the segment a–b. */
function toSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;

  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1))
  );

  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * A line widened to `width`, as a ring: down its left side and back up its
 * right, mitred at the bends (the miter's held to twice the half width, so
 * a sharp bend doesn't spike).
 */
function widen(line, width) {
  const half = width / 2;

  const sides = line.map((point, i) => {
    const prev = line[Math.max(i - 1, 0)];
    const next = line[Math.min(i + 1, line.length - 1)];

    const normal = (a, b) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;

      return [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
    };

    const n0 = i > 0 ? normal(prev, point) : normal(point, next);
    const n1 = i < line.length - 1 ? normal(point, next) : n0;
    let mx = n0[0] + n1[0];
    let my = n0[1] + n1[1];
    const m = Math.hypot(mx, my) || 1;
    mx /= m;
    my /= m;

    const reach = Math.min(
      half / Math.max(mx * n0[0] + my * n0[1], 0.1),
      2 * half
    );

    return [
      [point[0] + mx * reach, point[1] + my * reach],
      [point[0] - mx * reach, point[1] - my * reach],
    ];
  });

  return [
    ...sides.map(([left]) => left),
    ...sides.map(([, right]) => right).reverse(),
  ];
}

/**
 * An OpenStreetMap way or multipolygon as rings in NZTM, the outside first,
 * then its holes; or a line, for an open way.
 */
function shapeOf(element) {
  const toPoints = (geometry) =>
    geometry.map(({ lat, lon }) => toNztm(lat, lon));

  if (element.type === "way") {
    const points = toPoints(element.geometry);

    if (points.length > 3 && same(points[0], points.at(-1))) {
      return { rings: [points.slice(0, -1)] };
    }

    return { line: points };
  }

  const ringsOf = (role) =>
    element.members
      .filter((m) => m.type === "way" && m.role === role && m.geometry)
      .map((m) => toPoints(m.geometry))
      .filter((ring) => ring.length > 3 && same(ring[0], ring.at(-1)))
      .map((ring) => ring.slice(0, -1));

  const [outer, ...others] = ringsOf("outer");

  if (!outer) return null;

  if (others.length) {
    console.warn(`r${element.id}: only its first outside ring is drawn`);
  }

  return { rings: [outer, ...ringsOf("inner")] };
}

/** The ground the terrain has under the shape, sampled every metre. */
async function groundUnder(rings, groundHeight) {
  const [outer, ...holes] = rings;
  const xs = outer.map(([x]) => x);
  const ys = outer.map(([, y]) => y);
  const heights = [];

  for (let x = Math.min(...xs) + 0.5; x < Math.max(...xs); x += 1) {
    for (let y = Math.min(...ys) + 0.5; y < Math.max(...ys); y += 1) {
      const p = [x, y];

      if (!inside(p, outer) || holes.some((hole) => inside(p, hole))) continue;
      const height = await groundHeight(x, y);

      if (height !== undefined) heights.push(height);
    }
  }

  // Too thin to hit a sample: along its outside instead.
  if (!heights.length) {
    for (const [x, y] of outer) {
      const height = await groundHeight(x, y);

      if (height !== undefined) heights.push(height);
    }
  }

  heights.sort((a, b) => a - b);

  return heights[Math.floor(heights.length / 2)] ?? 0;
}

const rounded = (ring) =>
  ring.flatMap(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);

/** Outside wound anticlockwise, holes clockwise, each a flat [e, n, …]. */
const flat = ([outer, ...holes]) => [
  rounded(wound(outer, true)),
  ...holes.map((hole) => rounded(wound(hole, false))),
];

/**
 * The pontoons and breakwaters in `osm` (an Overpass answer) the terrain
 * doesn't have, by `groundHeight` (NZTM, m), with fingers down the side of
 * each of `pens` (berths' [centre, bearing, length, width]) where
 * OpenStreetMap hasn't any.
 */
export async function buildMarinas(osm, groundHeight, pens) {
  const pontoons = [];
  const breakwaters = [];
  const skipped = [];

  for (const element of osm.elements) {
    const tags = element.tags ?? {};

    if (tags.floating === "no") {
      skipped.push(`${element.id} (fixed: not drawn)`);
      continue;
    }

    const shape = shapeOf(element);

    if (!shape) continue;
    const breakwater = tags.man_made === "breakwater";

    const width = shape.line
      ? breakwater
        ? BREAKWATER_WIDTH
        : Number.parseFloat(tags.width) ||
          (lineLength(shape.line) > FINGER_LONGEST
            ? WALKWAY_WIDTH
            : FINGER_WIDTH)
      : null;

    const rings = shape.rings ?? [widen(shape.line, width)];
    const ground = await groundUnder(rings, groundHeight);

    if (ground > (breakwater ? BREAKWATER_GROUND : PIER_GROUND)) {
      skipped.push(`${element.id} (ground ${ground.toFixed(1)} m)`);
      continue;
    }

    if (!breakwater) {
      pontoons.push(rings);
      continue;
    }

    const [outer] = rings;
    const meanWidth = width ?? Math.abs(signedArea(outer)) / perimeter(outer);
    const rock = tags.material === "rock" || meanWidth > ROCK_WIDTH;
    breakwaters.push({ id: element.id, rock, rings });
    console.log(
      `  breakwater ${element.id}: ${rock ? "rock" : "wall"}, ground ${ground.toFixed(1)} m, ${meanWidth.toFixed(1)} m wide`
    );
  }

  // A finger down one side of each pen, from the end that's on a walkway.
  const walkways = pontoons.flatMap(([outer]) =>
    outer.map((point, i) => [point, outer[(i + 1) % outer.length]])
  );

  const near = (p) => Math.min(...walkways.map(([a, b]) => toSegment(p, a, b)));
  let fingers = 0;

  for (const [[x, y], bearing, length, width] of pens) {
    const angle = (bearing * Math.PI) / 180;
    const along = [Math.sin(angle), Math.cos(angle)];

    const ends = [1, -1].map((s) => [
      x + (s * along[0] * length) / 2,
      y + (s * along[1] * length) / 2,
    ]);

    const gaps = ends.map(near);
    const head = gaps[0] < gaps[1] ? 0 : 1;

    if (gaps[head] > HEAD_GAP) continue;
    // Into the pen from its head, and to the right of that.
    const into = head === 0 ? [-along[0], -along[1]] : along;
    const right = [into[1], -into[0]];
    const side = width / 2;
    const [hx, hy] = ends[head];

    const from = [
      hx + right[0] * side - into[0] * 0.5,
      hy + right[1] * side - into[1] * 0.5,
    ];

    const reach = length * FINGER_REACH + 0.5;

    pontoons.push([
      widen(
        [from, [from[0] + into[0] * reach, from[1] + into[1] * reach]],
        FINGER_WIDTH
      ),
    ]);

    fingers++;
  }

  return {
    pontoons: pontoons.map(flat),
    breakwaters: breakwaters.map(({ rock, rings }) => ({
      rock,
      rings: flat(rings),
    })),
    fingers,
    skipped,
  };
}
