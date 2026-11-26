import { describe, expect, it } from "vitest";
import {
  type Course,
  fitPace,
  HAULED_LIMITS,
  type Limits,
  MATANGI_LIMITS,
  marksOf,
  type Pace,
  paceDistance,
  paceSpeed,
  paceTime,
} from "../../src/components/scene/trains/pace";
import { Vector3 } from "three/webgpu";
import { arrival } from "../../src/components/scene/trains/crossingWatch";
import {
  type NetworkFile,
  RailNetwork,
} from "../../src/components/scene/trains/network";
import {
  distanceAt,
  drive,
  follow,
  pointAt,
  type Routes,
  shiftBetween,
  stationsAlong,
} from "../../src/components/scene/trains/run";
import type { Train } from "../../src/lib/trains";
import { RECORDED } from "../fixtures/trainFixes";
import { originIndex } from "../fixtures/terrain";

// A train driven between its fixes by what a train can do (pace.ts), not
// drawn straight between them by their stamps, which are the batch's time,
// not when the train was there.

/** pace.ts's samples are this far apart, s. */
const STEP = 0.5;

/** Distances along, m, per 30 s, of a Hutt train in the raw feed (2026-11-21). */
const MEASURED = [796, 0, 727, 46, 815, 398];

/** Fixes every 30 s from 0 m at 0 s, each `steps` m on from the last. */
function every30(steps: number[]): Course["fixes"] {
  let s = 0;

  return [
    { s: 0, time: 0 },
    ...steps.map((step, i) => ({ s: (s += step), time: 30 * (i + 1) })),
  ];
}

/** Where and how fast a pace has a train at each sample in [from, to]. */
function walk(pace: Pace, from = pace.start, to = Infinity) {
  const last = Math.min(pace.start + (pace.count - 1) * STEP, to);
  const samples: { time: number; s: number; v: number }[] = [];

  for (let time = Math.max(from, pace.start); time <= last; time += STEP) {
    samples.push({
      time,
      s: paceDistance(pace, time),
      v: paceSpeed(pace, time),
    });
  }

  return samples;
}

/**
 * It never goes back, nor over line speed, nor harder than it can, from
 * `from` to `to`, s.
 */
function expectPhysical(
  pace: Pace,
  limits: Limits,
  from?: number,
  to?: number
) {
  const samples = walk(pace, from, to);

  for (let k = 1; k < samples.length; k++) {
    const a = samples[k - 1];
    const b = samples[k];
    expect(b.s).toBeGreaterThanOrEqual(a.s);
    expect(b.v).toBeLessThanOrEqual(limits.top + 1e-9);
    expect(b.v).toBeGreaterThanOrEqual(0);
    expect(Math.abs(b.v - a.v) / STEP).toBeLessThanOrEqual(
      Math.max(limits.accelerate, limits.hardest) + 1e-6
    );
  }
}

/** Times a train stood still, and where. */
function stands(pace: Pace, from?: number, to?: number) {
  return walk(pace, from, to).filter(({ v }) => v === 0);
}

/**
 * How far outside each fix's window, s, a train is at its place: from
 * reaching it to leaving it, if it stood there.
 */
function misses(pace: Pace, fixes: Course["fixes"]) {
  return marksOf(fixes).map(({ s, early, late }) => {
    const reached = paceTime(pace, s - 0.5);
    const left = paceTime(pace, s + 0.5);

    if (Number.isNaN(reached)) return 0;

    return Math.max(reached - late, early - (left || Infinity), 0);
  });
}

