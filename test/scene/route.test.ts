import { describe, expect, it } from "vitest";
import {
  type Departure,
  extend,
  type Runway,
} from "../../src/components/scene/flights/route";
import type { ToWorld } from "../../src/components/scene/flights/path";
import type { RouteEnd } from "../../src/lib/flights";

// Trails drawn on past what was seen of an aircraft, towards the end of its
// route: plausible, not a flight plan. World x is east, z south; headings
// are clockwise from north.

/** NZTM to world, about an origin of 0, 0. */
const toWorld: ToWorld = (e, n) => [e, -n];
const flat = () => 0;

const NORTH = 0;
const EAST = Math.PI / 2;
const SOUTH = Math.PI;

/** An airport `km` north of the origin, 10 m up, or unknown height. */
const airport = (km: number, elevation: number | null = 10): RouteEnd => ({
  code: "WLG",
  at: [0, km * 1000],
  elevation,
});

const at = (
  x: number,
  z: number,
  y: number,
  heading: number,
  climbing = false
): Departure => ({ x, y, z, heading, climbing });

const length = (points: [number, number, number][]) =>
  points.slice(1).reduce((sum, [x, , z], i) => {
    const [px, , pz] = points[i];

    return sum + Math.hypot(x - px, z - pz);
  }, 0);

describe("a trail drawn on to the end of a route", () => {
  it("isn't, within a km of it", () => {
    expect(
      extend(at(0, -500, 300, NORTH), airport(1), 10_000, toWorld, flat)
    ).toEqual([]);
  });

  it("comes straight down to the threshold, lined up on final", () => {
    const runway: Runway = { at: [0, -8000], course: NORTH };

    expect(
      extend(at(0, 0, 600, NORTH), airport(9), 10_000, toWorld, flat, runway)
    ).toEqual([
      [0, 600, 0],
      [0, 10, -8000],
    ]);
  });

  it("comes down abeam the airport, lined up without a runway", () => {
    // The airport's a little off to the right.
    const [start, end] = extend(
      { x: 0, y: 500, z: 0, heading: NORTH, climbing: false },
      { code: "WLG", at: [500, 8000], elevation: 10 },
      10_000,
      toWorld,
      flat
    );

    expect(start).toEqual([0, 500, 0]);
    expect(end[0]).toBeCloseTo(0, 6);
    expect(end[1]).toBe(10);
    expect(end[2]).toBeCloseTo(-8000, 6);
  });

  describe("further off, or not lined up", () => {
    // Heading east, the airport 40 km north.
    const points = extend(
      at(0, 0, 3000, EAST),
      airport(40),
      10_000,
      toWorld,
      flat
    );

    it("starts exactly where it was seen, leaving along its heading", () => {
      expect(points[0]).toEqual([0, 3000, 0]);

      const [x, , z] = points[1];
      expect(Math.atan2(x, -z)).toBeGreaterThan(EAST / 2);
    });

    it("curves round to the airport, never further than it needs", () => {
      const [x, , z] = points.at(-1) ?? [];

      expect(Math.hypot(x ?? NaN, (z ?? NaN) + 40_000)).toBeLessThan(1);
      expect(length(points)).toBeLessThan(40_000 * 1.6);

      for (const [, , pz] of points) expect(pz).toBeLessThanOrEqual(0);
    });

    it("comes down at no less than three degrees, to the airport's height", () => {
      expect(points.at(-1)?.[1]).toBeCloseTo(10, 6);

      for (let i = 1; i < points.length; i++) {
        expect(points[i][1]).toBeLessThanOrEqual(points[i - 1][1] + 1e-9);
      }
    });
  });

  it("joins the runway's extended centreline six km out, and comes down it", () => {
    // Landing south, from the west.
    const runway: Runway = { at: [0, -30_000], course: SOUTH };

    const points = extend(
      at(-20_000, -50_000, 3000, EAST),
      airport(30),
      10_000,
      toWorld,
      flat,
      runway
    );

    const last = points.at(-1);
    expect(last?.[0]).toBeCloseTo(0, 6);
    expect(last?.[2]).toBeCloseTo(-30_000, 6);

    // The last six km straight down the centreline.
    const final = points.filter(([, , z]) => z >= -36_000 - 1);

    for (const [x] of final) expect(Math.abs(x)).toBeLessThan(1);
  });

  it("climbs to cruise, if it was, and no higher", () => {
    // Bound somewhere far off, its height unknown.
    const points = extend(
      at(0, 0, 500, NORTH, true),
      airport(140, null),
      10_000,
      toWorld,
      flat
    );

    const heights = points.map(([, y]) => y);

    expect(heights[0]).toBe(500);
    expect(heights[1]).toBeGreaterThan(500);
    expect(Math.max(...heights)).toBe(10_000);
  });

  it("is drawn no further than 150 km", () => {
    const points = extend(
      at(0, 0, 10_000, NORTH),
      airport(2000, null),
      10_000,
      toWorld,
      flat
    );

    expect(length(points)).toBeLessThanOrEqual(150_000);
    expect(length(points)).toBeGreaterThan(145_000);
  });

  it("keeps clear of hills on the way, less so near the airport", () => {
    const ridge = (_x: number, z: number) =>
      z < -10_000 && z > -20_000 ? 800 : 0;

    const points = extend(
      at(0, 0, 500, NORTH),
      airport(40),
      10_000,
      toWorld,
      ridge
    );

    for (const [x, y, z] of points.slice(1)) {
      if (ridge(x, z)) expect(y).toBeGreaterThanOrEqual(800 + 150 - 1e-9);
    }

    expect(points.at(-1)?.[1]).toBeCloseTo(10, 6);
  });
});
