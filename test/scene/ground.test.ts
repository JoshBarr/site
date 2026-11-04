import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { groundAlong } from "../../src/components/scene/ground";

const flat = (height: number) => () => height;

describe("where the view meets the ground", () => {
  it("finds flat ground looking down at 45°", () => {
    const from = new Vector3(0, 100, 0);
    const down = new Vector3(1, -1, 0).normalize();

    expect(groundAlong(from, down, flat(0), 5000)).toBeCloseTo(
      100 * Math.SQRT2,
      1
    );
  });

  it("stops at a hill in the way", () => {
    const from = new Vector3(0, 50, 0);
    const level = new Vector3(0, 0, -1);
    const hill = (_x: number, z: number) => (z < -800 ? 200 : 0);

    expect(groundAlong(from, level, hill, 5000)).toBeCloseTo(800, 0);
  });

  it("takes the sea surface over the seabed, and sea off the map", () => {
    const from = new Vector3(0, 10, 0);
    const down = new Vector3(0, -1, 0);

    expect(groundAlong(from, down, flat(-30), 100)).toBeCloseTo(10, 1);
    expect(groundAlong(from, down, () => undefined, 100)).toBeCloseTo(10, 1);
  });

  it("misses looking at the sky or past the reach", () => {
    const from = new Vector3(0, 100, 0);

    expect(groundAlong(from, new Vector3(0, 1, 0), flat(0), 5000)).toBeNull();
    expect(
      groundAlong(from, new Vector3(1, -0.01, 0).normalize(), flat(0), 5000)
    ).toBeNull();
  });
});
