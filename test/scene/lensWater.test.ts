import { describe, expect, it } from "vitest";
import {
  createLensWater,
  lensRain,
  type LensWeather,
} from "../../src/components/scene/clouds/lensWater";

// Water on the glass in front of the lens: held, run, merged, blown, dripped
// and dried.

/** A repeatable stand-in for Math.random. */
function seeded(seed = 1) {
  let s = seed;

  return () => {
    s = (s * 16807) % 2147483647;

    return (s - 1) / 2147483646;
  };
}

/** Upright, dry, still air: gravity straight down the frame. */
const UPRIGHT: LensWeather = {
  rain: 0,
  down: [0, 1],
  away: 0,
  air: [0, 0],
  onto: 0,
  aspect: 1.5,
};

const water = (seed = 1) => createLensWater(1400, seeded(seed));

/** Seconds of `weather`, a frame at a time. */
function run(glass: ReturnType<typeof water>, weather: LensWeather, s: number) {
  for (let t = 0; t < s; t += 1 / 60) glass.step(weather, 1 / 60);
}

const volume = (radii: number[]) => radii.reduce((sum, r) => sum + r ** 3, 0);

describe("lens water", () => {
  it("holds a small drop where it landed", () => {
    const glass = water();
    glass.put(0.7, 0.4, 0.004);
    run(glass, UPRIGHT, 2);

    const [[x, y]] = glass.places();
    expect(x).toBeCloseTo(0.7, 5);
    expect(y).toBeCloseTo(0.4, 5);
  });

  it("runs a big drop down the glass, leaving beads behind", () => {
    const glass = water();
    glass.put(0.7, 0.2, 0.02);
    run(glass, UPRIGHT, 1);

    const places = glass.places();
    const lowest = Math.max(...places.map(([, y]) => y));
    expect(lowest).toBeGreaterThan(0.3);
    // Beads above it, along its track.
    expect(places.length).toBeGreaterThan(2);

    for (const [x, y] of places) {
      expect(y).toBeGreaterThanOrEqual(0.19);
      expect(Math.abs(x - 0.7)).toBeLessThan(0.2);
    }
  });

  it("runs a drop mostly on top of another into one, keeping their water", () => {
    const glass = water();
    glass.put(0.5, 0.5, 0.005);
    glass.put(0.503, 0.5, 0.005);
    const before = volume(glass.radii());
    glass.step(UPRIGHT, 1 / 60);

    const radii = glass.radii();
    expect(radii).toHaveLength(1);
    // Less a frame's drying.
    expect(volume(radii)).toBeCloseTo(before, 7);
  });

  it("clings held drops side by side together in a clump", () => {
    const glass = water();
    glass.put(0.5, 0.5, 0.005);
    glass.put(0.508, 0.5, 0.005);
    run(glass, UPRIGHT, 1);

    expect(glass.radii()).toHaveLength(2);
  });

  it("tears a clump free once there's water enough in it, and runs it", () => {
    const glass = water();

    // A patch of beads, each held alone, holding between them more water
    // than the glass can hold along the patch's edge.
    for (let row = -3; row <= 3; row++) {
      for (let col = -3; col <= 3; col++) {
        if (Math.abs(row + col) > 3) continue;
        const px = 0.7 + (col + row / 2) * 0.011;
        const py = 0.3 + row * 0.011 * (Math.sqrt(3) / 2);
        glass.put(px, py, 0.008);
      }
    }

    expect(glass.count).toBe(37);
    run(glass, UPRIGHT, 0.6);

    const lowest = Math.max(...glass.places().map(([, y]) => y));
    expect(lowest).toBeGreaterThan(0.4);
  });

  it("holds a few beads clumped together where one drop of their water would run", () => {
    const clumped = water();
    clumped.put(0.7, 0.3, 0.0085);
    clumped.put(0.7135, 0.3, 0.0085);
    clumped.put(0.70675, 0.3117, 0.0085);
    run(clumped, UPRIGHT, 0.5);
    expect(clumped.count).toBe(3);

    const one = water();
    one.put(0.7, 0.3, Math.cbrt(3) * 0.0085);
    run(one, UPRIGHT, 1.5);
    expect(Math.max(...one.places().map(([, y]) => y))).toBeGreaterThan(0.35);
  });

  it("swallows a held drop into a running one", () => {
    /** The biggest drop's water, with a held drop at `x` 0.25 below it. */
    const biggest = (x: number) => {
      const glass = water();
      glass.put(0.5, 0.2, 0.02);
      glass.put(x, 0.45, 0.008);
      run(glass, UPRIGHT, 2);

      return Math.max(...glass.radii()) ** 3;
    };

    // In its way, and out of it.
    expect(biggest(0.5) - biggest(1.3)).toBeGreaterThan(0.5 * 0.008 ** 3);
  });

  it("levels off how hard a downpour rains on the glass", () => {
    expect(lensRain(6)).toBeCloseTo(1, 5);
    expect(lensRain(20)).toBeLessThan(1.4);
    expect(lensRain(100)).toBeLessThan(1.41);
    expect(lensRain(20)).toBeGreaterThan(lensRain(10));
  });

  it("gathers more water on the glass in heavier rain", () => {
    const on = (rate: number) => {
      const glass = water(5);
      run(glass, { ...UPRIGHT, rain: lensRain(rate) }, 4);

      return volume(glass.radii());
    };

    expect(on(20)).toBeGreaterThan(on(6) * 1.15);
    expect(on(6)).toBeGreaterThan(on(1) * 2);
  });

  it("runs drops down one track into one stream", () => {
    const glass = water();
    // Two runners, the one behind down the track the first wets.
    glass.put(0.7, 0.1, 0.018);
    run(glass, UPRIGHT, 0.15);
    glass.put(0.7, 0.1, 0.018);
    run(glass, UPRIGHT, 1.2);

    const runners = glass.radii().filter((r) => r > 0.012);
    expect(runners).toHaveLength(1);
  });

  it("runs slower over dry glass than down a wet track", () => {
    /** How far the biggest drop's run from 0.1 in 0.3 s. */
    const ran = (glass: ReturnType<typeof water>) => {
      glass.put(0.7, 0.1, 0.018);
      run(glass, UPRIGHT, 0.3);

      const radii = glass.radii();
      const biggest = radii.indexOf(Math.max(...radii));

      return glass.places()[biggest][1] - 0.1;
    };

    const dry = ran(water());

    // The same drop again, down the track another's wet and left by.
    const wet = water();
    wet.put(0.7, 0.1, 0.018);
    run(wet, UPRIGHT, 8);
    expect(wet.radii().every((r) => r < 0.012)).toBe(true);

    expect(ran(wet)).toBeGreaterThan(dry * 1.5);
  });

  it("draws a thread behind a running drop, which drains away", () => {
    const glass = water();
    glass.put(0.7, 0.1, 0.02);
    run(glass, UPRIGHT, 0.5);

    const piece = { x0: 0, y0: 0, x1: 0, y1: 0, radius: 0 };

    const live = () =>
      Array.from({ length: glass.threads }, (_, k) =>
        glass.thread(k, { ...piece })
      ).filter((t) => t.radius > 0);

    const drawn = live();
    expect(drawn.length).toBeGreaterThan(3);

    for (const t of drawn) {
      // Down the glass, along the drop's way, thinner than it.
      expect(t.y1).toBeGreaterThan(t.y0);
      expect(Math.abs(t.x0 - 0.7)).toBeLessThan(0.1);
      expect(t.radius).toBeLessThan(0.01);
    }

    // And none once the glass is wiped.
    glass.clear();
    expect(live()).toHaveLength(0);
  });

  it("drains a thread to nothing in a few seconds", () => {
    const glass = water();
    glass.put(0.7, 0.1, 0.02);
    run(glass, UPRIGHT, 0.4);
    run(glass, { ...UPRIGHT, down: [0, 0], away: -1 }, 3);

    const piece = { x0: 0, y0: 0, x1: 0, y1: 0, radius: 0 };

    for (let k = 0; k < glass.threads; k++) {
      expect(glass.thread(k, piece).radius).toBe(0);
    }
  });

  it("slants runners in a wind across the glass", () => {
    const glass = water();
    glass.put(0.3, 0.2, 0.02);
    run(glass, { ...UPRIGHT, air: [15, 0] }, 0.3);

    const [x, y] = glass.places().reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(x - 0.3).toBeGreaterThan((y - 0.2) * 0.5);
  });

  it("lets the big drops fall off glass facing down, and keeps the small", () => {
    const glass = water();
    // Facing straight down: nothing along the glass, all of it off.
    const down: LensWeather = { ...UPRIGHT, down: [0, 0], away: 1 };
    glass.put(0.4, 0.5, 0.004);
    glass.put(1.0, 0.5, 0.015);
    run(glass, down, 3);

    expect(glass.radii()).toHaveLength(1);
    expect(glass.places()[0][0]).toBeCloseTo(0.4, 5);
  });

  it("holds the drops of glass facing up, however big", () => {
    const glass = water();
    glass.put(0.75, 0.5, 0.015);
    run(glass, { ...UPRIGHT, down: [0, 0.05], away: -1 }, 3);

    expect(glass.places()[0][1]).toBeCloseTo(0.5, 5);
  });

  it("wets the glass in rain and dries it after", () => {
    const glass = water();
    run(glass, { ...UPRIGHT, rain: 0.6 }, 5);
    const wet = glass.count;
    expect(wet).toBeGreaterThan(50);

    run(glass, UPRIGHT, 30);
    expect(glass.count).toBeLessThan(wet / 3);

    run(glass, UPRIGHT, 120);
    expect(glass.count).toBe(0);
  });

  it("never holds more drops than it can", () => {
    const glass = createLensWater(100, seeded(3));
    run(glass, { ...UPRIGHT, rain: 1, aspect: 3 }, 10);

    expect(glass.count).toBeLessThanOrEqual(100);
  });
});
