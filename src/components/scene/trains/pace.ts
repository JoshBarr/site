// How far along its run a train is from moment to moment: driven from fix
// to fix as a train can be, not drawn straight between them.
//
// Metlink stamps every train with the batch's time each 30 s, but the
// position under the stamp is whatever the train last sent: up to 30 s
// stale, or the same one again. Taken at their word, the stamps have a
// train standing mid-track and then covering the gap at once. So here a
// fix only says the train was at its place some time in the 30 s before
// its stamp, a repeat says nothing, and the train's driven along its run by
// what it can do: no faster than the line allows, speeding up and braking
// no harder than it can, never backwards, and standing still only at a
// station (or the end of its track, or held a long while: see `HOLD`).
//
// It's driven when fixes come in, a step at a time, and kept as samples;
// a frame only reads them. Fresh fixes carry it on from where it's been
// drawn to, at the speed it was going, so what's been drawn never jumps.

/** Seconds between samples. */
const STEP = 0.5;

/**
 * How stale a fix can be, s: Metlink's batches are 30 s apart (measured
 * 2026-11-21), and a fix's position was sent since the last.
 */
const STALE = 30;

/**
 * Fixes this close to the one before, m, are the same place again: fixes
 * are good to a couple of metres, but a standing train's wander by up to
 * 10 (seen in replays of 2026-11-25), and one under way covers 40 or more
 * between batches.
 */
const REPEAT = 15;

/**
 * Aimed for this far inside each fix's 30 s, s, so being a moment slow to
 * reach a speed doesn't put a train outside it.
 */
const MARGIN = 1;

/**
 * Running late for a fix, a train makes the distance up over about this
 * long, s, not all at once.
 */
const CATCH_UP = 30;

/**
 * Making time up, or for a fix it's barely time to reach, a train goes at
 * most this many times as fast as it has been: more reads as racing. The
 * 1.5 the user settled on for catching up before (2026-11-21).
 */
const FASTER = 1.5;

/**
 * Past its newest fix a train keeps to the pace of its fixes over about
 * this long before it, s, not to whatever speed it's got up to.
 */
const LATELY = 90;

/**
 * At most this many fixes ahead are looked to for the speed to go at: past
 * a few the train will have changed its mind anyway.
 */
const LOOK = 6;

/** A train's speed comes round to what it wants over about this long, s. */
const RESPONSE = 3;

/** Under way, never slower than this, m/s, but for stopping. A guess. */
const CRAWL = 1.5;

/**
 * Needing to go slower than this to keep to its next fix, m/s, a train's
 * taken to be held (at a signal, say) and stands where it can stop.
 */
const HOLD = 0.5;

/** The shortest stop at a station, s. A guess: Metlink's take 20–40 s. */
const DWELL = 15;

/**
 * Fixes this far from a station, m, are where a train stopped for it: the
 * timetable's point for a station is somewhere along a 150 m platform.
 * A guess.
 */
const PLATFORM = 75;

/**
 * Leaving a station, a train with no speed to go back to sets off for this,
 * m/s (54 km/h). A guess.
 */
const SET_OFF = 15;

/** Driven on this far past its newest fix, s, for want of more. */
const AFTER = 240;

/** Kept from behind the time it's been drawn to, s: its trail's this long. */
const KEEP = 200;

/** What a train can do. */
export interface Limits {
  /** Line speed, m/s. */
  top: number;
  /** Hardest it speeds up, m/s², and its power for each kg of it, W/kg. */
  accelerate: number;
  power: number;
  /** How hard it brakes for a stop, m/s², and the hardest at all. */
  brake: number;
  hardest: number;
}

/**
 * A Matangi unit. 95 km/h is the FP class's service speed and 680 kW over
 * 76.9 t its motors' power (Wikipedia), which leaves 1 m/s² only up to
 * 32 km/h. 1 m/s² is Auckland Transport's figure for its AM class, an EMU
 * of the same age (Matangi's own isn't published); braking into a stop at
 * 0.7 m/s² is a guess at a driver's usual.
 */
