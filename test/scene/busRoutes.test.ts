import { describe, expect, it } from "vitest";
import {
  BusRoutes,
  IndexedShape,
} from "../../src/components/scene/buses/routes";
import { follow } from "../../src/components/scene/buses/run";
import { verticalScale } from "../../src/components/scene/terrain/Terrain";
import type { Point } from "../../src/components/scene/trains/network";
import type { Bus } from "../../src/lib/buses";
import { originIndex } from "../fixtures/terrain";

// Metlink's routes as the scene has them (public/buses/routes.json), and a
// bus's fixes put on its route. Here route 14 runs 500 m north up one road
// from the origin, then 300 m east along another; back the same way. World
// x is east, z south.

type Place = [easting: number, northing: number, height: number];

/**
 * routes.json's chains: decimetres, each point a step from the last, each
 * chain's first from the first of the chain before.
 */
function encode(chains: Place[][]) {
  let previous = [0, 0, 0];

  return chains.map((places) => {
    let last = previous;

    return places.flatMap((place, k) => {
      const q = place.map((v) => Math.round(v * 10));
      const step = q.map((v, i) => v - last[i]);

      if (k === 0) previous = q;
      last = q;

      return step;
    });
  });
}

const along = (from: Place, to: Place, steps: number): Place[] =>
  Array.from({ length: steps + 1 }, (_, k): Place => [
    from[0] + ((to[0] - from[0]) * k) / steps,
    from[1] + ((to[1] - from[1]) * k) / steps,
    from[2] + ((to[2] - from[2]) * k) / steps,
  ]);

const UP_THE_ROAD = along([0, 0, 10], [0, 500, 20], 5);
const ALONG_THE_TOP = along([0, 500, 20], [300, 500, 20], 3);

const routes = new BusRoutes(
  {
    chains: encode([UP_THE_ROAD, ALONG_THE_TOP]),
    // Chains by number from 1, each a step from the last; back is negative.
    shapes: [
      [1, 1],
      [-2, 1],
    ],
    routes: { "14": { name: "14 Wilton", directions: [[0], [1]] } },
  },
  originIndex()
);

const START = Date.parse("2026-11-03T08:00:00+13:00");

/** Route 14's bus heard at each of `fixes`: e, n, seconds after START. */
const bus = (
  fixes: [number, number, number][],
  { route = "14", direction = 0 } = {}
): Bus => {
  const trail = fixes.map(([e, n, s]): [number, number, number] => [
    e,
    n,
    START + s * 1000,
  ]);

  const [e, n, time] = trail.at(-1) ?? [0, 0, START];

  return {
    id: "2158",
    route,
    direction,
    position: [e, n],
    bearing: null,
    time,
    trail,
  };
};

const run = (
  b: Bus,
  heightAt: ((x: number, z: number) => number | undefined) | null = null
) => follow(b, routes, originIndex(), START, heightAt);

describe("bus routes", () => {
  it("are named as on the front of the bus", () => {
    expect(routes.nameOf("14")).toBe("14 Wilton");
    expect(routes.nameOf("999")).toBe("999");
  });

  it("put their chains together into the way each direction goes", () => {
    const [out] = routes.shapesFor("14", 0);
    const [back] = routes.shapesFor("14", 1);

    expect(out.points[0]).toEqual([0, 10 * verticalScale.value, -0]);
    expect(out.points.at(-1)).toEqual([300, 20 * verticalScale.value, -500]);
    expect(out.length).toBeCloseTo(800, 0);

    // The chain they share once, where they meet.
    expect(out.points).toHaveLength(6 + 3);
    expect(back.points.map(([x, , z]) => [x, z])).toEqual(
      out.points.map(([x, , z]) => [x, z]).reverse()
    );
  });

  it("have no ways for a route that isn't known", () => {
    expect(routes.shapesFor("999", 0)).toEqual([]);
  });
});

