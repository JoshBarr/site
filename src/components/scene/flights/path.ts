import type { Fix } from "../../../lib/flights";

// Where an aircraft went, as a dense polyline in world space with a time at
// every point. Planes are drawn moving along it and their trails are drawn
// from it, so a plane always sits at the end of its own trail.

/** Seconds between points, at most, along a smooth path. */
const STEP = 2;
/**
 * Fixes further apart than this, seconds, aren't joined: coverage dropped.
 * Between visits, sweeps store a fix every two minutes; this allows for one
 * running late.
 */
const MAX_GAP = 200;
/** Most points between two fixes. */
const MAX_STEPS = 40;
/** Carry on past the last fix for this long, seconds, if no more arrive. */
export const EXTRAPOLATE = 30;
/**
 * Parked aircraft are heard only every few minutes, so they're kept this
 * long, seconds, and joined across gaps if they haven't moved.
 */
const PARKED_HOLD = 300;
/** On the ground and slower than this, m/s, is parked. */
const PARKED_SPEED = 2;
/** Parked fixes closer than this, metres, are the same spot. */
const PARKED_DRIFT = 50;
const GRAVITY = 9.81;
/** Most bank drawn, radians; airliners turn at 25–30°. */
const MAX_BANK = (35 * Math.PI) / 180;

export interface Path {
  /** Seconds since `epoch` the path was built against, increasing. */
  t: Float64Array;
  /** World position per point. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Radians clockwise from north. */
  heading: Float32Array;
  /** Radians, nose up. */
  pitch: Float32Array;
  /** Radians, right wing up. */
  bank: Float32Array;
  /** 1 where on the ground. */
  ground: Uint8Array;
  /** 1 where the segment to the next point is real, 0 across a gap. */
  joined: Uint8Array;
  /** Metres above the ground, airborne; 0 on it. */
  height: Float32Array;
}

export type ToWorld = (easting: number, northing: number) => [number, number];
export type GroundAt = (x: number, z: number) => number;

interface Point {
  t: number;
  p: [number, number, number];
  /** Velocity, m/s; null components aren't known. */
  v: [number | null, number | null, number | null];
  ground: boolean;
  groundHeight: number;
}

const parked = ({ ground, v }: Point) =>
  ground && Math.hypot(v[0] ?? 0, v[2] ?? 0) < PARKED_SPEED;

const wrap = (angle: number) =>
  angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));

function toPoint(
  [easting, northing, altitude, time, speed, track, climb]: Fix,
  epoch: number,
  toWorld: ToWorld,
  groundAt: GroundAt
): Point {
  const [x, z] = toWorld(easting, northing);
  const groundHeight = groundAt(x, z);
  const ground = altitude === null;
  const course = track === null ? null : (track * Math.PI) / 180;
  return {
    t: (time - epoch) / 1000,
    p: [x, ground ? groundHeight : Math.max(altitude, groundHeight), z],
    v: [
      course === null ? null : Math.sin(course) * speed,
      ground ? 0 : climb,
      course === null ? null : -Math.cos(course) * speed,
    ],
    ground,
    groundHeight,
  };
}

/**
 * Cubic Hermite between two fixes, using their reported velocities as
 * tangents so turns come out round. A tangent that disagrees wildly with
 * where the aircraft actually went is scaled back, so bad data can't loop.
 */
function hermite(a: Point, b: Point, u: number, out: number[]) {
  const dt = b.t - a.t;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  for (let k = 0; k < 3; k++) {
    const chord = b.p[k] - a.p[k];
    const limit = Math.abs(chord) * 1.5 + 30;
    const tangent = (v: number | null) =>
      v === null ? chord : Math.max(-limit, Math.min(limit, v * dt));
    out[k] =
      h00 * a.p[k] +
      h10 * tangent(a.v[k]) +
      h01 * b.p[k] +
      h11 * tangent(b.v[k]);
  }
}

/**
 * The path through an aircraft's fixes, carried on past the last one by dead
 * reckoning in case the next is late. Times are seconds since `epoch` (ms).
 */
