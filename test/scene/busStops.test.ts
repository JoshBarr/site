import { describe, expect, it } from "vitest";
import { pullInAtStops } from "../../src/components/scene/buses/side";
import type { Point } from "../../src/components/scene/trains/network";

// Metlink's shapes go out to each stop's pole and straight back: here 300 m
// north (north is -z, east +x), calling at a stop 7 m off to the west, the
// kerb side, 150 m up, with the point it comes back to given twice.
const ROAD: Point[] = [
  [0, 5, 0],
  [0, 5, -100],
  [0, 5, -150],
  [-7, 5, -150],
  [0, 5, -150],
  [0, 5, -150.1],
  [0, 5, -300],
];

/** Where the way is `d` m along it, and the way a bus there faces. */
function along(points: Point[], d: number) {
  let s = 0;

  for (let i = 1; i < points.length; i++) {
    const [ax, , az] = points[i - 1];
    const [bx, , bz] = points[i];
    const length = Math.hypot(bx - ax, bz - az);

    if (s + length >= d) {
      const t = (d - s) / length;

      return [ax + (bx - ax) * t, az + (bz - az) * t];
    }

    s += length;
  }

  return points.at(-1)!.filter((_, k) => k !== 1);
}

/** Degrees off north a 12.5 m bus faces with its middle `d` m along. */
function offNorth(points: Point[], d: number) {
  const [fx, fz] = along(points, d + 6.25);
  const [bx, bz] = along(points, d - 6.25);

  return Math.abs((Math.atan2(fx - bx, -(fz - bz)) * 180) / Math.PI);
}

describe("a bus route's stops", () => {
  const way = pullInAtStops(ROAD);

  it("aren't driven out to the pole and back", () => {
    expect(Math.min(...way.map(([x]) => x))).toBeGreaterThan(-3);

    for (let d = 10; d < 290; d += 1) {
      expect(offNorth(way, d)).toBeLessThan(12);
    }
  });

  it("are pulled in to, toward the kerb", () => {
    // At the kerb from behind the pole to just past it.
    for (const z of [-136, -142, -150, -152]) {
      const [x] = way.reduce((a, b) =>
        Math.abs(b[2] - z) < Math.abs(a[2] - z) ? b : a
      );

      expect(x).toBeCloseTo(-2.5, 1);
    }
  });

  it("leave the road as it was away from them", () => {
    for (const [x, y, z] of way) {
      if (z > -100 || z < -180) expect(x).toBeCloseTo(0, 5);
      expect(y).toBe(5);
    }

    expect(way[0]).toEqual([0, 5, 0]);
    expect(way.at(-1)).toEqual([0, 5, -300]);
  });

  it("pull in only as far as the pole is out", () => {
    const near = pullInAtStops([
      [0, 5, 0],
      [0, 5, -150],
      [-5, 5, -150],
      [0, 5, -150],
      [0, 5, -300],
    ]);

    expect(Math.min(...near.map(([x]) => x))).toBeCloseTo(-1, 1);
  });

  it("pull in to the right on a road with stops on that side", () => {
    const right = pullInAtStops(ROAD.map(([x, y, z]): Point => [-x, y, z]));

    expect(Math.max(...right.map(([x]) => x))).toBeCloseTo(2.5, 1);
  });

  it("leave a way with no stops on it alone", () => {
    const plain: Point[] = [
      [0, 5, 0],
      [0, 5, -100],
      [50, 5, -150],
    ];

    expect(pullInAtStops(plain)).toEqual(plain);
  });

  it("leave turning round at the end of a road alone", () => {
    const turn: Point[] = [
      [0, 5, 0],
      [0, 5, -100],
      [0, 5, 0],
    ];

    expect(pullInAtStops(turn)).toEqual(turn);
  });
});