describe("pace", () => {
  const fixes = every30(MEASURED);

  it("would have the measured train stand mid-track by its stamps", () => {
    // The old way: straight between fixes at their stamps.
    expect(distanceAt({ fixes }, 40)).toBe(distanceAt({ fixes }, 55));
  });

  it("drives the measured train on without standing or racing", () => {
    const pace = fitPace({ fixes, stations: [], end: 10_000 }, MATANGI_LIMITS)!;

    expectPhysical(pace, MATANGI_LIMITS);
    expect(stands(pace, pace.start, 180)).toEqual([]);

    // At much the same speed all the way: about 50 km/h, not 95.
    const speeds = walk(pace, pace.start, 180).map(({ v }) => v);
    expect(Math.max(...speeds) / Math.min(...speeds)).toBeLessThan(1.5);

    // Each place passed in the 30 s before its stamp, to within a step.
    for (const miss of misses(pace, fixes)) {
      expect(miss).toBeLessThanOrEqual(STEP);
    }
  });

  it("takes a repeat of a place as saying nothing", () => {
    const marks = marksOf(fixes);

    expect(marks.map(({ s }) => s)).toEqual([0, 796, 1523, 1569, 2384, 2782]);
    // Each was taken some time in the 30 s before its stamp.
    expect(marks[2]).toMatchObject({ early: 60, late: 90 });
  });

  it("widens a fix's time when the feed lost the train before it", () => {
    const [, mark] = marksOf([
      { s: 0, time: 0 },
      { s: 3000, time: 150 },
    ]);

    expect(mark).toMatchObject({ early: 0, late: 150 });
  });

  it("stops at a station it stood at, and nowhere else", () => {
    // 15 m/s, standing at the station at 1500 m through two batches.
    const stopping = every30([450, 450, 450, 150, 0, 60, 420, 450]);
    const course = { fixes: stopping, stations: [1490], end: 10_000 };
    const pace = fitPace(course, MATANGI_LIMITS)!;
    expectPhysical(pace, MATANGI_LIMITS);

    const stood = stands(pace, pace.start, 240);
    expect(stood.length * STEP).toBeGreaterThanOrEqual(15);

    for (const { s } of stood) expect(Math.abs(s - 1500)).toBeLessThan(1);

    for (const miss of misses(pace, stopping)) {
      expect(miss).toBeLessThanOrEqual(2);
    }
  });

  it("runs through a station when there's no time to have stopped", () => {
    const express = every30([450, 450, 450, 450, 450, 450, 450]);
    const course = { fixes: express, stations: [1500], end: 10_000 };
    const pace = fitPace(course, MATANGI_LIMITS)!;

    expectPhysical(pace, MATANGI_LIMITS);
    expect(stands(pace, pace.start, 210)).toEqual([]);
  });

  it("past its newest fix, keeps its pace, then stops where its track ends", () => {
    const pace = fitPace(
      { fixes: every30([450, 450, 450]), stations: [], end: 2500 },
      MATANGI_LIMITS
    )!;

    expectPhysical(pace, MATANGI_LIMITS);
    expect(paceSpeed(pace, 100)).toBeCloseTo(15, 0);

    const stood = stands(pace);
    expect(stood.length).toBeGreaterThan(0);

    for (const { s } of stood) expect(s).toBeCloseTo(2500, 0);
  });

  it("stands when held, not creeping", () => {
    // Standing at 1350 m through five batches, then 60 m on: held at a
    // signal.
    const held = every30([450, 450, 450, 0, 0, 0, 0, 0, 60]);

    const pace = fitPace(
      { fixes: held, stations: [], end: 10_000 },
      MATANGI_LIMITS
    )!;

    expectPhysical(pace, MATANGI_LIMITS);
    expect(stands(pace, 90, 270).length * STEP).toBeGreaterThan(60);
  });

  it("goes on from where it's been drawn to without a jump", () => {
    const course = { fixes: fixes.slice(0, 5), stations: [], end: 10_000 };
    const before = fitPace(course, MATANGI_LIMITS)!;
    const now = 101.3;

    // The next batch, and every distance 100 m further along, as when a
    // train's oldest fixes have dropped off its trail.
    const shifted = fixes.map(({ s, time }) => ({ s: s + 100, time }));

    const after = fitPace(
      { fixes: shifted, stations: [], end: 10_100 },
      MATANGI_LIMITS,
      { pace: before, shift: 100, now }
    )!;

    for (let time = now - 60; time <= now; time += 0.1) {
      expect(paceDistance(after, time)).toBeCloseTo(
        paceDistance(before, time) + 100,
        6
      );
    }

    expect(paceSpeed(after, now)).toBeCloseTo(paceSpeed(before, now), 6);
    expectPhysical(after, MATANGI_LIMITS);
  });

  it("drives Metlink's recorded trains as trains can go", () => {
    for (const { line, fixes: recorded, stations } of RECORDED) {
      const course = {
        fixes: recorded.map(([s, time]) => ({ s, time })),
        stations,
        end: recorded[recorded.length - 1][0] + 5000,
      };

      const limits = line === "WRL" ? HAULED_LIMITS : MATANGI_LIMITS;
      const pace = fitPace(course, limits)!;
      expectPhysical(pace, limits);

      // Standing only at its stations.
      for (const { s } of stands(pace, pace.start, recorded.at(-1)![1])) {
        expect(stations.some((at) => Math.abs(at - s) < 80)).toBe(true);
      }

      // Where its fixes are too close for any train to have kept to them
      // all, it's at worst a few seconds late (measured: under 4 s).
      for (const miss of misses(pace, course.fixes)) {
        expect(miss).toBeLessThan(5);
      }
    }
  });

  it("drives them on fix by fix, as the scene does, without a jump", () => {
    // Fixes reaching the page 40 s after their stamps, polled every 10 s,
    // drawn 60 s behind, three minutes of them at a time (lib/trains.ts's
    // TRAIL).
    for (const { line, fixes: recorded, stations } of RECORDED) {
      const limits = line === "WRL" ? HAULED_LIMITS : MATANGI_LIMITS;
      let pace: Pace | null = null;
      let drawn = -Infinity;
      let speed = 0;
      let at = 0;

      for (let poll = 40; poll < recorded.at(-1)![1] + 60; poll += 10) {
        const known = recorded
          .filter(([, time]) => time <= poll - 40 && time > poll - 220)
          .map(([s, time]) => ({ s, time }));

        const now = poll - 60;

        pace = fitPace(
          { fixes: known, stations, end: known.at(-1)!.s + 5000 },
          limits,
          pace ? { pace, shift: 0, now } : undefined
        )!;

        // Where it was last drawn, it still is.
        if (drawn > -Infinity) {
          expect(paceDistance(pace, drawn)).toBeCloseTo(at, 6);
          expect(paceSpeed(pace, drawn)).toBeCloseTo(speed, 6);
        }

        // As far as it's drawn before the next poll; standing only at its
        // stations, once it's first got going.
        expectPhysical(pace, limits, now, now + 10);

        if (now > 120) {
          for (const { s } of stands(pace, now, now + 10)) {
            expect(stations.some((at) => Math.abs(at - s) < 80)).toBe(true);
          }
        }

        drawn = now + 9.9;
        at = paceDistance(pace, drawn);
        speed = paceSpeed(pace, drawn);
      }
    }
  });
});