export const MATANGI_LIMITS: Limits = {
  top: 95 / 3.6,
  accelerate: 1,
  power: 680_000 / 76_900,
  brake: 0.7,
  hardest: 1,
};

/**
 * The Wairarapa's locomotive and carriages: slower to get going. Guessed:
 * about 1.2 MW hauling 450 t.
 */
export const HAULED_LIMITS: Limits = {
  top: 95 / 3.6,
  accelerate: 0.6,
  power: 1_200_000 / 450_000,
  brake: 0.6,
  hardest: 1,
};

/** What's known of a train's way: along its run, m, and times, s. */
export interface Course {
  /** Its fixes, oldest first, as the run has them: `time` is the stamp. */
  fixes: { s: number; time: number }[];
  /** Where along its run a station is, in order. */
  stations: number[];
  /** As far as its middle can go: its track runs out, or isn't known. */
  end: number;
}

/** A place a train has to pass, and the times it can, s. */
interface Mark {
  s: number;
  early: number;
  late: number;
  /** Where it would stand at a station: the nearest of its fixes to it. */
  stands: boolean;
}

/**
 * The places a train's fixes say it passed: each one some time in the
 * STALE before its stamp, or since the fix before if the feed had lost it
 * for longer, and a repeat of the last place not again.
 */
export function marksOf(fixes: Course["fixes"]): Mark[] {
  const marks: Mark[] = [];

  for (const [i, { s, time }] of fixes.entries()) {
    const last = marks[marks.length - 1];

    if (last && s - last.s <= REPEAT) continue;
    const since = i ? fixes[i - 1].time : time - STALE;

    marks.push({
      s,
      early: Math.min(time - STALE, since),
      late: time,
      stands: false,
    });
  }

  return marks;
}

// A sample: where the train is and how fast it's going, and what it's
// minded to do: the stop it's braking for (NaN for none), whether that's a
// guess with no fix past it, how long it has to stand there, when it came
// to a stand (NaN moving), the speed to set off for, whether it's setting
// off, and the last station it's done with.
const S = 0;
const V = 1;
const STOP = 2;
const BET = 3;
const DWELLS = 4;
const STOOD = 5;
const CRUISE = 6;
const LEAVING = 7;
const PASSED = 8;
const WIDTH = 9;

/** A train's way through time: samples every STEP s from `start`. */
export interface Pace {
  start: number;
  count: number;
  samples: Float64Array;
}

/** Time, s, to cover `distance` from `speed` going for `top`, not stopping. */
function runTime(distance: number, speed: number, top: number, limits: Limits) {
  let s = 0;
  let v = speed;
  let t = 0;

  while (s < distance && t < 3600) {
    const a = Math.min(
      limits.accelerate,
      limits.power / Math.max(v, 0.1),
      (top - v) / STEP
    );

    s += v * STEP + 0.5 * a * STEP * STEP;
    v += a * STEP;
    t += STEP;
  }

  return t;
}

/**
 * The speed to run at, braking at `brake` at the end, to stop `distance`
 * on in `time`: the slower, if two would; the quickest there, if none.
 */
function stoppingIn(distance: number, time: number, brake: number) {
  const least = (2 * distance) / brake;

  if (time * time <= least) return Math.sqrt(2 * brake * distance);

  return brake * (time - Math.sqrt(time * time - least));
}

/**
 * The steady speeds from `s` at `time` that keep to the next few marks
 * from `from`, and not past `before`, for a train that's been going at
 * `usual`: [low, high, how many marks that took in].
 */
