import { describe, expect, it } from "vitest";
import {
  easedDistance,
  easedTime,
  easeSlopes,
} from "../../src/components/scene/buses/ease";
import { distanceAt } from "../../src/components/scene/trains/run";

// A bus eased through its fixes (buses/ease.ts) on a monotone cubic, not
// drawn straight from one to the next.

type Fixes = { s: number; time: number }[];

/** Fixes from [distance, time] pairs. */
const fixes = (pairs: [number, number][]): Fixes =>
  pairs.map(([s, time]) => ({ s, time }));

const at = (f: Fixes, time: number) => easedDistance(f, easeSlopes(f), time);

/** Speed by the curve's own difference, just before or after `time`. */
const speed = (f: Fixes, time: number, side: -1 | 1) => {
  const h = 1e-4;

  return side < 0
    ? (at(f, time) - at(f, time - h)) / h
    : (at(f, time + h) - at(f, time)) / h;
};

/** Every 0.1 s from the first fix to the last. */
const times = (f: Fixes) =>
  Array.from(
    { length: Math.round((f.at(-1)!.time - f[0].time) * 10) + 1 },
    (_, k) => f[0].time + k / 10
  );

// Speeding up from 10 m/s to 15, a stand, then away again.
const BUS = fixes([
  [100, 10],
  [300, 30],
  [600, 50],
  [600, 70],
  [750, 90],
  [1050, 110],
]);

describe("easing a bus through its fixes", () => {
  it("passes through every fix exactly", () => {
    for (const { s, time } of BUS) expect(at(BUS, time)).toBeCloseTo(s, 9);
  });

  it("never goes back, for fixes that don't", () => {
    let last = -Infinity;

    for (const time of times(BUS)) {
      const s = at(BUS, time);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it("carries its speed on through a fix, without a step", () => {
    for (const { time } of BUS.slice(1, -1)) {
      expect(speed(BUS, time, -1)).toBeCloseTo(speed(BUS, time, 1), 2);
    }

    // Straight between them, it would step from 10 m/s to 15 at the fix.
    const straight = (time: number) => distanceAt({ fixes: BUS }, time);
    expect(straight(30) - straight(29.9)).toBeCloseTo(1, 6);
    expect(straight(30.1) - straight(30)).toBeCloseTo(1.5, 6);
  });

  it("comes to a stand at a fix without overshooting it, and stands", () => {
    for (const time of times(BUS)) {
      if (time <= 50) expect(at(BUS, time)).toBeLessThanOrEqual(600);
    }

    for (let time = 50; time <= 70; time += 0.5) {
      expect(at(BUS, time)).toBe(600);
    }

    expect(speed(BUS, 50, -1)).toBeCloseTo(0, 2);
    expect(speed(BUS, 70, 1)).toBeCloseTo(0, 2);
  });

  it("is the straight blend with only two fixes", () => {
    const two = fixes([
      [0, 0],
      [300, 25],
    ]);

    for (const time of times(two)) {
      expect(at(two, time)).toBeCloseTo(distanceAt({ fixes: two }, time), 9);
    }
  });

  it("is the straight blend at a steady pace", () => {
    const steady = fixes([
      [0, 0],
      [200, 20],
      [400, 40],
      [600, 60],
    ]);

    for (const time of times(steady)) {
      expect(at(steady, time)).toBeCloseTo(
        distanceAt({ fixes: steady }, time),
        9
      );
    }
  });

  it("stays sane over a long gap", () => {
    // Fixes 20 s apart, then nothing for two minutes.
    const gap = fixes([
      [0, 0],
      [200, 20],
      [1400, 140],
      [1600, 160],
    ]);

    let last = -Infinity;

    for (const time of times(gap)) {
      const s = at(gap, time);
      expect(s).toBeGreaterThanOrEqual(last);
      expect(s).toBeLessThanOrEqual(1600);
      last = s;
    }

    expect(at(gap, 80)).toBeGreaterThan(200);
    expect(at(gap, 80)).toBeLessThan(1400);
  });

  it("stands through repeated distances", () => {
    const repeats = fixes([
      [0, 0],
      [150, 20],
      [150, 40],
      [150, 60],
      [300, 80],
    ]);

    for (let time = 20; time <= 60; time += 1) {
      expect(at(repeats, time)).toBe(150);
    }

    expect(easedTime(repeats, easeSlopes(repeats), 150, false)).toBe(20);
    expect(easedTime(repeats, easeSlopes(repeats), 150, true)).toBe(60);
  });

  it("times its trail by the same curve, so the trail ends at the bus", () => {
    const slopes = easeSlopes(BUS);

    for (const d of [150, 250, 420, 650, 900]) {
      const reached = easedTime(BUS, slopes, d, false);
      expect(easedDistance(BUS, slopes, reached)).toBeCloseTo(d, 6);
      expect(easedTime(BUS, slopes, d, true)).toBe(reached);
    }

    expect(easedTime(BUS, slopes, 50, false)).toBeNaN();
    expect(easedTime(BUS, slopes, 1100, true)).toBeNaN();
  });
});