export function buildPath(
  fixes: Fix[],
  epoch: number,
  toWorld: ToWorld,
  groundAt: GroundAt
): Path {
  const points = fixes.map((fix) => toPoint(fix, epoch, toWorld, groundAt));

  // Dead reckoning: straight on, no lower than the ground.
  const last = points[points.length - 1];
  const hold = parked(last) ? PARKED_HOLD : EXTRAPOLATE;
  const [vx, vy, vz] = last.v.map((v) => v ?? 0);
  const ahead = [
    last.p[0] + vx * hold,
    last.p[1] + vy * hold,
    last.p[2] + vz * hold,
  ];
  const aheadGround = groundAt(ahead[0], ahead[2]);
  points.push({
    ...last,
    t: last.t + hold,
    p: [ahead[0], Math.max(ahead[1], aheadGround), ahead[2]],
    groundHeight: aheadGround,
  });

  const t: number[] = [];
  const position: number[][] = [];
  const ground: number[] = [];
  const joined: number[] = [];
  const groundHeight: number[] = [];
  const course: (number | null)[] = [];
  const out = [0, 0, 0];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dt = b.t - a.t;
    const stayed =
      parked(a) &&
      parked(b) &&
      Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]) < PARKED_DRIFT;
    const gap = dt > MAX_GAP && !stayed;
    const steps = gap
      ? 1
      : Math.min(Math.max(Math.ceil(dt / STEP), 1), MAX_STEPS);
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      hermite(a, b, u, out);
      t.push(a.t + u * dt);
      position.push([...out]);
      ground.push(a.ground && (u === 0 || b.ground) ? 1 : 0);
      groundHeight.push(a.groundHeight + (b.groundHeight - a.groundHeight) * u);
      joined.push(gap ? 0 : 1);
      course.push(a.v[0] === null ? null : Math.atan2(a.v[0], -a.v[2]));
    }
  }
  t.push(last.t + hold);
  position.push(points[points.length - 1].p);
  ground.push(last.ground ? 1 : 0);
  groundHeight.push(points[points.length - 1].groundHeight);
  joined.push(0);
  course.push(null);

  const n = t.length;
  const path: Path = {
    t: Float64Array.from(t),
    x: Float32Array.from(position, (p) => p[0]),
    y: Float32Array.from(position, (p) => p[1]),
    z: Float32Array.from(position, (p) => p[2]),
    heading: new Float32Array(n),
    pitch: new Float32Array(n),
    bank: new Float32Array(n),
    ground: Uint8Array.from(ground),
    joined: Uint8Array.from(joined),
    height: Float32Array.from(position, (p, i) =>
      ground[i] ? 0 : Math.max(p[1] - groundHeight[i], 0)
    ),
  };

  // Attitude from the path itself: heading along it, pitch with the climb,
  // and bank into turns. Standing still, keep the reported heading.
  let heading = course.find((c) => c !== null) ?? 0;
  const speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.min(i + 1, n - 1);
    const k = j === i ? i - 1 : i;
    const dx = path.x[j] - path.x[k];
    const dz = path.z[j] - path.z[k];
    const dy = path.y[j] - path.y[k];
    const along = Math.hypot(dx, dz);
    const dt = Math.max(path.t[j] - path.t[k], 1e-3);
    speed[i] = along / dt;
    if (speed[i] > 3) heading = Math.atan2(dx, -dz);
    else if (course[i] !== null) heading = course[i];
    path.heading[i] = heading;
    path.pitch[i] = path.ground[i] || along < 1 ? 0 : Math.atan2(dy, along);
  }
  for (let i = 1; i < n - 1; i++) {
    if (path.ground[i]) continue;
    const turn = wrap(path.heading[i + 1] - path.heading[i - 1]);
    const rate = turn / Math.max(path.t[i + 1] - path.t[i - 1], 1e-3);
    const bank = Math.atan((speed[i] * rate) / GRAVITY);
    path.bank[i] = -Math.max(-MAX_BANK, Math.min(MAX_BANK, bank));
  }

  return path;
}

/** Index of the last point at or before `time`, or -1. */
export function pointBefore(path: Path, time: number) {
  let lo = 0;
  let hi = path.t.length - 1;
  if (time < path.t[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path.t[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  bank: number;
  ground: boolean;
  /** Above the ground, metres. */
  height: number;
}

/**
 * Where the aircraft is at `time`, or false if it isn't: before its first
 * fix, after the last plus its hold, or somewhere in a gap.
 */
export function poseAt(path: Path, time: number, out: Pose): boolean {
  const i = pointBefore(path, time);
  if (i < 0 || i >= path.t.length - 1 || !path.joined[i]) return false;
  const u = (time - path.t[i]) / (path.t[i + 1] - path.t[i]);
  const lerp = (a: ArrayLike<number>) => a[i] + (a[i + 1] - a[i]) * u;
  out.x = lerp(path.x);
  out.y = lerp(path.y);
  out.z = lerp(path.z);
  out.heading =
    path.heading[i] + wrap(path.heading[i + 1] - path.heading[i]) * u;
  out.pitch = lerp(path.pitch);
  out.bank = lerp(path.bank);
  out.ground = !!path.ground[i];
  out.height = lerp(path.height);
  return true;
}