function band(
  marks: Mark[],
  from: number,
  s: number,
  time: number,
  before: number,
  brake: number,
  usual: number
): [number, number, number] {
  let low = 0;
  let high = Infinity;
  let n = 0;

  for (let j = from; j < marks.length && n < LOOK; j++, n++) {
    const { s: at, early, late, stands } = marks[j];
    const distance = at - s;
    const latest = late - MARGIN - time;
    const earliest = Math.min(early + MARGIN, late - MARGIN) - time;

    // Late for it, it makes up where it ought to be by now; to stand there,
    // it's to have braked by then; and never racing.
    const slow = Math.min(
      latest <= 0
        ? usual + (distance - usual * latest) / CATCH_UP
        : stands
          ? stoppingIn(distance, latest, brake)
          : distance / latest,
      usual * FASTER
    );

    const fast =
      earliest <= 0
        ? Infinity
        : stands
          ? earliest * earliest <= (2 * distance) / brake
            ? Infinity
            : stoppingIn(distance, earliest, brake)
          : distance / earliest;

    // No one speed keeps to that one too: then the train's to go as fast
    // (or as slow) as keeps to those before it, bending its course where
    // the one that holds it back says, as a string pulled taut would.
    if (slow > high) return [high, high, n];

    if (fast < low) return [low, low, n];
    low = Math.max(low, slow);
    high = Math.min(high, fast);

    // It'll stop at a station, and the time it stands there is its own.
    if (at > before || stands) {
      n++;
      break;
    }
  }

  return [low, high, n];
}

/** Index of the first mark further than `s`. */
function nextMark(marks: Mark[], s: number) {
  let j = 0;

  while (j < marks.length && marks[j].s <= s) j++;

  return j;
}

/**
 * Where a train at `from` stopping for the station at `station` stands:
 * where it said it was while it stood, if it did.
 */
function stopFor(marks: Mark[], station: number, from: number, end: number) {
  let best = station;
  let off = PLATFORM;

  for (const { s } of marks) {
    if (s > from && Math.abs(s - station) < off) {
      off = Math.abs(s - station);
      best = s;
    }
  }

  return Math.min(best, end);
}

/** Whether to stop, and whether that's a guess, with no fix past it. */
interface Decision {
  stop: boolean;
  bet: boolean;
}

/**
 * Whether a train at `s`, `speed`, at `time` can stop at `stop` and still
 * keep to the fixes after: if there's no fix past it, it's taken to stop,
 * as most trains do at every station.
 */
function canStop(
  marks: Mark[],
  stop: number,
  s: number,
  speed: number,
  time: number,
  limits: Limits
): Decision {
  const j = nextMark(marks, stop + REPEAT);

  if (j >= marks.length) return { stop: true, bet: true };

  const arrive = time + (speed > 0 ? (2 * (stop - s)) / speed : 0);
  let leave = arrive + DWELL;

  for (const mark of marks) {
    if (Math.abs(mark.s - stop) <= REPEAT) leave = Math.max(leave, mark.early);
  }

  const run = runTime(marks[j].s - stop, 0, limits.top, limits);

  return { stop: leave + run <= marks[j].late, bet: false };
}

/**
 * How fast a train's fixes have had it going lately at `time`, m/s: from
 * the middle of one's time to the middle of the newest's by then, up to
 * LATELY apart; null with only one.
 */
function paceOf(marks: Mark[], time: number) {
  const middle = ({ early, late }: Mark) => (early + late) / 2;
  let last = marks.length - 1;

  while (last > 0 && middle(marks[last]) > time) last--;
  let k = last;

  while (k > 0 && middle(marks[last]) - middle(marks[k - 1]) <= LATELY) k--;

  return k < last
    ? (marks[last].s - marks[k].s) /
        Math.max(middle(marks[last]) - middle(marks[k]), 1)
    : null;
}

/**
 * When a train standing as `x` has it (see `S` to `PASSED`) sets off for
 * mark `j`: once it's stood its dwell, and the time of the fix it stands
 * at has come, as late as gets it to the next fix by the middle of its
 * time at the speed it had before.
 */
