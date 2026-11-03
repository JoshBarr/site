import { describe, expect, it } from "vitest";
import { keepLeft } from "../../src/components/scene/buses/run";
import type { Point } from "../../src/components/scene/trains/network";

describe("keepLeft", () => {
  // North is -z, east +x.
  const north: Point[] = [
    [0, 5, 0],
    [0, 5, -10],
    [0, 5, -20],
  ];

  it("moves a way north over to the west, keeping its height", () => {
    expect(keepLeft(north, 2)).toEqual([
      [-2, 5, 0],
      [-2, 5, -10],
      [-2, 5, -20],
    ]);
  });

  it("puts the same road's two ways on opposite sides", () => {
    const south = keepLeft([...north].reverse(), 2);

    expect(south.map(([x]) => x)).toEqual([2, 2, 2]);
  });

  it("keeps a corner the full distance from both roads", () => {
    // North, then east: the corner's outside is to the north-west.
    const [, corner] = keepLeft(
      [
        [0, 0, 0],
        [0, 0, -10],
        [10, 0, -10],
      ],
      2
    );

    expect(corner[0]).toBeCloseTo(-2);
    expect(corner[2]).toBeCloseTo(-12);
  });

  it("takes a stop's repeated point's way from its neighbours", () => {
    const moved = keepLeft(
      [
        [0, 0, 0],
        [0, 0, -10],
        [0, 0, -10],
        [0, 0, -20],
      ],
      2
    );

    expect(moved.every(([x]) => Math.abs(x + 2) < 1e-9)).toBe(true);
  });

  it("leaves a way that never moves where it is", () => {
    const still: Point[] = [
      [3, 0, 4],
      [3, 0, 4],
    ];

    expect(keepLeft(still, 2)).toBe(still);
  });
});
