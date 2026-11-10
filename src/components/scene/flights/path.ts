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

/** A parked aircraft's position wanders this much, metres, standing still. */
const PARKED_JITTER = 5;
const GRAVITY = 9.81;

/**
 * Between fixes, in the air, at least this far above the ground, metres, or
 * as high as the fixes either side are if they're lower: a topdresser's
 * fixes skim the hills, and the path between them would cut through ridges.
 */
const CLEARANCE = 30;

/** Most bank drawn, radians; airliners turn at 25–30°. */
const MAX_BANK = (35 * Math.PI) / 180;

/**
 * On the ground, fixes closer than this, metres, are the aircraft standing
 * still: it keeps the heading it had.
 */
const STILL = 3;

/**
 * On the ground, a fix's tangent is at most this many times as long as the
 * way to the next fix: any longer and the curve can overshoot it.
 */
const GROUND_TANGENT = 1.5;

/** Fastest an aircraft turns on the ground, radians a second. */
const GROUND_TURN_RATE = (30 * Math.PI) / 180;

/** Pushed back no faster than this, m/s; taxiing is 4–10. */
const PUSHBACK_SPEED = 3.5;

/**
 * Going this far off the way the nose is reported to point, radians, from
 * standing still, is being pushed back.
 */
const PUSHBACK_ANGLE = (135 * Math.PI) / 180;

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

/**
 * How far, metres, to move an aircraft on the ground at (x, z) along its
 * heading to keep it out of buildings; negative is backwards.
 */
export type Clear = (x: number, z: number, heading: number) => number;

interface Point {
  t: number;
  p: [number, number, number];
  /** Velocity, m/s; null components aren't known. */
  v: [number | null, number | null, number | null];
  /** Reported track, radians clockwise from north; null if unknown. */
  track: number | null;
  ground: boolean;
  groundHeight: number;
}

const speedOf = ({ v }: Point) => Math.hypot(v[0] ?? 0, v[2] ?? 0);
const parked = (point: Point) => point.ground && speedOf(point) < PARKED_SPEED;

/** How far above the ground a fix keeps the path near it, metres. */
const clearanceOf = (point: Point) =>
  point.ground ? 0 : Math.min(point.p[1] - point.groundHeight, CLEARANCE);

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
    track: course,
    ground,
    groundHeight,
  };
}

const bearing = (a: Point, b: Point) =>
  Math.atan2(b.p[0] - a.p[0], -(b.p[2] - a.p[2]));

const apart = (a: Point, b: Point) =>
  Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]);

/**
 * On the ground, the way between fixes: adsb.lol's track lags a turn by a
 * fix or more, and is the way the nose points while it's pushed back, so a
 * curve along it loops back on itself. Each fix goes the way its neighbours
 * lie instead, at its reported speed (slow as a pushback is); standing
 * still, nowhere.
 */
function groundVelocity(points: Point[], i: number): Point["v"] {
  const point = points[i];

  const near = (j: number) =>
    j >= 0 && j < points.length && Math.abs(points[j].t - point.t) <= MAX_GAP;

  const a = near(i - 1) ? points[i - 1] : point;
  const b = near(i + 1) ? points[i + 1] : point;

  if (apart(a, b) < STILL) return [0, 0, 0];
  const way = bearing(a, b);
  const speed = speedOf(point);

  return [Math.sin(way) * speed, 0, -Math.cos(way) * speed];
}

/**
 * Whether the aircraft's being pushed back from `a` to `b`: on the ground,
 * slowly, against the way its nose points, and from standing still or
 * carrying on from a pushback.
 */
function pushedBack(a: Point, b: Point, before: Point | null, was: boolean) {
  if (!a.ground || !b.ground || a.track === null) return false;
  const moved = apart(a, b);

  if (moved < STILL || moved / Math.max(b.t - a.t, 1e-3) > PUSHBACK_SPEED) {
    return false;
  }

  if (Math.abs(wrap(bearing(a, b) - a.track)) < PUSHBACK_ANGLE) return false;

  return was || !before || apart(before, a) < STILL;
}

/**
 * Cubic Hermite between two fixes, using their reported velocities as
 * tangents so turns come out round. A tangent that disagrees wildly with
 * where the aircraft actually went is scaled back, so bad data can't loop.
 * On the ground, where fixes are close together for the speed, tangents are
 * kept short enough that the curve never runs past a fix and back.
 */
function hermite(a: Point, b: Point, u: number, out: number[]) {
  const dt = b.t - a.t;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const chord = [0, 1, 2].map((k) => b.p[k] - a.p[k]);
  const ground = a.ground && b.ground;

  const tangent = ({ v }: Point) => {
    const t = chord.map((c, k) => {
      const limit = Math.abs(c) * 1.5 + 30;
      const vk = v[k];

      return vk === null ? c : Math.max(-limit, Math.min(limit, vk * dt));
    });

    const most = Math.hypot(chord[0], chord[2]) * GROUND_TANGENT;
    const length = Math.hypot(t[0], t[2]);

    return ground && length > most ? t.map((c) => (c * most) / length) : t;
  };

  const ta = tangent(a);
  const tb = tangent(b);

  for (let k = 0; k < 3; k++) {
    out[k] = h00 * a.p[k] + h10 * ta[k] + h01 * b.p[k] + h11 * tb[k];
  }
}