function leaving(marks: Mark[], j: number, x: Float64Array, limits: Limits) {
  const s = x[S];
  let leave = x[STOOD] + x[DWELLS];

  for (const mark of marks) {
    if (Math.abs(mark.s - s) <= REPEAT) {
      leave = Math.max(leave, mark.early + MARGIN);
    }
  }

  const { s: at, early, late } = marks[j];
  const aim = (Math.min(early + MARGIN, late - MARGIN) + late - MARGIN) / 2;
  const run = runTime(at - s, 0, x[CRUISE] || SET_OFF, limits);

  return Math.max(leave, aim - run);
}

/**
 * Drives a train along its course from `state` at `time` (a sample's
 * worth: see `S` to `PASSED`) for `steps` steps, into `out` from sample
 * `from`.
 */
function drive(
  course: Course,
  marks: Mark[],
  limits: Limits,
  state: Float64Array,
  time: number,
  steps: number,
  out: Float64Array,
  from: number
) {
  const x = Float64Array.from(state);
  const { stations, end } = course;
  const plan = { j: -1, stood: NaN, leave: 0 };

  for (let step = 0; step < steps; step++) {
    const t = time + step * STEP;
    const s = x[S];
    let v = x[V];
    let a = 0;
    const j = nextMark(marks, s + 0.01);
    const lately = paceOf(marks, t);

    if (v <= 0) {
      // Standing: set off when there's somewhere to be, and it's time.
      // That's worked out once for each stand and fix it's making for.
      if (j < marks.length && s < end - 0.5) {
        if (plan.j !== j || plan.stood !== x[STOOD]) {
          plan.j = j;
          plan.stood = x[STOOD];
          plan.leave = leaving(marks, j, x, limits);
        }

        if (t >= plan.leave) {
          x[STOOD] = NaN;
          x[DWELLS] = 0;
          x[LEAVING] = 1;
          x[PASSED] = Math.max(x[PASSED], s + PLATFORM);
          a = Math.min(limits.accelerate, (x[CRUISE] || SET_OFF) / RESPONSE);
        }
      }
    } else {
      // Under way: the next station, and whether to stop for it.
      const braking = (v * v) / (2 * limits.brake);
      let stop = x[STOP];

      if (Number.isNaN(stop)) {
        const station = stations.find((at) => at > s && at > x[PASSED]);

        const ahead =
          station === undefined ? end : stopFor(marks, station, s, end);

        const atEnd = station === undefined || ahead >= end;

        if (ahead - s <= braking + v * STEP) {
          if (atEnd) {
            stop = ahead;
            x[BET] = 0;
            x[DWELLS] = 0;
          } else if (ahead - s < (v * v) / (2 * limits.hardest)) {
            // Too late to stop for it.
            x[PASSED] = station! + PLATFORM;
          } else {
            const { stop: stopping, bet } = canStop(
              marks,
              ahead,
              s,
              v,
              t,
              limits
            );

            if (stopping) {
              stop = ahead;
              x[BET] = bet ? 1 : 0;
              x[DWELLS] = DWELL;
            } else x[PASSED] = station! + PLATFORM;
          }

          if (!Number.isNaN(stop)) x[CRUISE] = Math.max(v, CRAWL);
        }
      } else if (x[BET] && nextMark(marks, stop + REPEAT) < marks.length) {
        // Stopping on a guess, and now there's word from past the stop.
        if (!canStop(marks, stop, s, v, t, limits).stop) {
          x[PASSED] = stop + PLATFORM;
          stop = NaN;
        }
      }

      const [low, high] = band(
        marks,
        j,
        s,
        t,
        Number.isNaN(stop) ? Infinity : stop,
        limits.brake,
        Math.max(lately ?? SET_OFF, x[CRUISE])
      );

      if (Number.isNaN(stop) && high < HOLD && j < marks.length) {
        // Held: at the next station, if it's before the next fix, or else
        // at the fix, where it stands when it's heard from again; or if
        // it's too late to stop there, as soon as it can.
        const station = stations.find((at) => at > s && at > x[PASSED]);

        const platform =
          station === undefined ? Infinity : stopFor(marks, station, s, end);

        const at = Math.min(
          platform <= marks[j].s + PLATFORM ? platform : marks[j].s,
          end
        );

        stop = Math.max(at, s + braking);
        x[BET] = 0;
        x[DWELLS] = platform === at ? DWELL : 0;
      }

      x[STOP] = stop;

      const reference =
        j >= marks.length && lately !== null
          ? lately
          : x[LEAVING]
            ? Math.max(v, x[CRUISE])
            : v;

      let want = Math.min(Math.max(reference, low), high, limits.top);

      if (Number.isNaN(stop)) {
        want = Math.max(want, CRAWL);
      } else {
        const left = Math.max(stop - s, 0);
        want = Math.max(
          Math.min(want, Math.sqrt(2 * limits.brake * left)),
          Math.min(CRAWL, left)
        );
      }

      if (x[LEAVING] && v >= want - 0.2) x[LEAVING] = 0;

      a = Math.min(
        Math.max((want - v) / RESPONSE, -limits.hardest),
        limits.accelerate,
        limits.power / v
      );

      if (!Number.isNaN(stop)) {
        // Braking for it, as evenly as it can.
        const left = stop - s;
        const needed = left > 0.01 ? (v * v) / (2 * left) : Infinity;

        if (needed >= limits.brake * 0.98) {
          a = Math.max(-needed, -limits.hardest);
        }
      }
    }

    // One step at that rate, stopping dead rather than going back.
    if (v + a * STEP <= 0 && a < 0) {
      const stopping = -v / a;
      x[S] = s + (v * stopping) / 2;
      x[V] = 0;
      x[STOOD] = t + stopping;
      x[STOP] = NaN;
      x[LEAVING] = 0;
    } else {
      x[S] = s + v * STEP + 0.5 * a * STEP * STEP;
      x[V] = Math.min(v + a * STEP, limits.top);
    }

    out.set(x, (from + step) * WIDTH);
  }
}

