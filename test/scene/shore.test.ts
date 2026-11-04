import { describe, expect, it } from "vitest";
import { Shore } from "../../src/components/scene/vessels/shore";
import { originIndex } from "../fixtures/terrain";

// The shore's distance field, which keeps ships off the land: here a
// straight coast running north–south 50 m east of the origin, land to the
// west, the sea to the east.

const COAST = 50;
const SIZE = 101;

/** A field `size` square at 1 m, each sample `distance(x)` metres. */
function shoreOf(distance: (x: number) => number, unit = 1) {
  const values = new Uint8Array(SIZE * SIZE);

  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      values[j * SIZE + i] = Math.min(
        Math.max(Math.round(128 + distance(i) / unit), 0),
        255
      );
    }
  }

  // Sample (i, j) is i m east and j m south of the origin: world (i, j).
  return new Shore(originIndex(), values, {
    origin: [0, 0],
    resolution: 1,
    size: [SIZE, SIZE],
    unit,
  });
}

const coast = shoreOf((x) => x - COAST);

describe("the shore", () => {
  it("is how far out to sea a point is, between samples too", () => {
    expect(coast.distance(60, 20)).toBe(10);
    expect(coast.distance(42.5, 20.5)).toBeCloseTo(-7.5, 10);
  });

  it("is open sea off the edge of the field", () => {
    expect(coast.distance(-10, 20)).toBe(127);
    expect(coast.distance(20, 200)).toBe(127);
  });

  describe("putting a ship in the water", () => {
    it("leaves one clear where it is", () => {
      expect(coast.toWater(70, 20, 5)).toEqual([70, 20]);
    });

    it("pushes one aground straight out, a little past the clearance", () => {
      const [x, z] = coast.toWater(40, 20, 5) ?? [];

      expect(x).toBeCloseTo(55.25, 6);
      expect(z).toBeCloseTo(20, 6);
    });

    it("keeps all its hull off, not just its middle", () => {
      // Lying east–west, its stern 2 m up the beach.
      const [x] = coast.toWater(58, 20, 5, 1, 0, 10) ?? [];

      expect(x).toBeDefined();
      expect((x ?? 0) - 10 - COAST).toBeGreaterThanOrEqual(5);
    });

    it("can't say where the sea is from deep inland", () => {
      // Saturated: everything west of 30 m is as far inland as it reads.
      const steep = shoreOf((x) => (x - COAST) * 8);

      expect(steep.toWater(10, 20, 5)).toBeNull();
    });
  });

  describe("how far a ship can go", () => {
    it("stops short of the clearance heading for the shore", () => {
      expect(coast.reach(80, 20, -1, 0, 100, 5)).toBe(25);
    });

    it("goes as far as it likes heading out to sea", () => {
      expect(coast.reach(80, 20, 1, 0, 300, 5)).toBe(300);
    });

    it("can leave a berth closer in than the clearance, but not run aground", () => {
      expect(coast.reach(52, 20, -1, 0, 100, 5)).toBe(2);
      expect(coast.reach(52, 20, 1, 0, 100, 5)).toBe(100);
    });
  });
});
