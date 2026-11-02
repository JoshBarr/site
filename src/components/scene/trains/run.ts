import { Vector3 } from "three/webgpu";
import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { random } from "../landmarks/common";
import type { Line } from "../../../lib/trains";
import { Point, RailNetwork, Snap } from "./network";
import type { Train } from "./useTrains";

// A train's run along the tracks: matched to them from its fixes, with the
// cars it's made up of.

/** No train goes faster than this, m/s: bounds the search between fixes. */
const TOP_SPEED = 45;

/** Track found beyond the first and last fixes, for cars to stand on, m. */
const EXTEND = 120;

/** Fixes this far apart, m, say which way a train's going. */
const MOVED = 20;

/** Tracks considered for each fix, nearest first. */
const CANDIDATES = 4;

/**
 * What a metre of detour between fixes costs, against a metre of distance
 * from a fix: trains go the short way.
 */
const DETOUR = 0.2;

/** A vehicle in a consist: size in m, and its grey. */
interface Car {
  length: number;
  width: number;
  height: number;
  tint: number;
}

// Sizes are near enough, not drawn from the stock's specs.
/** A car of a Matangi (FP/FT) unit, which run in pairs. */
const MATANGI: Car = {
  length: 20.7,
  width: 2.75,
  height: 3.75,
  tint: 0xd8d8d8,
};

/** The Wairarapa Connection's carriages and the locomotive hauling them. */
const CARRIAGE: Car = { length: 22, width: 2.8, height: 3.6, tint: 0x8e8e8e };

const LOCOMOTIVE: Car = {
  length: 17,
  width: 2.75,
  height: 3.85,
  tint: 0x3a3a3a,
};

/** Between cars, m. */
export const GAP = 0.8;

/** Weekday rush hours, NZ time: when the longest trains run. */
export function isPeak(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)!.value;

  if (["Sat", "Sun"].includes(get("weekday"))) return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));

  return (
    (minutes >= 7 * 60 && minutes < 9 * 60) ||
    (minutes >= 16 * 60 && minutes < 18.5 * 60)
  );
}

/**
 * What a line's trains are made up of. Metlink doesn't say, so these are
 * typical: Kāpiti and Hutt trains two Matangi units long, three at the
 * peaks; Melling and Johnsonville one; the Wairarapa a locomotive and six.
 */
function consist(line: Line, peak: boolean): Car[] {
  switch (line) {
    case "WRL":
      return [LOCOMOTIVE, ...Array(6).fill(CARRIAGE)];
    case "MEL":
    case "JVL":
      return [MATANGI, MATANGI];
    default:
      return Array(peak ? 6 : 4).fill(MATANGI);
  }
}

/**
 * A train's way along the tracks: points with their distance along it, from
 * the first fix (0), and the times it passed them; NaN beyond its fixes.
 */
