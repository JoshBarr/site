import { describe, expect, it } from "vitest";
import {
  marker,
  ripple,
  S_WAVE,
  shake,
} from "../../src/components/scene/quakes/ripple";
import { intensity, type Quake } from "../../src/lib/quakes";

const STRUCK = Date.parse("2026-11-02T07:00:00Z");

/** A quake `depth` km down, struck at STRUCK. */
const quake = (magnitude: number, depth: number): Quake => ({
  id: "2026p829637",
  time: STRUCK,
  position: [1760000, 5440000],
  depth,
  magnitude,
  locality: "20 km east of Paraparaumu",
  quality: "best",
});

/** STRUCK and `seconds` on. */
const after = (seconds: number) => STRUCK + seconds * 1000;

describe("an earthquake's intensity", () => {
  it("is about as measured near and far", () => {
    expect(intensity(6, 20)).toBeCloseTo(7, 0);
    // Kaikōura, at Wellington.
    expect(intensity(7.8, 200)).toBeCloseTo(6.7, 0);
  });
});

describe("an earthquake's ripple", () => {
  const off = Infinity;

  it("comes up where the shaking reaches the surface, and spreads with it", () => {
    const m3 = quake(3, 7);

    // Still on its way up.
    expect(ripple(m3, STRUCK, after(1), off)).toBeNull();

    const at = (seconds: number) => ripple(m3, STRUCK, after(seconds), off);

    // 25 km from the hypocentre is 24 along the ground.
    expect(at(25 / S_WAVE)?.radius).toBeCloseTo(24_000, -2);
    expect(at(10)!.radius).toBeGreaterThan(at(5)!.radius);
    expect(at(10)!.strength).toBeLessThan(at(5)!.strength);
  });

  it("dies out sooner for a smaller quake", () => {
    // Seconds it shows for, of the first two minutes.
    const lasts = (magnitude: number) =>
      Array.from({ length: 120 }, (_, seconds) =>
        ripple(quake(magnitude, 10), STRUCK, after(seconds), off)
      ).filter(Boolean).length;

    expect(lasts(2)).toBeLessThan(lasts(3));
    // Too small to see at all.
    expect(lasts(1)).toBe(0);
  });

  it("goes once it's off the map, or with no start", () => {
    expect(ripple(quake(5, 10), STRUCK, after(20), 50_000)).toBeNull();
    expect(ripple(quake(5, 10), null, after(5), off)).toBeNull();
  });
});

describe("an earthquake's marker", () => {
  it("shows from when it struck, fading over a day", () => {
    const m2 = quake(2, 10);

    expect(marker(m2, after(-1))).toBeNull();
    expect(marker(m2, after(86_400))).toBeNull();

    expect(marker(m2, after(3600))!.strength).toBeLessThan(
      marker(m2, after(60))!.strength
    );
  });

  it("is the same size for every quake, brighter for a bigger one", () => {
    const small = marker(quake(2, 10), STRUCK)!;
    const big = marker(quake(4, 10), STRUCK)!;

    expect(big.radius).toBe(small.radius);
    expect(big.strength).toBeGreaterThan(small.strength);
  });
});

describe("an earthquake's shaking", () => {
  it("is felt once the front arrives, and dies away", () => {
    const m5 = quake(5, 20);
    // 30 km off, the front's 36 km away: about ten seconds.
    const arrives = Math.hypot(30, 20) / S_WAVE;

    expect(shake(m5, STRUCK, after(arrives - 0.5), 30)).toBe(0);

    const early = shake(m5, STRUCK, after(arrives + 0.5), 30);
    const later = shake(m5, STRUCK, after(arrives + 3), 30);

    expect(early).toBeGreaterThan(later);
    expect(later).toBeGreaterThan(0);
    expect(shake(m5, STRUCK, after(arrives + 60), 30)).toBe(0);
  });

  it("isn't felt from a small quake far off", () => {
    expect(shake(quake(2, 20), STRUCK, after(15), 50)).toBe(0);
  });
});
