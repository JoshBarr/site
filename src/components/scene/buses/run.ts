import { nztmToWorld, TileIndex } from "../terrain/manifest";
import type { HeightQuery } from "../terrain/Terrain";
import { random } from "../landmarks/common";
import type { Point } from "../trains/network";
import { BusRoutes, IndexedShape, Shape } from "./routes";
import type { Bus } from "./useBuses";

// A bus's run along its route: its fixes put on the roads its trip drives,
// with when it passed each point between them.

/** No bus goes faster than this, m/s: bounds how far on a fix can be. */
const TOP_SPEED = 30;
/** A fix further than this from a route, m, isn't on it. */
const RADIUS = 60;
/**
 * A route the fixes lie further than this from on average, m, isn't the
 * one the bus is driving: it's on a detour, or the route's changed.
 */
const OFF_ROUTE = 25;
/**
 * A fix this far back along the route from the last, m, is GPS wander:
 * the bus is held where it was. Any further and it's a fresh start.
 */
const WANDER = 25;
/** Added to a place on the route that runs against a bus's bearing, m. */
const AGAINST = 40;
/** Places on the route tried for the first fix, nearest first. */
const STARTS = 3;
/** Route either side of the fixes, for the bus to stand on, m. */
const EXTEND = 10;

/**
 * A bus's way along the roads: points with their distance along, and when
 * it got to and left each one (they differ only where it stopped); NaN
 * beyond its fixes.
 */
export interface Run {
  bus: Bus;
  points: Point[];
  s: number[];
  arrived: number[];
  left: number[];
  /** Distance along and time, seconds since the page's epoch, of each fix. */
  fixes: { s: number; time: number }[];
  /** How far through lighting-up its driver switches on, 0..1. */
  switchOn: number;
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Fixes as world x/z and seconds since the epoch. */
type Fix = [number, number, number];

/**
 * Where on `shape` each fix is, going only forward, and how far the fixes
 * are from it on average; null if they aren't on it. Starts from whichever
 * pass by the first fix fits the rest best.
 */
function match(
  shape: IndexedShape,
  fixes: Fix[],
  bearing: [number, number] | null
) {
  let best: { s: number[]; cost: number; from: number } | null = null;
  const starts = shape.near(fixes[0][0], fixes[0][1], RADIUS).slice(0, STARTS);
  for (const start of starts) {
    const s = [start.s];
    let cost =
      start.distance +
      (bearing && start.along[0] * bearing[0] + start.along[1] * bearing[1] < 0
        ? AGAINST
        : 0);
    let from = 0;
    for (let i = 1; i < fixes.length; i++) {
      const [x, z, time] = fixes[i];
      const last = s[s.length - 1];
      const reach = TOP_SPEED * Math.max(time - fixes[i - 1][2], 1) + RADIUS;
      const here = shape
        .near(x, z, RADIUS)
        .find((p) => p.s > last - WANDER && p.s < last + reach);
      if (!here) {
        // Somewhere it couldn't have got to: start again from here, if
        // it's on the route at all.
        const fresh = shape.near(x, z, RADIUS)[0];
        if (!fresh) return null;
        s.length = 0;
        s.push(fresh.s);
        cost = fresh.distance;
        from = i;
        continue;
      }
      s.push(Math.max(here.s, last));
      cost += here.distance;
    }
    const mean = cost / s.length;
    if (!best || mean < best.cost) best = { s, cost: mean, from };
  }
  return best;
}

/** A straight way through the fixes, for a bus off its route. */
function straight(
  fixes: Fix[],
  bearing: [number, number] | null,
  heightAt: HeightQuery
): { shape: Shape; s: number[] } | null {
  const points: Point[] = [];
  for (const [x, z] of fixes) {
    const last = points[points.length - 1];
    if (last && Math.hypot(x - last[0], z - last[2]) < 1) continue;
    const y = heightAt(x, z);
    if (y === undefined) return null;
    points.push([x, Math.max(y, 0), z]);
  }
  // Ahead and behind, so it has a way to face.
  const [ax, , az] = points[Math.max(points.length - 2, 0)];
  const [bx, by, bz] = points[points.length - 1];
  const length = Math.hypot(bx - ax, bz - az);
  const [dx, dz] =
    length > 1 ? [(bx - ax) / length, (bz - az) / length] : (bearing ?? [1, 0]);
  const [fx, fy, fz] = points[0];
  const back = points.length > 1 ? null : ([fx - dx, fy, fz - dz] as Point);
  const all: Point[] = [
    ...(back ? [back] : []),
    ...points,
    [bx + dx, by, bz + dz],
  ];
  const s = [0];
  for (let i = 1; i < all.length; i++) {
    const [px, py, pz] = all[i - 1];
    const [qx, qy, qz] = all[i];
    s.push(s[i - 1] + Math.hypot(qx - px, qy - py, qz - pz));
  }
  // Each fix at its own point: after the one put behind, if there is one.
  const fixesAt: number[] = [];
  let k = back ? 1 : 0;
  for (const [x, z] of fixes) {
    while (
      k < all.length - 2 &&
      Math.hypot(x - all[k][0], z - all[k][2]) >= 1
    ) {
      k++;
    }
    fixesAt.push(s[k]);
  }
  return { shape: { points: all, s }, s: fixesAt };
}

/** Where `shape` is at distance `d` along it. */
function pointOn({ points, s }: Shape, d: number): Point {
  if (d <= 0) return points[0];
  const n = s.length - 1;
  if (d >= s[n]) return points[n];
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= d) lo = mid;
    else hi = mid;
  }
  const t = (d - s[lo]) / (s[hi] - s[lo] || 1);
  const [ax, ay, az] = points[lo];
  const [bx, by, bz] = points[hi];
  return [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t];
}