/**
 * A train's pace along `course`: carried on from `from` (an earlier pace,
 * `shift` m along from this course's distances, drawn up to `now`), or
 * from its first fix.
 */
export function fitPace(
  course: Course,
  limits: Limits,
  from?: { pace: Pace; shift: number; now: number }
): Pace | null {
  const marks = marksOf(course.fixes);

  if (!marks.length) return null;

  for (const station of course.stations) {
    let nearest: Mark | null = null;

    for (const mark of marks) {
      const off = Math.abs(mark.s - station);

      if (off < PLATFORM && off < Math.abs((nearest?.s ?? -Infinity) - station))
        nearest = mark;
    }

    if (nearest) nearest.stands = true;
  }

  // Samples carried on from before, and where the next goes.
  let carried = new Float64Array(0);
  let start: number;
  let state: Float64Array;

  if (from && from.now >= from.pace.start && from.pace.count > 0) {
    // What's been drawn stays as it was, and it goes on from there.
    const last = Math.min(
      Math.ceil((from.now - from.pace.start) / STEP),
      from.pace.count - 1
    );

    const first = Math.max(
      Math.floor((from.now - KEEP - from.pace.start) / STEP),
      0
    );

    carried = from.pace.samples.slice(first * WIDTH, last * WIDTH);

    for (let k = 0; k < carried.length; k += WIDTH) {
      carried[k + S] += from.shift;
      carried[k + STOP] += from.shift;
      carried[k + PASSED] += from.shift;
    }

    start = from.pace.start + first * STEP;
    state = from.pace.samples.slice(last * WIDTH, (last + 1) * WIDTH);
    state[S] += from.shift;
    state[PASSED] += from.shift;
    // Whatever it was braking for, it thinks again with what's new: the
    // end of its track may have moved on, or a fix come from past a stop.
    state[STOP] = NaN;
  } else {
    const [first] = marks;
    const last = marks[marks.length - 1];
    const middle = ({ early, late }: Mark) => (early + late) / 2;

    const average =
      marks.length > 1
        ? (last.s - first.s) / Math.max(middle(last) - middle(first), 1)
        : 0;

    // When in its first fix's time it was there: as fits most of the next
    // fixes at a steady speed, near the average, and the middle of it.
    let best = { cost: Infinity, time: middle(first), speed: 0 };

    for (let time = first.early; time <= first.late; time += 1) {
      const [low, high, reach] = band(
        marks,
        1,
        first.s,
        time,
        Infinity,
        limits.brake,
        Math.max(average, SET_OFF)
      );

      const speed = Math.min(Math.max(average, low), high, limits.top);

      const cost =
        -reach * 1000 +
        Math.abs(speed - average) * 10 +
        Math.abs(time - middle(first));

      if (cost < best.cost) best = { cost, time, speed };
    }

    start = best.time;
    const { speed } = best;
    const moving = speed >= CRAWL;
    state = new Float64Array(WIDTH);
    state[S] = first.s;
    state[V] = moving ? speed : 0;
    state[STOP] = NaN;
    state[STOOD] = moving ? NaN : start - DWELL;
    state[CRUISE] = average >= CRAWL ? Math.min(average, limits.top) : 0;
    state[PASSED] = -Infinity;
  }

  const held = carried.length / WIDTH;
  const time = start + held * STEP;

  const until =
    Math.max(marks[marks.length - 1].late, from?.now ?? -Infinity) + AFTER;

  const steps = Math.max(Math.ceil((until - time) / STEP), 1);
  const samples = new Float64Array((held + 1 + steps) * WIDTH);
  samples.set(carried);
  samples.set(state, held * WIDTH);
  drive(course, marks, limits, state, time, steps, samples, held + 1);

  return { start, count: held + 1 + steps, samples };
}

