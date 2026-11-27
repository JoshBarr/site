import { describe, expect, it } from "vitest";
import {
  BEARINGS,
  ELEVATIONS,
  ozoneColumn,
  radianceAt,
  skyLight,
} from "../../src/components/scene/sky/atmosphere";
import { skyFor } from "../../src/components/scene/sky/skyModel";

// The daytime sky, worked out from the air: the sun through it, the sky's
// light, and where the sky's bright.

/** Air you can see 30 km through, as the scene's haze has it. */
const AIR = { haze: 3.912 / 30000, hazeHeight: 900 };

describe("skyLight", () => {
  it("dims the sun as it sinks, to nothing as it sets", () => {
    const altitudes = [60, 30, 10, 5, 2, 0.5, -0.5];
    const suns = altitudes.map((altitude) => skyLight(altitude, AIR).sun);

    expect(suns[0]).toBeGreaterThan(0.7);
    expect(suns[0]).toBeLessThan(0.9);

    for (let i = 1; i < suns.length; i++) {
      expect(suns[i]).toBeLessThan(suns[i - 1]);
    }

    // Through nearly forty times the air, at the horizon.
    expect(suns[4]).toBeLessThan(suns[0] / 20);
    expect(suns.at(-1)).toBe(0);
  });

  it("gives the sky a sixth or so of the sun's light at noon", () => {
    const { sun, sky } = skyLight(60, AIR);

    expect(sky / sun).toBeGreaterThan(0.1);
    expect(sky / sun).toBeLessThan(0.3);
  });

  it("is brighter at the horizon than overhead, and toward the sun", () => {
    const light = skyLight(30, AIR);
    const horizon = radianceAt(light, 30, 0, BEARINGS - 1);
    const overhead = radianceAt(light, 30, ELEVATIONS - 1, 0);

    expect(horizon).toBeGreaterThan(overhead);

    expect(radianceAt(light, 30, 8, 0)).toBeGreaterThan(
      radianceAt(light, 30, 8, BEARINGS - 1)
    );
  });

  it("keeps the sky lit after sunset, brightest where the sun went", () => {
    const light = skyLight(-3, AIR);

    expect(light.sun).toBe(0);
    expect(light.sky).toBeGreaterThan(0);

    expect(radianceAt(light, -3, 4, 0)).toBeGreaterThan(
      radianceAt(light, -3, 4, BEARINGS - 1)
    );

    // And dark once it's well down.
    expect(skyLight(-14, AIR).sky).toBeLessThan(light.sky / 1000);
  });

  it("takes sun for sky in thicker haze", () => {
    const clear = skyLight(40, { haze: 3.912 / 60000, hazeHeight: 900 });
    const hazy = skyLight(40, { haze: 3.912 / 5000, hazeHeight: 900 });

    expect(hazy.sun).toBeLessThan(clear.sun);
    expect(hazy.sky).toBeGreaterThan(clear.sky);
  });

  it("has a number for every direction, whatever the air", () => {
    for (const altitude of [70, 3, 0, -5, -30]) {
      for (const haze of [0, 3.912 / 30000, 3.912 / 200]) {
        const light = skyLight(altitude, { haze, hazeHeight: 900 });

        expect(light.table.every(Number.isFinite)).toBe(true);
        expect(Number.isFinite(light.sky)).toBe(true);
        expect(Number.isFinite(light.around)).toBe(true);
      }
    }
  });
});

describe("the air's share of the visibility", () => {
  /** What the air alone takes out of the light a metre at sea level. */
  const ALONE = 1.33e-5;

  it("leaves no haze where the air accounts for all that's taken", () => {
    const none = skyLight(40, { haze: 0, hazeHeight: 900 });
    const air = skyLight(40, { haze: ALONE, hazeHeight: 900 });

    expect(air.sun).toBe(none.sun);
    expect(air.sky).toBe(none.sky);
  });

  it("has haze for the rest", () => {
    const air = skyLight(40, { haze: ALONE, hazeHeight: 900 });
    const hazy = skyLight(40, { haze: ALONE * 2, hazeHeight: 900 });

    // As much haze as air at sea level, but in 900 m of it where the air
    // has 8 km: a ninth of the air's depth, more.
    const depth = (ALONE * 900) / Math.sin((40 * Math.PI) / 180);

    expect(hazy.sun / air.sun).toBeCloseTo(Math.exp(-depth), 3);
  });
});

