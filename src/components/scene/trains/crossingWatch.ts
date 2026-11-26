import { nztmToWorld, TileIndex } from "../terrain/manifest";
import { verticalScale } from "../terrain/Terrain";
import { RAIL_URL } from "./network";
import { paceTime } from "./pace";
import { distanceAt, type Run } from "./run";

// Level crossings, from public/rail/crossings.json (built by
// scripts/trains/build_crossings.mjs): where they are, what stands at each,
// and when their lights flash and barriers fall, worked out from the trains
// as they're drawn. Nothing here draws: see Crossings.tsx.

/** A crossing as the build script writes it: NZTM metres, degrees. */
interface CrossingRecord {
  name: string;
  kind: "road" | "path";
  /** Its middle, on the track bed: easting, northing, height. */
  at: [number, number, number];
  /** Bearings of the road and of the track through it. */
  road: number;
  track: number;
  /** Half the road, kerb to kerb, and half the tracks' spread along it. */
  half: number;
  spread: number;
  /** How many tracks. */
  count: number;
  /** Where on the network: [way, m along it]. */
  tracks: [number, number][];
  lights: boolean;
  bells: boolean;
  barrier: string;
  /** The arm's reach from each mast, m: 0 where there are none. */
  arm: number;
  /** Which of light, bell and barrier OpenStreetMap didn't say. */
  guessed: string[];
  /** Each mast: easting, northing, ground height, facing. */
  masts: [number, number, number, number][];
}

export interface CrossingsFile {
  crossings: CrossingRecord[];
}

/** A mast in the world: at the foot of its post. */
interface Mast {
  x: number;
  y: number;
  z: number;
  /** Which way its lights face, world x/z, unit: at those coming. */
  facing: [number, number];
  /** How far its barrier arm reaches, m: 0 for none. */
  arm: number;
}

/** A crossing in the world. */
export interface Crossing {
  name: string;
  /** A footpath's or cycleway's, not a road's. */
  path: boolean;
  /** Whether it has lights to flash: without, there's only its deck. */
  lights: boolean;
  /** Its middle, on the track bed, after the terrain's vertical scale. */
  x: number;
  y: number;
  z: number;
  /** Along the road, world x/z, unit; and half its width, m. */
  road: [number, number];
  half: number;
  /** Half the tracks' spread along the road, m. */
  spread: number;
  /** How square the road is to the track: 1 at a right angle, 0.5 at least. */
  square: number;
  /** A train's way passes within this of its middle, m, if it goes over it. */
  reach: number;
  /** From its middle to its edge along the track, m. */
  span: number;
  /** How long before a train arrives its lights start, s. */
  warning: number;
  /** The ground each way along the road from it, forward then back. */
  ends: [number, number];
  /** One each side of the line, where it has lights. */
  masts: Mast[];
}

// --- Timings. ---

/**
 * How long before a train arrives the lights and bells start, s: 22 on a
 * single track, 25 on a double, and 2 more for each track beyond that.
 * From Wikipedia's "Level crossings in New Zealand", not checked against
 * KiwiRail's own standard; TAIC's reports have about 21 s at line speed.
 */
const WARNING_SINGLE = 22;
const WARNING_DOUBLE = 25;
const WARNING_EACH_MORE = 2;

// The rest are guesses at the usual sequence.
/** The lights flash this long before the arms start down, s. */
export const ARMS_AFTER = 5;

/** The arms take this long to fall, and to rise again, s. */
export const ARMS_FALL = 9;
export const ARMS_RISE = 7;

/** Each lamp's on and off again in this, s: 50 flashes a minute. */
export const FLASH_PERIOD = 1.2;

/**
 * Once going, a crossing keeps on while a train's this much further off
 * than its warning, s: a train slowing on the approach doesn't flicker it.
 */
const HOLD = 8;

/** A train's clear once its tail is this far past, m. */
const CLEAR = 3;

/** Past its last fix a train's taken to keep on, if it was going this fast, m/s. */
const MOVING = 1.5;

/** No further past its last fix than this, s. */
const FORESEEN = 45;

/**
 * A train waiting this long at its last fix for the next, s, isn't taken
 * to be coming any more: the feed's gone quiet.
 */
const QUIET = 30;

/** An `on` or `off` that hasn't happened. */
export const NEVER = 1e9;

/** The size of the cells crossings are found by, m. */
const CELL = 256;

/** A train's way goes over a crossing if it's within this of its tracks, m. */
const NEAR_TRACK = 5;

/** One crossing isn't met twice within this far along a run, m. */
const AGAIN = 80;

// --- Placing. ---

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** A bearing, degrees clockwise from north, as a unit vector in world x/z. */
const toward = (bearing: number): [number, number] => [
  Math.sin(radians(bearing)),
  -Math.cos(radians(bearing)),
];

