import { describe, expect, it } from "vitest";
import {
  createLuffingCraneGeometry,
  createTripodCraneGeometry,
  LUFFING_CRANE_SPEC,
  luffingCraneHeight,
  TRIPOD_CRANE_SPEC,
  tripodCraneHeight,
} from "../../src/components/scene/port/heritageCraneGeometry";

describe("Queens Wharf's heritage cranes", () => {
  const luffing = createLuffingCraneGeometry(LUFFING_CRANE_SPEC, -0.3);
  const tripod = createTripodCraneGeometry(TRIPOD_CRANE_SPEC);
  luffing.computeBoundingBox();
  tripod.computeBoundingBox();

  it("stand as tall as the survey found them", () => {
    // The council's model of the luffing crane tops out about 40 m up; the
    // lidar caught the tripod crane's jib tip at about 31 m.
    expect(luffingCraneHeight(LUFFING_CRANE_SPEC)).toBeGreaterThan(30);
    expect(luffingCraneHeight(LUFFING_CRANE_SPEC)).toBeLessThan(42);
    expect(tripodCraneHeight(TRIPOD_CRANE_SPEC)).toBeCloseTo(31, 0);

    expect(luffing.boundingBox!.max.y).toBeCloseTo(
      luffingCraneHeight(LUFFING_CRANE_SPEC),
      0
    );
    expect(tripod.boundingBox!.max.y).toBeCloseTo(
      tripodCraneHeight(TRIPOD_CRANE_SPEC),
      0
    );
  });

  it("reach down below the wharf, so no gap shows under a leg", () => {
    expect(luffing.boundingBox!.min.y).toBeLessThan(0);
    expect(tripod.boundingBox!.min.y).toBeLessThan(0);
  });

  it("carry the attributes the steelwork material fattens members by", () => {
    for (const geometry of [luffing, tripod]) {
      expect(geometry.getAttribute("spread").itemSize).toBe(3);
      expect(geometry.getAttribute("thickness").count).toBe(
        geometry.getAttribute("position").count
      );
    }
  });
});
