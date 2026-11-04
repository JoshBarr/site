import { describe, expect, it } from "vitest";
import { satellitesFrom, sight } from "../../src/components/scene/sky/orbits";
import { CSS, HST, ISS } from "../fixtures/celestrak";

// Satellites over Wellington, from CelesTrak's elements of 2026-11-04.

const DEG = 180 / Math.PI;

const [iss, hst, tiangong] = satellitesFrom([ISS, HST, CSS]);

/** Compass bearing of a scene direction (x east, z south), degrees. */
const azimuth = ([x, , z]: number[]) => (Math.atan2(x, -z) * DEG + 360) % 360;

describe("satellites over Wellington", () => {
  it("knows the bright ones' magnitudes", () => {
    expect(iss.standard).toBe(-1.3);
    expect(hst.standard).toBe(2.2);
  });

  it("comes out of the Earth's shadow overhead", () => {
    // Tiangong at 4:12 am on 5 November, climbing out of the west unseen,
    // then lit near the zenith a minute later.
    const shadowed = sight(tiangong, Date.parse("2026-11-04T15:12:00Z"));
    const lit = sight(tiangong, Date.parse("2026-11-04T15:13:00Z"));

    expect(shadowed?.elevation).toBeCloseTo(42.6, 0);
    expect(azimuth(shadowed!.direction)).toBeCloseTo(282.5, 0);
    expect(shadowed!.magnitude).toBeGreaterThan(8);

    expect(lit?.elevation).toBeCloseTo(84.2, 0);
    expect(lit!.direction[1]).toBeCloseTo(Math.sin(84.2 / DEG), 2);
    // 395 km off: brighter than any star.
    expect(lit!.magnitude).toBeLessThan(-1.5);
  });

  it("is below the horizon most of the time", () => {
    const sighting = sight(iss, Date.parse("2026-11-05T10:00:00Z"));

    expect(sighting?.elevation).toBeLessThan(0);
  });
});
