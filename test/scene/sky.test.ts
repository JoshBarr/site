import { Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  equatorial,
  moon,
  moonDirection,
  planets,
  skyRotation,
} from "../../src/components/scene/sky/ephemeris";
import { moonAt, moonlight } from "../../src/components/scene/sky/moon";

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

  it("puts the Moon within its width, seen from Wellington", () => {
    // astronomy-engine's topocentric altitude and azimuth, refraction left
    // out, and its phase: a waning crescent, a gibbous Moon and the full.
    const expected = [
      ["2026-11-05T10:00:00Z", -46.464, 161.52, 0.151, -7.95],
      ["2026-11-20T10:00:00Z", 39.498, 328.822, 0.781, -11.27],
      ["2026-11-24T10:00:00Z", 18.076, 26.52, 0.997, -12.73],
      ["2026-11-26T12:00:00Z", 14.657, 27.974, 0.947, -12.19],
    ] as const;

    for (const [iso, altitude, azimuth, lit, magnitude] of expected) {
      const time = Date.parse(iso);
      const seen = horizontal(moonDirection(time));
      const body = moon(time);
      const across = (seen.azimuth - azimuth) * Math.cos(altitude / DEG);

      expect(Math.hypot(seen.altitude - altitude, across), iso).toBeLessThan(
        0.4
      );
      expect(body.illuminated, iso).toBeCloseTo(lit, 2);
      // Allen's phase law leaves out the full Moon's surge.
      expect(Math.abs(body.magnitude - magnitude), iso).toBeLessThan(0.2);
    }
  });

  it("lights the night by the Moon's phase, once it's up and the Sun's down", () => {
    const full = moonAt(Date.parse("2026-11-24T10:00:00Z"));
    const gibbous = moonAt(Date.parse("2026-11-20T10:00:00Z"));
    const set = moonAt(Date.parse("2026-11-05T10:00:00Z"));

    const night = -20;
    const fullLight = moonlight(full.body, full.altitude, night);

    expect(fullLight).toBeGreaterThan(0.25);
    expect(moonlight(gibbous.body, gibbous.altitude, night)).toBeLessThan(
      fullLight
    );
    expect(moonlight(set.body, set.altitude, night)).toBe(0);
    // Twilight's light is the sky's, not the Moon's.
    expect(moonlight(full.body, full.altitude, 0)).toBe(0);
    expect(moonlight(full.body, full.altitude, -3)).toBeLessThan(fullLight);
    // Low down, through the most air, it fades out.
    expect(moonlight(full.body, 1, night)).toBeLessThan(fullLight / 4);
  });
});