/** How far along a train is at `time`, by its pace. */
export function paceDistance(pace: Pace, time: number) {
  const { start, count, samples } = pace;
  const at = Math.min(Math.max((time - start) / STEP, 0), count - 1);
  const k = Math.min(Math.floor(at), count - 2);

  if (k < 0) return samples[S];
  const s0 = samples[k * WIDTH + S];
  const s1 = samples[(k + 1) * WIDTH + S];
  const v0 = samples[k * WIDTH + V];
  const v1 = samples[(k + 1) * WIDTH + V];
  const tau = (at - k) * STEP;
  const s = s0 + v0 * tau + (0.5 * (v1 - v0) * tau * tau) / STEP;

  return Math.min(Math.max(s, s0), s1);
}

/** How fast a train's going at `time`, by its pace. */
export function paceSpeed(pace: Pace, time: number) {
  const { start, count, samples } = pace;
  const at = Math.min(Math.max((time - start) / STEP, 0), count - 1);
  const k = Math.min(Math.floor(at), count - 2);

  if (k < 0) return samples[V];
  const v0 = samples[k * WIDTH + V];
  const v1 = samples[(k + 1) * WIDTH + V];

  return v0 + (v1 - v0) * (at - k);
}

/**
 * When a train first gets `distance` along, by its pace: NaN if that's
 * before it starts, or further than it gets.
 */
export function paceTime(pace: Pace, distance: number) {
  const { start, count, samples } = pace;

  if (!count || distance < samples[S]) return NaN;

  if (distance > samples[(count - 1) * WIDTH + S]) return NaN;
  let lo = 0;
  let hi = count - 1;

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;

    if (samples[mid * WIDTH + S] < distance) lo = mid;
    else hi = mid;
  }

  const a = samples[lo * WIDTH + S];
  const b = samples[hi * WIDTH + S];

  if (a >= distance) return start + lo * STEP;

  return start + (lo + (distance - a) / (b - a || 1)) * STEP;
}
