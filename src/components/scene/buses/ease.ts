// Where a bus is between its fixes: eased through them, not straight from
// one to the next. Buses report their own times (every 20 s as kept, 25 s
// at the 90th percentile, 30 s at the 99th: a weekday peak, 2026-11-27),
// so the fixes are right; drawn straight between them, though, a bus's
// speed steps every time it passes one. Through them on a monotone cubic
// (Fritsch–Carlson's, as PCHIP), its speed runs on smoothly through each
// fix, it never overshoots one or goes back, and a bus that stood between
// two fixes at the same place stands there.

/** A bus's fixes: distance along its run, m, and time, s. */
type Fixes = readonly { s: number; time: number }[];

/** The cubic's slope at each fix, m/s. */
export function easeSlopes(fixes: Fixes): number[] {
  const n = fixes.length;

  if (n < 2) return fixes.map(() => 0);

  const step = (k: number) => fixes[k + 1].time - fixes[k].time;
  const pace = (k: number) => (fixes[k + 1].s - fixes[k].s) / (step(k) || 1);

  return fixes.map((_, k) => {
    // At either end, the pace to or from it.
    if (k === 0) return pace(0);

    if (k === n - 1) return pace(n - 2);
    const before = pace(k - 1);
    const after = pace(k);

    // Standing either side, or turning about: still there.
    if (before <= 0 || after <= 0) return 0;

    // Between, a mean of the two weighted by how long each took, which
    // keeps the curve from overshooting either (Fritsch–Butland).
    const a = 2 * step(k) + step(k - 1);
    const b = step(k) + 2 * step(k - 1);

    return (a + b) / (a / before + b / after);
  });
}

/** The interval of `fixes` that `time` falls in, by its first fix. */
function intervalOf(fixes: Fixes, time: number) {
  let lo = 0;
  let hi = fixes.length - 1;

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;

    if (fixes[mid].time <= time) lo = mid;
    else hi = mid;
  }

  return lo;
}

/** The cubic between fixes `k` and `k + 1` at `time`. */
function cubic(fixes: Fixes, slopes: number[], k: number, time: number) {
  const a = fixes[k];
  const b = fixes[k + 1];
  const h = b.time - a.time;
  const t = (time - a.time) / h;
  const t2 = t * t;
  const t3 = t2 * t;

  return (
    (2 * t3 - 3 * t2 + 1) * a.s +
    (t3 - 2 * t2 + t) * h * slopes[k] +
    (-2 * t3 + 3 * t2) * b.s +
    (t3 - t2) * h * slopes[k + 1]
  );
}

/**
 * How far along a bus is at `time`, eased through its fixes by `slopes`:
 * at the first before them and the last after.
 */
export function easedDistance(fixes: Fixes, slopes: number[], time: number) {
  const last = fixes.length - 1;

  if (time <= fixes[0].time) return fixes[0].s;

  if (time >= fixes[last].time) return fixes[last].s;
  const k = intervalOf(fixes, time);

  // Within its fixes, as rounding can't put it outside them.
  return Math.min(
    Math.max(cubic(fixes, slopes, k, time), fixes[k].s),
    fixes[k + 1].s
  );
}

/**
 * When a bus eased through its fixes by `slopes` reached `distance` along
 * (`last` false) or left it (`last` true), s; NaN outside its fixes.
 * Within a hundredth of a metre of a fix is at it.
 */
export function easedTime(
  fixes: Fixes,
  slopes: number[],
  distance: number,
  last: boolean
) {
  const end = fixes.length - 1;

  if (distance < fixes[0].s - 0.01 || distance > fixes[end].s + 0.01) {
    return NaN;
  }

  // At a fix: the first time it's there, or the last.
  let k = last ? end : 0;

  if (last) {
    while (k > 0 && fixes[k].s > distance + 0.01) k--;
  } else {
    while (k < end && fixes[k].s < distance - 0.01) k++;
  }

  if (Math.abs(fixes[k].s - distance) <= 0.01) return fixes[k].time;

  // Between two: where the cubic gets there, which it does only once.
  const from = last ? k : k - 1;
  let lo = fixes[from].time;
  let hi = fixes[from + 1].time;

  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;

    if (cubic(fixes, slopes, from, mid) < distance) lo = mid;
    else hi = mid;
  }

  return (lo + hi) / 2;
}
