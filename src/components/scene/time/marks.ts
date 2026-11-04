import { type Metric, SLOT, type TimelineDay } from "../../../lib/timeline";
import { sunPosition } from "../sun";

// The time-travel timeline's marks, from the days /api/timeline serves:
// pure, so the drawing in TimeTravel.tsx is only geometry.

/** A point on a sparkline: the middle of its slots, and their value. */
export interface Point {
  time: number;
  value: number | null;
}

/** How slots are made one point when there are too many to draw. */
export type Combine = "mean" | "max";

/**
 * `day`'s `metric` as points `k` slots apart (each the `combine` of its
 * slots), so a point's never thinner than a pixel or two.
 */
export function points(
  day: TimelineDay,
  metric: Metric,
  k: number,
  combine: Combine
): Point[] {
  const series = day.series[metric];

  if (!series) return [];

  const found: Point[] = [];

  for (let i = 0; i < series.length; i += k) {
    found.push({
      time: day.start + (i + Math.min(k, series.length - i) / 2) * SLOT,
      value: reduce(series.slice(i, i + k), combine),
    });
  }

  return found;
}

function reduce(values: (number | null)[], combine: Combine) {
  const known = values.filter((value) => value !== null);

  if (!known.length) return null;

  return combine === "max"
    ? Math.max(...known)
    : known.reduce((a, b) => a + b, 0) / known.length;
}

/** The value `points` drew at `time` in `day`: its `k` slots' `combine`. */
export function valueAt(
  day: TimelineDay,
  metric: Metric,
  time: number,
  k: number,
  combine: Combine
) {
  const series = day.series[metric];

  if (!series || time < day.start || time >= day.end) return null;

  const i = Math.floor((time - day.start) / SLOT / k) * k;

  return reduce(series.slice(i, i + k), combine);
}

/** The point the most was out at; null if nothing was. */
export function peak(found: Point[]) {
  let best: Point | null = null;

  for (const point of found) {
    if (point.value !== null && point.value > (best?.value ?? 0)) best = point;
  }

  return best;
}

/** The lowest and highest point. */
export function extent(found: Point[]) {
  let low: Point | null = null;
  let high: Point | null = null;

  for (const point of found) {
    if (point.value === null) continue;

    if (point.value < (low?.value ?? Infinity)) low = point;

    if (point.value > (high?.value ?? -Infinity)) high = point;
  }

  return { low, high };
}

export interface Turn extends Point {
  value: number;
  kind: "high" | "low";
}

/**
 * Where `found` (in time order) turns: a high or low that's the highest or
 * lowest of everything within `within` ms either side, all of it known. For
 * the tide's highs and lows, which come about six hours apart.
 */
export function turns(found: Point[], within: number): Turn[] {
  const result: Turn[] = [];

  for (let i = 0; i < found.length; i++) {
    const { time, value } = found[i];

    if (value === null) continue;

    let high = true;
    let low = true;
    let first = i;
    let last = i;

    while (first > 0 && found[first - 1].time >= time - within) first--;

    while (last < found.length - 1 && found[last + 1].time <= time + within) {
      last++;
    }

    // Not enough known around it to say.
    if (
      found[first].time > time - within * 0.9 ||
      found[last].time < time + within * 0.9
    ) {
      continue;
    }

    for (let j = first; j <= last && (high || low); j++) {
      const other = found[j].value;

      if (other === null) {
        high = low = false;
      } else if (j !== i) {
        // Of a level run, the first.
        if (j < i ? other >= value : other > value) high = false;

        if (j < i ? other <= value : other < value) low = false;
      }
    }

    if (high) result.push({ time, value, kind: "high" });
    else if (low) result.push({ time, value, kind: "low" });
  }

  return result;
}

/** The sun's centre at the horizon, refraction and all, degrees. */
const HORIZON = -0.833;

const SUN_STEP = 5 * 60_000;

export interface SunTimes {
  rise: number | null;
  set: number | null;
}

/** When the sun rose and set in Wellington between `start` and `end`. */
export function sunTimes(start: number, end: number): SunTimes {
  let rise: number | null = null;
  let set: number | null = null;
  let before = sunPosition(new Date(start)).altitude;

  for (let t = start + SUN_STEP; t <= end; t += SUN_STEP) {
    const altitude = sunPosition(new Date(t)).altitude;

    if (before < HORIZON !== altitude < HORIZON) {
      const at =
        t - SUN_STEP + ((HORIZON - before) / (altitude - before)) * SUN_STEP;

      if (altitude > before) rise ??= at;
      else set = at;
    }

    before = altitude;
  }

  return { rise, set };
}

const fixed = (n: number) => n.toFixed(1);

/** Half the width a point known on its own is drawn, px. */
const LONE = 1.5;

/** Each run of known points in `found`. */
function runs(found: Point[]) {
  const all: { time: number; value: number }[][] = [];
  let run: { time: number; value: number }[] = [];

  for (const { time, value } of found) {
    if (value === null) {
      if (run.length) all.push(run);
      run = [];
    } else {
      run.push({ time, value });
    }
  }

  if (run.length) all.push(run);

  return all;
}

/**
 * An SVG path through `found`, broken where it's unknown. A point known on
 * its own (the first minutes after a gap) is a short level stroke, or it
 * wouldn't show at all.
 */
export function linePath(
  found: Point[],
  x: (time: number) => number,
  y: (value: number) => number
) {
  return runs(found)
    .map((run) => {
      if (run.length === 1) {
        const [{ time, value }] = run;

        return `M${fixed(x(time) - LONE)} ${fixed(y(value))}L${fixed(x(time) + LONE)} ${fixed(y(value))}`;
      }

      return run
        .map(
          ({ time, value }, i) =>
            `${i ? "L" : "M"}${fixed(x(time))} ${fixed(y(value))}`
        )
        .join("");
    })
    .join("");
}

/**
 * An SVG path filling under `found` down to `base`, broken where it's
 * unknown, each run closed by itself; a point on its own as wide as
 * linePath draws it.
 */
export function areaPath(
  found: Point[],
  x: (time: number) => number,
  y: (value: number) => number,
  base: number
) {
  return runs(found)
    .map((run) => {
      const edges =
        run.length === 1
          ? [
              { ...run[0], at: x(run[0].time) - LONE },
              { ...run[0], at: x(run[0].time) + LONE },
            ]
          : run.map((point) => ({ ...point, at: x(point.time) }));

      const first = fixed(edges[0].at);
      const last = fixed(edges[edges.length - 1].at);

      return (
        `M${first} ${fixed(base)}` +
        edges
          .map(({ at, value }) => `L${fixed(at)} ${fixed(y(value))}`)
          .join("") +
        `L${last} ${fixed(base)}Z`
      );
    })
    .join("");
}
