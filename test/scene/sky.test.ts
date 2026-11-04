import { Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  equatorial,
  planets,
  skyRotation,
} from "../../src/components/scene/sky/ephemeris";

// Where the sky's things are over Wellington, against astronomy-engine
// (Don Cross's, to arcseconds) at 2026-11-05 10:00 UTC, 11 pm NZDT.

const TIME = Date.parse("2026-11-05T10:00:00Z");

const DEG = 180 / Math.PI;

/** Altitude and azimuth (degrees) of a scene direction (x east, y up, z south). */
function horizontal([x, y, z]: number[]) {
  return {
    altitude: Math.asin(y) * DEG,
    azimuth: (Math.atan2(x, -z) * DEG + 360) % 360,
  };
}

const toScene = (ra: number, dec: number) =>
  new Vector3(...equatorial(ra, dec)).applyMatrix3(skyRotation(TIME)).toArray();

describe("the sky over Wellington", () => {
  it("turns the stars with the Earth", () => {
    // Sirius rising in the east-south-east; Acrux low over the south pole.
    // Precession (~0.3°) and refraction are left out, so to a degree.
    const sirius = horizontal(toScene(101.287, -16.716));
    const acrux = horizontal(toScene(186.65, -63.1));

    expect(sirius.altitude).toBeCloseTo(9.58 - 0.08, 0);
    expect(sirius.azimuth).toBeCloseTo(103.88, 0);
    expect(acrux.altitude).toBeCloseTo(14.41 - 0.06, 0);
    expect(acrux.azimuth).toBeCloseTo(178.7, 0);
  });

  it("puts the planets within a few arcminutes", () => {
    const expected = {
      mercury: [218.294, -15.129],
      venus: [200.784, -12.802],
      mars: [143.396, 16.281],
      jupiter: [147.0, 14.032],
      saturn: [8.989, 0.968],
    };

    for (const { name, direction } of planets(TIME)) {
      const [ra, dec] = expected[name];

      const apart = Math.acos(
        new Vector3(...direction).dot(new Vector3(...equatorial(ra, dec)))
      );

      expect(apart * DEG, name).toBeLessThan(0.1);
    }
  });

  it("brightens them roughly as they're seen", () => {
    const magnitude = Object.fromEntries(
      planets(TIME).map(({ name, magnitude: m }) => [name, m])
    );

    expect(magnitude.venus).toBeCloseTo(-4.46, 0);
    expect(magnitude.mars).toBeCloseTo(0.83, 0);
    expect(magnitude.jupiter).toBeCloseTo(-2.04, 0);
    // Without its rings' share.
    expect(Math.abs(magnitude.saturn - 0.41)).toBeLessThan(0.6);
  });
});
