import { Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  type NetworkFile,
  type Point,
  RailNetwork,
  type Snap,
} from "../../src/components/scene/trains/network";
import {
  CARRIAGE,
  distanceAt,
  follow,
  GAP,
  isPeak,
  LOCOMOTIVE,
  MATANGI,
  pointAt,
  type Routes,
} from "../../src/components/scene/trains/run";
import type { Line, Train } from "../../src/lib/trains";
import { originIndex } from "../fixtures/terrain";

// The railway as a graph, and trains followed along it from fix to fix.
// Here: a double track running 2 km north from the origin (the down line
// to the west, the up line 4 m east), a branch off the down line at 1 km
// bearing north-east, and a line of its own 5 km east. World x is east and
// z south, so north is -z.

const NORTH: [number, number] = [0, -1];
const SOUTH: [number, number] = [0, 1];
const EAST: [number, number] = [1, 0];

/** Nodes along `e`, every 200 m from northing 0 to 2000. */
const line = (e: number) =>
  Array.from({ length: 11 }, (_, k) => [e, k * 200, 0]).flat();

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, k) => from + k);

const file: NetworkFile = {
  flags: { tunnel: 1, bridge: 2, model: 4 },
  nodes: [
    // Down: 0–10. Up: 11–21.
    ...line(0),
    ...line(4),
    // The branch: 22, 23.
    200,
    1200,
    0,
    400,
    1400,
    0,
    // Far off: 24, 25.
    5000,
    0,
    0,
    5000,
    2000,
    0,
  ],
  ways: [
    [0, ...range(0, 11)],
    [0, ...range(11, 11)],
    [0, 5, 22, 23],
    [0, 24, 25],
  ],
  platforms: [],
};

const index = originIndex();
const network = new RailNetwork(file, index);

/** The best place on the tracks for a fix at NZTM e, n. */
const snap = (
  e: number,
  n: number,
  heading: [number, number] | null = null
): Snap => {
  const [best] = network.candidates(e, -n, heading);

  if (!best) throw new Error(`no track near ${e}, ${n}`);

  return best.snap;
};

const lengthOf = (points: number[][]) =>
  points
    .slice(1)
    .reduce(
      (sum, [x, , z], k) =>
        sum + Math.hypot(x - points[k][0], z - points[k][2]),
      0
    );

describe("the railway", () => {
  describe("finding a fix's track", () => {
    it("lists the nearest place on each line, best first", () => {
      const found = network.candidates(2, -500, null);

      expect(found).toHaveLength(2);
      expect(found.map(({ snap: { x } }) => x).sort()).toEqual([0, 4]);
      expect(found.every(({ score }) => score === 2)).toBe(true);
    });

    it("keeps left: the down line northbound, the up line south", () => {
      expect(snap(2, 500, NORTH).x).toBe(0);
      expect(snap(2, 500, SOUTH).x).toBe(4);
    });

    it("would rather a track running the way the train's going", () => {
      const [across] = network.candidates(0, -500, EAST);

      expect(across.score).toBeGreaterThanOrEqual(25 - 2.5);
    });

    it("finds nothing more than 40 m off", () => {
      expect(network.candidates(100, -500, null)).toEqual([]);
      expect(network.candidates(30, -500, null)).toHaveLength(2);
    });
  });

  describe("the way from one place to another", () => {
    it("is along the same piece of track, straight", () => {
      expect(network.route(snap(0, 120), snap(0, 180), 1000)).toEqual([
        [0, 0, -120],
        [0, 0, -180],
      ]);
    });

    it("follows the line from piece to piece", () => {
      const way = network.route(
        snap(0, 100, NORTH),
        snap(0, 1500, NORTH),
        2000
      );

      expect(way).not.toBeNull();
      expect(lengthOf(way ?? [])).toBeCloseTo(1400, 3);
    });

    it("takes the branch through the turnout", () => {
      const way = network.route(snap(0, 100, NORTH), snap(300, 1300), 2000);

      expect(lengthOf(way ?? [])).toBeCloseTo(900 + 300 * Math.SQRT2, 3);
    });

    it("can't back off the branch up the other leg", () => {
      expect(
        network.route(snap(300, 1300), snap(0, 1500, NORTH), 5000)
      ).toBeNull();
      expect(
        network.route(snap(300, 1300), snap(0, 500, SOUTH), 5000)
      ).not.toBeNull();
    });

    it("is none longer than the limit, or onto another line", () => {
      expect(
        network.route(snap(0, 100, NORTH), snap(0, 1500, NORTH), 1000)
      ).toBeNull();
      expect(network.route(snap(0, 100), snap(5000, 100), 1e6)).toBeNull();
    });
  });

  describe("carrying on from a place", () => {
    it("goes as far as asked, the way asked", () => {
      expect(network.extend(snap(0, 900), SOUTH, 300).at(-1)).toEqual([
        0, 0, -600,
      ]);
    });

    it("keeps straight on past a turnout", () => {
      const ahead = network.extend(snap(0, 900), NORTH, 300);

      expect(ahead.at(-1)?.[0]).toBe(0);
      expect(ahead.at(-1)?.[2]).toBeCloseTo(-1200, 3);
    });

    it("stops where the track does", () => {
      expect(network.extend(snap(0, 1800), NORTH, 500).at(-1)).toEqual([
        0, 0, -2000,
      ]);
    });
  });
});