/**
 * Follows a bus along its route from fix to fix, or straight between them
 * if it's off every way its route goes.
 */
export function follow(
  bus: Bus,
  routes: BusRoutes,
  index: TileIndex,
  epoch: number,
  heightAt: HeightQuery | null
): Run | null {
  let fixes: Fix[] = bus.trail.map(([e, n, time]) => [
    ...nztmToWorld(index.manifest, e, n),
    (time - epoch) / 1000,
  ]);
  const bearing =
    bus.bearing === null
      ? null
      : ([Math.sin(radians(bus.bearing)), -Math.cos(radians(bus.bearing))] as [
          number,
          number,
        ]);

  let found: { shape: Shape; s: number[] } | null = null;
  let cost = OFF_ROUTE;
  let start = 0;
  for (const shape of routes.shapesFor(bus.route, bus.direction)) {
    const m = match(shape, fixes, bearing);
    if (m && m.cost < cost) {
      cost = m.cost;
      found = { shape, s: m.s };
      start = m.from;
    }
  }
  // Fixes from before a fresh start are left behind.
  fixes = fixes.slice(start);
  if (!found) {
    if (!heightAt) return null;
    found = straight(fixes, bearing, heightAt);
    if (!found) return null;
  }

  const { shape, s: at } = found;
  const end = shape.s[shape.s.length - 1];
  const from = Math.max(at[0] - EXTEND, 0);
  const to = Math.min(at[at.length - 1] + EXTEND, end);
  // The route's own points between, and one at each fix, so each fix's
  // time lands on a point.
  const along = [
    from,
    ...shape.s.filter((d) => d > from && d < to),
    ...at,
    to,
  ].sort((a, b) => a - b);
  const s = along.filter((d, i) => i === 0 || d - along[i - 1] > 0.01);
  const times = fixes.map(([, , time]) => time);
  const last = at.length - 1;

  // It's taken to have kept a steady pace between fixes.
  const arrived = s.map((d) => {
    if (d < at[0] - 0.01 || d > at[last] + 0.01) return NaN;
    const k = at.findIndex((a) => a >= d - 0.01);
    if (k <= 0) return times[0];
    return (
      times[k - 1] +
      ((d - at[k - 1]) / (at[k] - at[k - 1])) * (times[k] - times[k - 1])
    );
  });
  const left = s.map((d) => {
    if (d < at[0] - 0.01 || d > at[last] + 0.01) return NaN;
    let k = last;
    while (k > 0 && at[k] > d + 0.01) k--;
    if (k === last) return times[last];
    return (
      times[k] +
      ((d - at[k]) / (at[k + 1] - at[k] || 1)) * (times[k + 1] - times[k])
    );
  });

  const id = Number(bus.id) || bus.id.length;
  return {
    bus,
    points: s.map((d) => pointOn(shape, d)),
    s,
    arrived,
    left,
    fixes: at.map((d, k) => ({ s: d, time: times[k] })),
    switchOn: random(id) * 0.6,
  };
}