describe("ozone", () => {
  it("is 15 km of its thickest straight up, and none from above it", () => {
    expect(ozoneColumn(0, 1)).toBeCloseTo(15_000, 6);
    expect(ozoneColumn(25_000, 1)).toBeCloseTo(7500, 6);
    expect(ozoneColumn(50_000, 1)).toBe(0);
    expect(ozoneColumn(50_000, 0)).toBe(0);
  });

  it("is more on a slant, but no more than a round Earth has", () => {
    const low = ozoneColumn(0, Math.sin((8 * Math.PI) / 180));
    const level = ozoneColumn(0, 0);

    // A flat Earth's would be 15 km over the sine: 108 km, and no end of it.
    expect(low).toBeGreaterThan(85_000);
    expect(low).toBeLessThan(100_000);
    expect(level).toBeGreaterThan(low);
    expect(level).toBeLessThan(200_000);
  });

  it("is passed twice by a ray that dips through it from above", () => {
    expect(ozoneColumn(50_000, -0.1)).toBeGreaterThan(2 * ozoneColumn(0, 0));
    // One that dips, but not as far down as the ozone, passes none.
    expect(ozoneColumn(50_000, -0.01)).toBe(0);
  });

  it("takes little of a high sun, and an eighth of a low one", () => {
    /** The air's depth straight up: 8 km of it as it is at sea level. */
    const depth = 1.33e-5 * 8000;

    /** Of the sun through `airs` of air alone, what the ozone leaves. */
    const left = (altitude: number, airs: number) =>
      skyLight(altitude, { haze: 0, hazeHeight: 900 }).sun /
      Math.exp(-depth * airs);

    expect(left(60, 1 / Math.sin(Math.PI / 3))).toBeGreaterThan(0.97);
    expect(left(60, 1 / Math.sin(Math.PI / 3))).toBeLessThan(0.98);

    // 7.0 airs at 8° on a round Earth (Kasten and Young's 6.9, near enough).
    expect(left(8, 7)).toBeGreaterThan(0.84);
    expect(left(8, 7)).toBeLessThan(0.9);
  });
});

describe("skyFor", () => {
  it("is the scene's old sun where the scene was balanced", () => {
    const sky = skyFor(60, AIR.haze, AIR.hazeHeight);

    expect(sky.sun).toBeCloseTo(3, 5);
    // Brighter than the constant it replaces (0.25): what the model says the
    // sky gives beside that sun.
    expect(sky.sky).toBeGreaterThan(0.35);
    expect(sky.sky).toBeLessThan(0.8);
  });

  it("opens up as the light goes, so the evening isn't black", () => {
    const noon = skyFor(60, AIR.haze, AIR.hazeHeight);
    const evening = skyFor(6, AIR.haze, AIR.hazeHeight);
    const sunset = skyFor(0, AIR.haze, AIR.hazeHeight);

    expect(evening.scale).toBeGreaterThan(noon.scale);
    expect(sunset.scale).toBeGreaterThan(evening.scale);

    // The low sun's still a light to see by, and the sky's after it's set.
    expect(evening.sun).toBeGreaterThan(1);
    expect(sunset.sun).toBeLessThan(0.01);
    expect(sunset.sky).toBeGreaterThan(noon.sky);

    // But the light on the ground only falls from noon to sunset.
    const level = (sky: typeof noon, altitude: number) =>
      sky.sun * Math.sin((altitude * Math.PI) / 180) + sky.sky;

    expect(level(evening, 6)).toBeLessThan(level(noon, 60));
    expect(level(sunset, 0)).toBeLessThan(level(evening, 6));
  });

  it("holds its exposure within what a camera could do", () => {
    const deep = skyFor(-12, AIR.haze, AIR.hazeHeight);

    expect(Number.isFinite(deep.scale)).toBe(true);
    expect(deep.sky).toBeLessThan(0.01);
  });
});