describe("pace along a run", () => {
  // A straight run east from the origin, a point every 10 m.
  const points = Array.from(
    { length: 101 },
    (_, k): [number, number, number] => [k * 10, 0, 0]
  );

  const s = points.map(([x]) => x);

  it("finds the stations on a run's line", () => {
    expect(
      stationsAlong({ points, s }, [
        [705, 12],
        [250, -8],
        [400, 60],
      ])
    ).toEqual([250, 705]);
  });

  it("lines up the same train's runs by a fix they share", () => {
    const before = [
      { s: 0, time: 0 },
      { s: 400, time: 30 },
    ];

    // The first dropped off, distances counted from the second; times
    // shifted a little by the page's clock.
    const run = [
      { s: 0, time: 30.2 },
      { s: 450, time: 60.2 },
    ];

    expect(shiftBetween(before, run)).toBe(-400);
    expect(shiftBetween(before, [{ s: 0, time: 90 }])).toBeNull();
  });

  it("has level crossings see a driven train coming by its pace", () => {
    const pace = fitPace(
      { fixes: every30([450, 450, 450]), stations: [], end: 10_000 },
      MATANGI_LIMITS
    )!;

    const run = { fixes: [], length: 80, pace };
    // A crossing 1200 m along, 5 m either side of its middle: the front's
    // there when the middle's 1155 m along.
    const eta = arrival(run, 1200, 5, 40, 40);

    expect(eta).toBeCloseTo(paceTime(pace, 1155) - 40, 6);
    expect(arrival(run, 1200, 5, 40, 40)).toBeGreaterThan(0);
  });
});

