import { afterEach, describe, expect, it } from "vitest";
import {
  rainAt,
  rainField,
  setRainField,
} from "../../src/components/scene/clouds/rainField";

// The gauges' rates spread across the map: the share of the hardest rain
// falling at each place, and where the cloud closes over it.

const shareAt = (x: number, z: number) => rainAt(x, z).share;

describe("the rain field", () => {
  afterEach(() => {
    rainField.deck.value = 0;
  });

  it("rains the forecast everywhere without gauges", () => {
    expect(setRainField(null)).toBeNull();
    expect(setRainField([])).toBeNull();
    expect(shareAt(0, 0)).toBe(1);
    expect(shareAt(-20_000, 15_000)).toBe(1);
  });

  it("rains as hard as the wettest gauge by it, and not by a dry one", () => {
    expect(
      setRainField([
        { x: 10_000, z: 0, rate: 6 },
        { x: -10_000, z: 0, rate: 0 },
      ])
    ).toBeCloseTo(6, 1);

    expect(shareAt(10_000, 0)).toBeGreaterThan(0.99);
    expect(shareAt(-10_000, 0)).toBeLessThan(0.01);

    // Halfway between, half the rate.
    expect(shareAt(0, 0)).toBeCloseTo(0.5 ** 0.63, 1);
  });

  it("goes by the nearest gauge far from them all", () => {
    setRainField([
      { x: 10_000, z: 0, rate: 6 },
      { x: -10_000, z: 0, rate: 0 },
    ]);

    expect(shareAt(30_000, 30_000)).toBeGreaterThan(0.99);
    expect(shareAt(-30_000, -30_000)).toBeLessThan(0.01);
  });

  it("closes the cloud over the rain, and not over a dry gauge near it", () => {
    setRainField([
      { x: 0, z: 0, rate: 4 },
      { x: 5_000, z: 0, rate: 0 },
    ]);

    rainField.deck.value = 1;

    expect(rainAt(0, 0).deck).toBeCloseTo(1, 2);
    expect(rainAt(5_000, 0).deck).toBe(0);
    expect(shareAt(5_000, 0)).toBeLessThan(0.3);
  });

  it("is dry when the gauges only caught a trace", () => {
    expect(
      setRainField([
        { x: 0, z: 0, rate: 0.2 },
        { x: 5_000, z: 0, rate: 0 },
      ])
    ).toBe(0);
  });
});