describe("a shape", () => {
  // Out 200 m east and back 2 m to the north.
  const outAndBack = new IndexedShape([
    [0, 0, 0],
    [200, 0, 0],
    [200, 0, -2],
    [0, 0, -2],
  ] satisfies Point[]);

  it("finds each pass by a point, nearest first", () => {
    const passes = outAndBack.near(50, -1.5, 10);

    expect(passes.map(({ s, distance }) => [Math.round(s), distance])).toEqual([
      [352, 0.5],
      [50, 1.5],
    ]);

    expect(passes[0].along).toEqual([-1, 0]);
  });

  it("finds nothing further than asked", () => {
    expect(outAndBack.near(50, 20, 10)).toEqual([]);
  });
});

describe("a bus followed along its route", () => {
  it("runs through its fixes at a steady pace, round the corner", () => {
    const r = run(
      bus([
        [1, 100, 10],
        [-1, 300, 30],
        [100, 501, 50],
      ])
    );

    expect(r?.fixes.map(({ s, time }) => [Math.round(s), time])).toEqual([
      [100, 10],
      [300, 30],
      [600, 50],
    ]);

    const at = (d: number) =>
      r?.s.findIndex((s) => Math.abs(s - d) < 0.5) ?? -1;

    expect(r?.arrived[at(200)]).toBeCloseTo(20, 1);
    expect(r?.left[at(200)]).toBeCloseTo(20, 1);
    // Ten metres either side to stand on, when it wasn't there.
    expect(r?.s[0]).toBeCloseTo(90, 1);
    expect(r?.arrived[0]).toBeNaN();
  });

  it("keeps to the left of the road", () => {
    const r = run(
      bus([
        [0, 100, 10],
        [0, 300, 30],
      ])
    );

    // Going north, on the west side.
    for (const [x] of r?.points ?? []) expect(x).toBeCloseTo(-1.6, 3);

    const back = run(
      bus(
        [
          [0, 300, 10],
          [0, 100, 30],
        ],
        { direction: 1 }
      )
    );

    for (const [x] of back?.points ?? []) expect(x).toBeCloseTo(1.6, 3);
  });

  it("waits at a stop, arriving and leaving at different times", () => {
    const r = run(
      bus([
        [0, 200, 10],
        [0, 200, 30],
        [0, 400, 50],
      ])
    );

    const stop = r?.s.findIndex((s) => Math.abs(s - 200) < 0.5) ?? -1;

    expect(r?.arrived[stop]).toBe(10);
    expect(r?.left[stop]).toBe(30);
  });

  it("holds a bus where it was when its fix wanders back", () => {
    const r = run(
      bus([
        [0, 300, 10],
        [0, 290, 20],
      ])
    );

    expect(r?.fixes.map(({ s }) => Math.round(s))).toEqual([300, 300]);
  });

  it("starts afresh from a fix it couldn't have got to", () => {
    const r = run(
      bus([
        [0, 100, 0],
        [250, 500, 2],
      ])
    );

    expect(r?.fixes.map(({ s, time }) => [Math.round(s), time])).toEqual([
      [750, 2],
    ]);
  });

  describe("off its route", () => {
    const detour: [number, number, number][] = [
      [150, 200, 10],
      [150, 300, 30],
    ];

    it("goes straight between its fixes, on the ground", () => {
      const r = run(bus(detour), () => 12);

      expect(r?.fixes.map(({ s, time }) => [Math.round(s), time])).toEqual([
        [0, 10],
        [100, 30],
      ]);

      expect(r?.points.every(([, y]) => y === 12)).toBe(true);
    });

    it("is nowhere without the ground to put it on", () => {
      expect(run(bus(detour))).toBeNull();
      expect(run(bus(detour), () => undefined)).toBeNull();
    });

    it("is nowhere for a route that isn't known, or without a fix", () => {
      expect(run(bus([[0, 100, 10]], { route: "999" }))).toBeNull();
      expect(run({ ...bus([[0, 100, 10]]), trail: [] }, () => 0)).toBeNull();
    });
  });
});