/** The crossings of a file, in the world. */
export function placeCrossings(
  file: CrossingsFile,
  index: TileIndex
): Crossing[] {
  const scale = verticalScale.value;

  return file.crossings.map((record) => {
    const [x, z] = nztmToWorld(index.manifest, record.at[0], record.at[1]);

    const square = Math.max(
      Math.abs(Math.sin(radians(record.road - record.track))),
      0.5
    );

    return {
      name: record.name,
      path: record.kind === "path",
      lights: record.lights,
      x,
      y: record.at[2] * scale,
      z,
      road: toward(record.road),
      half: record.half,
      spread: record.spread,
      square,
      reach: record.spread + NEAR_TRACK,
      span: record.half / square + 1,
      warning:
        record.count < 2
          ? WARNING_SINGLE
          : WARNING_DOUBLE + (record.count - 2) * WARNING_EACH_MORE,
      ends: [record.masts[0][2] * scale, record.masts[1][2] * scale],
      masts: record.lights
        ? record.masts.map(([e, n, ground, facing]): Mast => {
            const [mx, mz] = nztmToWorld(index.manifest, e, n);

            return {
              x: mx,
              y: ground * scale,
              z: mz,
              facing: toward(facing),
              arm: record.arm,
            };
          })
        : [],
    };
  });
}

export async function loadCrossings(index: TileIndex) {
  const response = await fetch(`${RAIL_URL}/crossings.json`);

  if (!response.ok) throw new Error(`crossings: HTTP ${response.status}`);

  return placeCrossings(await response.json(), index);
}

// --- Which crossings a train's way goes over. ---

/** A crossing on a run: which, and how far along the run it is, m. */
export interface Pass {
  crossing: number;
  s: number;
}

const cell = (x: number, z: number) =>
  (Math.floor(x / CELL) + 4096) * 8192 + Math.floor(z / CELL) + 4096;

/** Crossings by the cells round them, for finding those near a point. */
function gridOf(crossings: Crossing[]) {
  const grid = new Map<number, number[]>();

  crossings.forEach(({ x, z }, i) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = cell(x + dx * CELL, z + dz * CELL);

        if (!grid.has(key)) grid.set(key, []);
        grid.get(key)!.push(i);
      }
    }
  });

  return grid;
}

/**
 * The crossings a run goes over, and where along it: wherever its way
 * comes within a crossing's reach, at its nearest. That takes in the track
 * laid on past its last fix, so those ahead are known before it's there.
 */
export function passesOf(
  { points, s }: Pick<Run, "points" | "s">,
  crossings: Crossing[],
  grid = gridOf(crossings)
): Pass[] {
  const near: (Pass & { off: number })[] = [];

  for (let k = 1; k < points.length; k++) {
    const [ax, , az] = points[k - 1];
    const [bx, , bz] = points[k];
    const dx = bx - ax;
    const dz = bz - az;
    const length = dx * dx + dz * dz;

    for (const i of grid.get(cell((ax + bx) / 2, (az + bz) / 2)) ?? []) {
      const crossing = crossings[i];

      const t = Math.min(
        Math.max(
          ((crossing.x - ax) * dx + (crossing.z - az) * dz) / (length || 1),
          0
        ),
        1
      );

      const off = Math.hypot(
        ax + dx * t - crossing.x,
        az + dz * t - crossing.z
      );

      if (off > crossing.reach) continue;

      const at = s[k - 1] + (s[k] - s[k - 1]) * t;

      const same = near.find(
        (other) => other.crossing === i && Math.abs(other.s - at) < AGAIN
      );

      if (!same) near.push({ crossing: i, s: at, off });
      else if (off < same.off) Object.assign(same, { s: at, off });
    }
  }

  return near.map(({ crossing, s: at }) => ({ crossing, s: at }));
}

// --- When a train gets to one. ---

/**
 * When the middle of a train is `goal` m along its run, s on the scene's
 * clock: as its fixes say, and past the last of them as if it kept its
 * pace, for a while. Infinity when there's no saying. `target` is the time
 * trains are drawn at when they've a fix to run to.
 */
function timeAt(fixes: Run["fixes"], goal: number, target: number) {
  for (let k = 1; k < fixes.length; k++) {
    const a = fixes[k - 1];
    const b = fixes[k];

    if (goal <= b.s) {
      return a.time + ((goal - a.s) / (b.s - a.s || 1)) * (b.time - a.time);
    }
  }

  const last = fixes[fixes.length - 1];
  const before = fixes[fixes.length - 2];

  if (!before || target - last.time > QUIET) return Infinity;

  const pace = (last.s - before.s) / (last.time - before.time || 1);

  if (!(pace > MOVING)) return Infinity;

  const wait = (goal - last.s) / pace;

  return wait > FORESEEN ? Infinity : last.time + wait;
}