export interface Run {
  train: Train;
  cars: Car[];
  length: number;
  points: Point[];
  s: number[];
  times: number[];
  /** Distance along and time, seconds since the page's epoch, of each fix. */
  fixes: { s: number; time: number }[];
  /** How far through lighting-up its crew switch on, 0..1. */
  switchOn: number;
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Unit world x/z from a to b, or null if they're too close to say. */
function direction(
  [ax, az]: number[],
  [bx, bz]: number[],
  least = 0.5
): [number, number] | null {
  const length = Math.hypot(bx - ax, bz - az);

  return length > least ? [(bx - ax) / length, (bz - az) / length] : null;
}

/** Length of a way along the tracks. */
function lengthOf(route: Point[]) {
  let length = 0;

  for (let k = 1; k < route.length; k++) {
    const [ax, ay, az] = route[k - 1];
    const [bx, by, bz] = route[k];
    length += Math.hypot(bx - ax, by - ay, bz - az);
  }

  return length;
}

/** World x/z of a point on the tracks. */
const flat = ([x, , z]: Point) => [x, z];

/** The way between two fixes: as found before, or by `find`. */
export type Routes = (
  key: string,
  find: () => Point[] | null
) => Point[] | null;

/** Follows a train along the tracks from fix to fix. */
export function follow(
  train: Train,
  network: RailNetwork,
  index: TileIndex,
  epoch: number,
  routes: Routes,
  peak: boolean
): Run | null {
  const fixes = train.trail.map(([e, n, time]) => [
    ...nztmToWorld(index.manifest, e, n),
    (time - epoch) / 1000,
  ]);

  const bearing: [number, number] | null =
    train.bearing === null
      ? null
      : [Math.sin(radians(train.bearing)), -Math.cos(radians(train.bearing))];

  // Where on the tracks each fix could be, going the way the fixes either
  // side say.
  const options = fixes.map(([x, z], i) =>
    network
      .candidates(
        x,
        z,
        direction(fixes[i - 1] ?? fixes[i], fixes[i + 1] ?? fixes[i], MOVED) ??
          (i === fixes.length - 1 ? bearing : null)
      )
      .slice(0, CANDIDATES)
  );

  // The likeliest way through them (Viterbi): close to each fix, without
  // detours between. Where no way between fixes is one a train could take,
  // it starts again.
  interface Step {
    cost: number;
    /** Which of the previous fix's candidates it came from. */
    from: number;
    route: Point[] | null;
  }

  const steps: Step[][] = [];
  let begin = -1;
  let previous = -1;

  for (const [i, here] of options.entries()) {
    steps.push([]);

    if (!here.length) continue;

    const fresh = () => {
      steps[i] = here.map(({ score }) => ({
        cost: score,
        from: -1,
        route: null,
      }));
      begin = previous = i;
    };

    if (previous < 0) {
      fresh();
      continue;
    }

    const limit =
      TOP_SPEED * Math.max(fixes[i][2] - fixes[previous][2], 1) + 300;

    steps[i] = here.map(({ snap, score }) => {
      let best: Step = { cost: Infinity, from: -1, route: null };
      steps[previous].forEach((step, k) => {
        const a = options[previous][k].snap;

        const route = routes(`${a.edge}:${a.t}>${snap.edge}:${snap.t}`, () =>
          network.route(a, snap, limit)
        );

        if (!route) return;
        const detour = lengthOf(route) - Math.hypot(snap.x - a.x, snap.z - a.z);
        const cost = step.cost + score + detour * DETOUR;

        if (cost < best.cost) best = { cost, from: k, route };
      });

      return best;
    });

    if (steps[i].every(({ cost }) => cost === Infinity)) fresh();
    previous = i;
  }

  if (previous < 0) return null;

  // Back from the best place for the latest fix.
  const chain: { i: number; snap: Snap; route: Point[] | null }[] = [];

  let k = steps[previous].reduce(
    (best, step, c) => (step.cost < steps[previous][best].cost ? c : best),
    0
  );

  for (let i = previous; i >= begin; i--) {
    if (!steps[i].length) continue;
    const step = steps[i][k];
    chain.unshift({ i, snap: options[i][k].snap, route: step.route });

    if (step.from < 0) break;
    k = step.from;
  }

  const first = chain[0].snap;
  const last = chain[chain.length - 1].snap;
  const points: Point[] = [[first.x, first.y, first.z]];
  const s = [0];
  const times = [fixes[chain[0].i][2]];
  const at: Run["fixes"] = [{ s: 0, time: times[0] }];

  for (const { i, route } of chain.slice(1)) {
    const before = at[at.length - 1];
    const time = fixes[i][2];
    const from = s[s.length - 1];
    const total = lengthOf(route!);
    let along = from;

    for (const [k, p] of route!.slice(1).entries()) {
      along += Math.hypot(
        p[0] - route![k][0],
        p[1] - route![k][1],
        p[2] - route![k][2]
      );
      points.push(p);
      s.push(along);
      // It's taken to have kept a steady pace between fixes.
      times.push(
        total > 0
          ? before.time + ((along - from) / total) * (time - before.time)
          : time
      );
    }

    at.push({ s: along, time });
  }

  // Track either side of the fixes, for the cars to stand on.
  const forward = direction(
    flat(points[points.length - 2] ?? points[0]),
    flat(points[points.length - 1])
  ) ??
    bearing ?? [1, 0];

  const backward = direction(flat(points[1] ?? points[0]), flat(points[0])) ?? [
    -forward[0],
    -forward[1],
  ];

  const behind = network.extend(first, backward, EXTEND).slice(1);
  const ahead = network.extend(last, forward, EXTEND).slice(1);
  const end = s[s.length - 1];
  let back = 0;
  behind.forEach((p, k) => {
    const q = k ? behind[k - 1] : points[0];
    back -= Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    points.unshift(p);
    s.unshift(back);
    times.unshift(NaN);
  });
  let on = end;

  for (const p of ahead) {
    const [qx, qy, qz] = points[points.length - 1];
    on += Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
    points.push(p);
    s.push(on);
    times.push(NaN);
  }

  const cars = consist(train.line, peak);
  const id = Number(train.id) || train.id.length;

  return {
    train,
    cars,
    length: cars.reduce((sum, car) => sum + car.length + GAP, -GAP),
    points,
    s,
    times,
    fixes: at,
    switchOn: random(id) * 0.6,
  };
}

/** Where a run is `distance` along: on its track, clamped to its ends. */
export function pointAt(
  { points, s }: Pick<Run, "points" | "s">,
  distance: number,
  out: Vector3
) {
  if (distance <= s[0]) return out.set(...points[0]);
  const n = s.length - 1;

  if (distance >= s[n]) return out.set(...points[n]);
  let lo = 0;
  let hi = n;

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;

    if (s[mid] <= distance) lo = mid;
    else hi = mid;
  }

  const t = (distance - s[lo]) / (s[hi] - s[lo] || 1);
  const [ax, ay, az] = points[lo];
  const [bx, by, bz] = points[hi];

  return out.set(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
}

/** How far along its run a train is at `time`, seconds since the epoch. */
export function distanceAt({ fixes }: Pick<Run, "fixes">, time: number) {
  if (time <= fixes[0].time) return fixes[0].s;

  for (let k = 1; k < fixes.length; k++) {
    const a = fixes[k - 1];
    const b = fixes[k];

    if (time <= b.time) {
      return a.s + ((time - a.time) / (b.time - a.time || 1)) * (b.s - a.s);
    }
  }

  return fixes[fixes.length - 1].s;
}