describe("a train followed along the tracks", () => {
  /** When the scene's clock started, epoch ms. */
  const EPOCH = Date.parse("2026-11-03T08:00:00+13:00");

  const found = new Map<string, Point[] | null>();

  const routes: Routes = (key, find) => {
    if (!found.has(key)) found.set(key, find());

    return found.get(key) ?? null;
  };

  /** A Kāpiti train heard at each of `fixes`: e, n, seconds after EPOCH. */
  const train = (
    fixes: [number, number, number][],
    line: Line = "KPL"
  ): Train => {
    const trail = fixes.map(([e, n, s]): [number, number, number] => [
      e,
      n,
      EPOCH + s * 1000,
    ]);

    const [e, n, time] = trail[trail.length - 1];

    return {
      id: "4123",
      line,
      direction: 1,
      position: [e, n],
      bearing: 0,
      time,
      trail,
    };
  };

  it("runs along the line through its fixes, at a steady pace between", () => {
    // A metre or two off the track, as GPS is.
    const run = follow(
      train([
        [1, 200, 10],
        [-1, 600, 30],
        [1.5, 1000, 50],
      ]),
      network,
      index,
      EPOCH,
      routes,
      false
    );

    expect(run?.fixes).toEqual([
      { s: 0, time: 10 },
      { s: expect.closeTo(400, 3), time: 30 },
      { s: expect.closeTo(800, 3), time: 50 },
    ]);

    if (!run) return;

    expect(distanceAt(run, 0)).toBe(0);
    expect(distanceAt(run, 20)).toBeCloseTo(200, 3);
    expect(distanceAt(run, 45)).toBeCloseTo(700, 3);
    expect(distanceAt(run, 60)).toBeCloseTo(800, 3);

    const at = new Vector3();

    expect(pointAt(run, 200, at).toArray()).toEqual([
      0,
      0,
      expect.closeTo(-400, 3),
    ]);

    // With track either side for the cars to stand on, not yet passed.
    expect(run.s[0]).toBeLessThan(0);
    expect(run.s.at(-1)).toBeGreaterThan(800);
    expect(run.times[0]).toBeNaN();
    expect(run.times.at(-1)).toBeNaN();
    expect(pointAt(run, -1e6, at).toArray()).toEqual(run.points[0]);
  });

  it("starts again from a fix it couldn't have got to", () => {
    const run = follow(
      train([
        [0, 200, 10],
        [5000, 1000, 30],
        [5000, 1400, 50],
      ]),
      network,
      index,
      EPOCH,
      routes,
      false
    );

    expect(run?.fixes).toEqual([
      { s: 0, time: 30 },
      { s: expect.closeTo(400, 3), time: 50 },
    ]);

    expect(run?.points.every(([x]) => x === 5000)).toBe(true);
  });

  it("is nowhere, away from the tracks", () => {
    expect(
      follow(train([[2500, 1000, 10]]), network, index, EPOCH, routes, false)
    ).toBeNull();
  });

  it("is made up as its line's trains are", () => {
    const consist = (line: Line, peak: boolean) => {
      const run = follow(
        train([[0, 500, 10]], line),
        network,
        index,
        EPOCH,
        routes,
        peak
      );

      return { cars: run?.cars, length: run?.length };
    };

    expect(consist("KPL", false)).toEqual({
      cars: Array(4).fill(MATANGI),
      length: expect.closeTo(4 * MATANGI.length + 3 * GAP, 9),
    });

    expect(consist("HVL", true).cars).toHaveLength(6);
    expect(consist("JVL", true).cars).toEqual([MATANGI, MATANGI]);
    expect(consist("MEL", false).cars).toEqual([MATANGI, MATANGI]);
    expect(consist("WRL", false).cars).toEqual([
      LOCOMOTIVE,
      ...Array(6).fill(CARRIAGE),
    ]);
  });
});

describe("the peaks", () => {
  // Tuesday 3 and Saturday 7 November 2026.
  const at = (time: string) => isPeak(new Date(`${time}+13:00`));

  it("are weekday mornings and evenings in Wellington", () => {
    expect(at("2026-11-03T06:59:00")).toBe(false);
    expect(at("2026-11-03T07:00:00")).toBe(true);
    expect(at("2026-11-03T08:59:00")).toBe(true);
    expect(at("2026-11-03T09:00:00")).toBe(false);
    expect(at("2026-11-03T16:00:00")).toBe(true);
    expect(at("2026-11-03T18:29:00")).toBe(true);
    expect(at("2026-11-03T18:30:00")).toBe(false);
  });

  it("aren't at the weekend", () => {
    expect(at("2026-11-07T08:00:00")).toBe(false);
  });
});