describe("a train driven along its run", () => {
  // A single track 3 km north from the origin, ending at buffers; world z
  // is south.
  const tracks: NetworkFile = {
    flags: { tunnel: 1, bridge: 2, model: 4 },
    nodes: Array.from({ length: 16 }, (_, k) => [0, k * 200, 10]).flat(),
    ways: [[0, ...Array.from({ length: 16 }, (_, k) => k)]],
    platforms: [],
  };

  const index = originIndex();
  const network = new RailNetwork(tracks, index);
  const EPOCH = 1_700_000_000_000;
  const routes: Routes = (_key, find) => find();

  /** A Hutt train heard at each of `fixes`: northing, s after EPOCH. */
  function run(fixes: [number, number][]) {
    const trail = fixes.map(([n, s]): [number, number, number] => [
      0,
      n,
      EPOCH + s * 1000,
    ]);

    const train: Train = {
      id: "4241",
      line: "HVL",
      direction: 0,
      position: [0, fixes.at(-1)![0]],
      bearing: 0,
      time: trail.at(-1)![2],
      trail,
    };

    return follow(train, network, index, EPOCH, routes, false)!;
  }

  // A station 1300 m up the line, 6 m off it.
  const stations: [number, number][] = [[6, -1300]];

  it("goes on from the run before, wherever its distances start", () => {
    const before = run([
      [400, 20],
      [1000, 50],
    ]);

    drive(before, stations, undefined, 45);

    // A poll later: the oldest fix has gone, so it's counted from 1000 m.
    const after = run([
      [1000, 50],
      [1300, 80],
    ]);

    drive(after, stations, before, 55);
    expect(after.pace).toBeDefined();

    const was = new Vector3();
    const is = new Vector3();

    for (let time = 30; time <= 55; time += 0.5) {
      pointAt(before, distanceAt(before, time), was);
      pointAt(after, distanceAt(after, time), is);
      expect(is.distanceTo(was)).toBeLessThan(1e-3);
    }
  });

  it("times its trail by its pace, as far as it's soon to get", () => {
    const driven = run([
      [400, 20],
      [1000, 50],
      [1600, 80],
    ]);

    drive(driven, stations, undefined, 60);
    const timed = driven.times.filter((time) => !Number.isNaN(time));

    expect(timed.length).toBeGreaterThan(2);
    expect(Math.max(...timed)).toBeLessThanOrEqual(90);

    for (let k = 1; k < timed.length; k++) {
      expect(timed[k]).toBeGreaterThanOrEqual(timed[k - 1]);
    }
  });

  it("stands short of the buffers when its fixes run out", () => {
    const driven = run([
      [1800, 20],
      [2400, 50],
    ]);

    drive(driven, [], undefined, 60);
    const { pace, length } = driven;
    const end = driven.s.at(-1)!;
    const last = paceDistance(pace!, 1000);

    expect(paceSpeed(pace!, 1000)).toBe(0);
    expect(last).toBeLessThanOrEqual(end - length / 2);
    expect(last).toBeGreaterThan(end - length / 2 - 10);
  });
});