/**
 * Seconds until the front of a train reaches a crossing `s` m along its
 * run and `span` m from middle to edge: 0 while any of the train's on it,
 * Infinity once it's clear, or when there's no saying. `playhead` is the
 * time the train's drawn at, `target` the time it's making for.
 */
export function arrival(
  run: Pick<Run, "fixes" | "length" | "pace">,
  s: number,
  span: number,
  playhead: number,
  target: number
) {
  // The fix is the middle of the train; it runs toward +s.
  const front = distanceAt(run, playhead) + run.length / 2;

  if (front - run.length > s + span + CLEAR) return Infinity;

  if (front >= s - span) return 0;
  const goal = s - span - run.length / 2;

  // Driven, it's there when its pace says, if it gets there at all.
  const when = run.pace
    ? paceTime(run.pace, goal)
    : timeAt(run.fixes, goal, target);

  return Number.isNaN(when) ? Infinity : Math.max(when - playhead, 0);
}

// --- The sequence at each. ---

/**
 * How far down a crossing's arms are at `now`, 0..1, before easing: they
 * start `ARMS_AFTER` its lights and take `ARMS_FALL`, and rise over
 * `ARMS_RISE` once it's `off`. The shader's the same (Crossings.tsx).
 */
export function lowered(on: number, off: number, now: number) {
  const clamp = (x: number) => Math.min(Math.max(x, 0), 1);

  return (
    clamp((now - on - ARMS_AFTER) / ARMS_FALL) *
    (1 - clamp((now - off) / ARMS_RISE))
  );
}

/** Whether its lights are flashing at `now`: from `on` until the arms are up. */
export const flashing = (on: number, off: number, now: number) =>
  now >= on && now < off + ARMS_RISE;

/**
 * One crossing's lights and arms: when they last came on and went off, s
 * on the scene's clock, which is all the shader needs to draw them.
 */
export class Signal {
  on = NEVER;
  off = NEVER;

  /** Whether it's on, and not yet told to clear. */
  get going() {
    return this.on !== NEVER && this.off === NEVER;
  }

  /**
   * Brings it up to `now`: `wanted` while a train's near, `eta` seconds
   * off. Started with a train closer than the whole sequence takes, the
   * wait before the arms move is cut short.
   */
  step(now: number, wanted: boolean, eta = Infinity) {
    if (this.on === NEVER) {
      if (!wanted) return;

      const late = ARMS_AFTER + ARMS_FALL - eta;
      this.on = now - Math.min(Math.max(late, 0), ARMS_AFTER);
      this.off = NEVER;
    } else if (this.off === NEVER) {
      if (!wanted) this.off = now;
    } else if (wanted) {
      // Another train, before the arms were up: down again from where
      // they'd got to.
      const down = lowered(this.on, this.off, now);

      this.on = down > 0 ? now - ARMS_AFTER - down * ARMS_FALL : now;
      this.off = NEVER;
    } else if (now >= this.off + ARMS_RISE) {
      this.on = this.off = NEVER;
    }
  }
}

/**
 * Watches the trains for every crossing: each frame, `begin`, `see` each
 * run where it's drawn, then `settle`. `down` holds them all down, lights
 * flashing, whatever the trains do (`?crossings=down`, for screenshots).
 */
export class Watch {
  readonly signals: Signal[];
  private grid: Map<number, number[]>;
  private passes = new WeakMap<object, Pass[]>();
  private soonest: Float32Array;

  constructor(
    readonly crossings: Crossing[],
    private down = false
  ) {
    this.signals = crossings.map(() => new Signal());
    this.grid = gridOf(crossings);
    this.soonest = new Float32Array(crossings.length);
    this.reset();
  }

  /** As before any train: when the clock's set, their times mean nothing. */
  reset() {
    for (const [i, signal] of this.signals.entries()) {
      signal.on = this.down && this.crossings[i].lights ? -1000 : NEVER;
      signal.off = NEVER;
    }
  }

  begin() {
    this.soonest.fill(Infinity);
  }

  /** A run, drawn at `playhead` and making for `target`, s. */
  see(run: Run, playhead: number, target: number) {
    let passes = this.passes.get(run);

    if (!passes) {
      passes = passesOf(run, this.crossings, this.grid);
      this.passes.set(run, passes);
    }

    for (const { crossing, s } of passes) {
      const eta = arrival(
        run,
        s,
        this.crossings[crossing].span,
        playhead,
        target
      );

      if (eta < this.soonest[crossing]) this.soonest[crossing] = eta;
    }
  }

  settle(now: number) {
    if (this.down) return;

    for (const [i, signal] of this.signals.entries()) {
      const { lights, warning } = this.crossings[i];
      const eta = this.soonest[i];

      signal.step(
        now,
        lights && eta <= warning + (signal.going ? HOLD : 0),
        eta
      );
    }
  }
}
