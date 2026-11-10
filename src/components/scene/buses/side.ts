import type { Point } from "../trains/network";

// Moving a bus's way sideways on the road.

/** A corner's offset is stretched no more than this many times. */
const MITRE_LIMIT = 2;

/**
 * `points` moved `by` m (or each its own) to the left of the way they run,
 * x/z only, mitred at the corners so the sides stay parallel.
 */
export function keepLeft(points: Point[], by: number | number[]): Point[] {
  // Each segment's left normal (north is -z), or null where it doesn't
  // move, then taken from the nearest segment that does.
  const normals: ([number, number] | null)[] = points
    .slice(1)
    .map(([bx, , bz], i) => {
      const [ax, , az] = points[i];
      const length = Math.hypot(bx - ax, bz - az);

      return length < 1e-3 ? null : [(bz - az) / length, -(bx - ax) / length];
    });

  for (let i = 1; i < normals.length; i++) normals[i] ??= normals[i - 1];

  for (let i = normals.length - 2; i >= 0; i--) normals[i] ??= normals[i + 1];

  if (!normals[0]) return points;

  return points.map(([x, y, z], i) => {
    const left = Array.isArray(by) ? by[i] : by;

    if (!left) return [x, y, z];
    const a = normals[Math.max(i - 1, 0)]!;
    const b = normals[Math.min(i, normals.length - 1)]!;
    const mx = a[0] + b[0];
    const mz = a[1] + b[1];
    const m = Math.hypot(mx, mz);

    // Doubling back: no mitre, just the way out.
    if (m < 1e-6) return [x + b[0] * left, y, z + b[1] * left];

    const stretch = Math.min(m / (mx * b[0] + mz * b[1]), MITRE_LIMIT);

    return [x + (mx / m) * left * stretch, y, z + (mz / m) * left * stretch];
  });
}

/**
 * A way out to a stop and straight back this long or shorter, m, is a
 * route's shape going to the stop's pole: Metlink's shapes call at each
 * stop on the way.
 */
const SPUR = 20;

/** Points closer than this, m, are the same place. */
const SAME = 0.3;

/**
 * A bus at a stop has its middle this much nearer the road's middle than
 * the pole, m: the pole's back from the kerb, and the bus is half its
 * width out from it. Keeping left takes it the rest of the way.
 */
const SHORT_OF_POLE = 4;

/** Furthest over a bus pulls in to a stop, beyond keeping left, m. */
const MOST_PULL = 2.5;

/** Along the road, m: pulling in, at the kerb (behind the pole and past it), pulling out. */
const PULL_IN = 25;
const BEHIND_POLE = 15;
const PAST_POLE = 3;
const PULL_OUT = 20;

/** Points are this close together while a bus is pulling in or out, m. */
const PULL_STEP = 4;

const smoothstep = (u: number) => {
  const t = Math.min(Math.max(u, 0), 1);

  return t * t * (3 - 2 * t);
};

/** How far over, 0..1, a bus is `d` m along from a stop's pole. */
const pulled = (d: number) =>
  d < -BEHIND_POLE
    ? smoothstep((d + BEHIND_POLE + PULL_IN) / PULL_IN)
    : d > PAST_POLE
      ? 1 - smoothstep((d - PAST_POLE) / PULL_OUT)
      : 1;

const apart = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[2] - a[2]);

/**
 * A route's way along the roads with its spurs out to each stop's pole and
 * back (which turn a bus sharply into the kerb and out again) taken out,
 * and the bus eased over toward the kerb there instead: pulling in, along
 * the kerb past the pole, and out again.
 */
export function pullInAtStops(points: Point[]): Point[] {
  const way: Point[] = [];
  const stops: { at: number; toward: Point }[] = [];

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const base = way[way.length - 1];

    if (base && apart(base, point) < SAME) continue;
    const next = points[i + 1];
    const out = base ? apart(base, point) : Infinity;

    // Out to the pole and back to where it left the road.
    if (next && out <= SPUR && apart(base, next) < Math.min(1.5, out / 2)) {
      stops.push({ at: way.length - 1, toward: point });
      i++;
      continue;
    }

    way.push(point);
  }

  if (!stops.length) return way;

  const s = [0];

  for (let i = 1; i < way.length; i++)
    s.push(s[i - 1] + apart(way[i - 1], way[i]));

  // How far over each one pulls, left positive: toward the pole, by however
  // far out the pole is.
  const pulls = stops.flatMap(({ at, toward }) => {
    const [ax, , az] = way[Math.max(at - 1, 0)];
    const [bx, , bz] = way[Math.min(at + 1, way.length - 1)];
    const length = Math.hypot(bx - ax, bz - az);
    const [x, , z] = way[at];

    const by = Math.min(
      Math.max(apart(way[at], toward) - SHORT_OF_POLE, 0),
      MOST_PULL
    );

    if (length < 1e-3 || !by) return [];

    const left =
      ((toward[0] - x) * (bz - az) - (toward[2] - z) * (bx - ax)) / length;

    return [{ s: s[at], by: left < 0 ? -by : by }];
  });

  if (!pulls.length) return way;

  const offset = (d: number) => {
    let most = 0;

    for (const pull of pulls) {
      const by = pull.by * pulled(d - pull.s);

      if (Math.abs(by) > Math.abs(most)) most = by;
    }

    return most;
  };

  const near = (d: number) =>
    pulls.some(
      (pull) =>
        d > pull.s - BEHIND_POLE - PULL_IN && d < pull.s + PAST_POLE + PULL_OUT
    );

  // Points close together where it pulls in and out, so it curves.
  const placed: Point[] = [];
  const along: number[] = [];

  for (let i = 0; i < way.length; i++) {
    placed.push(way[i]);
    along.push(s[i]);

    if (i === way.length - 1) continue;
    const [ax, ay, az] = way[i];
    const [bx, by, bz] = way[i + 1];
    const length = s[i + 1] - s[i];

    for (let d = PULL_STEP; d < length - PULL_STEP / 2; d += PULL_STEP) {
      if (!near(s[i] + d)) continue;
      const t = d / length;
      placed.push([ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t]);
      along.push(s[i] + d);
    }
  }

  return keepLeft(placed, along.map(offset));
}