/**
 * The path through an aircraft's fixes, carried on past the last one by dead
 * reckoning in case the next is late. Times are seconds since `epoch` (ms).
 * `clear` keeps it out of buildings on the ground.
 */
export function buildPath(
  fixes: Fix[],
  epoch: number,
  toWorld: ToWorld,
  groundAt: GroundAt,
  clear?: Clear
): Path {
  const points = fixes.map((fix) => toPoint(fix, epoch, toWorld, groundAt));

  // Parked at the gate, a fix can land tens of metres off at no speed: the
  // aircraft hasn't moved, so it stays where it stopped.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];

    if (!parked(a) || !parked(b)) continue;
    const moved = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]);

    // Either's speed: a pushback starts from nothing at a fix or two m/s.
    const explained =
      PARKED_JITTER + Math.max(speedOf(a), speedOf(b)) * (b.t - a.t);

    if (moved > explained && moved < PARKED_DRIFT) {
      points[i] = { ...b, p: [...a.p], groundHeight: a.groundHeight };
    }
  }

  for (let i = 0; i < points.length; i++) {
    if (points[i].ground) {
      points[i] = { ...points[i], v: groundVelocity(points, i) };
    }
  }

  // Dead reckoning: straight on, no lower than the ground. It's the end of
  // the path, so it doesn't hold the path up: a landing's last fix is often
  // just off the runway.
  const last = points[points.length - 1];
  const hold = parked(last) ? PARKED_HOLD : EXTRAPOLATE;
  // Parked, it stays put: a fix at a stand can still say 0.6 m/s.
  const [vx, vy, vz] = last.v.map((v) => (parked(last) ? 0 : (v ?? 0)));

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

  const clearance = points.map((point, i) =>
    i === points.length - 1 ? 0 : clearanceOf(point)
  );

  const t: number[] = [];
  const position: number[][] = [];
  const ground: number[] = [];
  const joined: number[] = [];
  const groundHeight: number[] = [];
  const course: (number | null)[] = [];
  /** 1 where moving between fixes on the ground, 2 where pushed back. */
  const taxi: number[] = [];
  const out = [0, 0, 0];
  let backing = false;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dt = b.t - a.t;

    backing = pushedBack(a, b, i > 0 ? points[i - 1] : null, backing);
    const moving = a.ground && b.ground && apart(a, b) >= STILL;

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
      const onGround = a.ground && (u === 0 || b.ground);
      const below = groundAt(out[0], out[2]);

      if (!onGround) {
        const above = clearance[i] + (clearance[i + 1] - clearance[i]) * u;
        out[1] = Math.max(out[1], below + above);
      }

      t.push(a.t + u * dt);
      position.push([...out]);
      ground.push(onGround ? 1 : 0);
      groundHeight.push(below);
      joined.push(gap ? 0 : 1);
      course.push(a.track);
      taxi.push(backing ? 2 : moving ? 1 : 0);
    }
  }

  t.push(last.t + hold);
  position.push(points[points.length - 1].p);
  ground.push(last.ground ? 1 : 0);
  groundHeight.push(points[points.length - 1].groundHeight);
  joined.push(0);
  course.push(null);
  taxi.push(0);

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

  // Attitude from the path itself: heading along it (backwards when pushed
  // back), pitch with the climb, and bank into turns. In the air and slow,
  // the reported heading; on the ground, until it first moves, then the
  // heading it had when it stopped.
  let heading = course.find((c) => c !== null) ?? 0;
  let taxied = false;
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

    if (path.ground[i] && taxi[i]) {
      taxied = true;

      if (along > 1e-3) {
        heading = Math.atan2(dx, -dz) + (taxi[i] === 2 ? Math.PI : 0);
      }
    } else if (speed[i] > 3 && !path.ground[i]) {
      heading = Math.atan2(dx, -dz);
    } else if (!(path.ground[i] && taxied)) heading = course[i] ?? heading;
    path.heading[i] = wrap(heading);
    path.pitch[i] = path.ground[i] || along < 1 ? 0 : Math.atan2(dy, along);
  }

  // A glitch in the fixes can still corner the path sharply on the ground:
  // aircraft there turn no faster than this.
  for (let i = 1; i < n; i++) {
    if (!path.ground[i] || !path.ground[i - 1] || !path.joined[i - 1]) {
      continue;
    }

    const most = GROUND_TURN_RATE * (path.t[i] - path.t[i - 1]);
    const turn = wrap(path.heading[i] - path.heading[i - 1]);
    path.heading[i] = wrap(
      path.heading[i - 1] + Math.max(-most, Math.min(most, turn))
    );
  }

  if (clear) {
    for (let i = 0; i < n; i++) {
      if (!path.ground[i]) continue;
      const shift = clear(path.x[i], path.z[i], path.heading[i]);
      path.x[i] += Math.sin(path.heading[i]) * shift;
      path.z[i] -= Math.cos(path.heading[i]) * shift;
    }
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
