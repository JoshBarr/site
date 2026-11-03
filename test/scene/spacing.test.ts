import { describe, expect, it } from "vitest";
import { createSpacing } from "../../src/components/scene/buses/spacing";

const LENGTH = 12.5;
const GAP = 2;

/** Buses as [x, z, heading x, heading z]. */
function resolve(buses: [number, number, number, number][]) {
  const spacing = createSpacing(buses.length);

  buses.forEach(([x, z, dx, dz], i) => {
    spacing.x[i] = x;
    spacing.z[i] = z;
    spacing.dx[i] = dx;
    spacing.dz[i] = dz;
  });

  return [...spacing.resolve(buses.length, LENGTH, GAP)];
}

describe("spacing", () => {
  it("holds the bus behind back to a gap behind the one ahead", () => {
    // Both heading east, the second 5 m ahead.
    const [behind, ahead] = resolve([
      [0, 0, 1, 0],
      [5, 0, 1, 0],
    ]);

    expect(behind).toBeCloseTo(LENGTH + GAP - 5);
    expect(ahead).toBe(0);
  });

  it("works out which is behind whichever way they're going", () => {
    // Heading west, so the one at x = 0 is ahead.
    const [ahead, behind] = resolve([
      [0, 0, -1, 0],
      [5, 0, -1, 0],
    ]);

    expect(ahead).toBe(0);
    expect(behind).toBeCloseTo(LENGTH + GAP - 5);
  });

  it("holds back just one of two buses in the same place", () => {
    const push = resolve([
      [0, 0, 0, -1],
      [0, 0, 0, -1],
    ]);

    expect(push.filter((p) => p > 0)).toHaveLength(1);
  });

  it("lets buses far enough apart, passing, crossing or a lane over be", () => {
    expect(
      resolve([
        [0, 0, 1, 0],
        [LENGTH + GAP, 0, 1, 0],
        // Passing the other way.
        [40, 0, 1, 0],
        [45, 0, -1, 0],
        // Crossing.
        [80, 0, 1, 0],
        [85, 0, 0, 1],
        // A lane over.
        [120, 0, 1, 0],
        [125, 3.2, 1, 0],
        // Standing still, no heading.
        [160, 0, 1, 0],
        [165, 0, 0, 0],
      ])
    ).toEqual(Array(10).fill(0));
  });

  it("holds each bus in a queue back behind the next", () => {
    const push = resolve([
      [0, 0, 1, 0],
      [4, 0, 1, 0],
      [8, 0, 1, 0],
    ]);

    expect(push[0]).toBeGreaterThan(0);
    expect(push[1]).toBeGreaterThan(0);
    expect(push[2]).toBe(0);
  });
});
