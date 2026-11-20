// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSceneTime } from "../../src/components/scene/clock";
import {
  exposure,
  SHELTER_SIZE,
  standing,
} from "../../src/components/scene/ocean/shelter";
import {
  buildSpectrum,
  createCascades,
  openHeight,
  type OceanConditions,
  significantHeight,
} from "../../src/components/scene/ocean/spectrum";
import {
  measuredSea,
  seaConditions,
  useSwell,
} from "../../src/components/scene/ocean/swell";
import type { Waves } from "../../src/lib/waves";
import { NOW } from "../clock";
import { server } from "../msw";

// The open sea as the wave buoy measures it: read into the sea the
// spectrum's built for, drawn as high as it was measured, and kept out of
// the water the land shelters.

const ORIGIN = "http://localhost:3000";

const reading = (time: number, height = 2): Waves => ({
  time,
  height,
  period: 9.3,
  direction: 185,
});

describe("a buoy's reading", () => {
  it("is the open sea, its peak a little longer than the period measured", () => {
    expect(measuredSea(reading(NOW - 20 * 60_000), NOW)).toEqual({
      height: 2,
      period: 10,
      direction: 185,
    });
  });

  it("says nothing of the sea three hours on", () => {
    expect(measuredSea(reading(NOW - 3 * 3600_000 + 1), NOW)).not.toBeNull();
    expect(measuredSea(reading(NOW - 3 * 3600_000), NOW)).toBeNull();
  });
});

describe("the sea's conditions", () => {
  const sea = { height: 3.5, period: 11, direction: 185 };

  it("are the wind's, with the open sea as measured", () => {
    expect(seaConditions({ speed: 6, direction: 340 }, sea)).toEqual({
      windSpeed: 6,
      windDirection: 340,
      fetch: 80000,
      swell: 0.3,
      sea,
    });
  });

  it("are guessed from the wind's fetch without a measurement", () => {
    expect(seaConditions({ speed: 15, direction: 190 }, null)).toEqual({
      windSpeed: 15,
      windDirection: 190,
      fetch: 500000,
      swell: 0.6,
      sea: null,
    });
  });

  it("give the camera the measured sea's height to clear, or the wind's guess", () => {
    const calm = seaConditions({ speed: 2, direction: 340 }, sea);
    const gale = seaConditions({ speed: 15, direction: 190 }, null);

    expect(openHeight(calm)).toBe(3.5);
    expect(openHeight(gale)).toBe(significantHeight(gale));
    expect(significantHeight(gale)).toBeGreaterThan(4);

    // A flat strait under a gale: the harbour's own sea is the taller.
    const flat = seaConditions(
      { speed: 15, direction: 190 },
      { height: 0.2, period: 4, direction: 185 }
    );

    expect(openHeight(flat)).toBeCloseTo(0.84, 1);
  });
});

describe("the spectrum", () => {
  const N = 64;
  // The scene's own patches.
  const cascades = createCascades([503, 89, 13]);

  /** Variance of the surface's height in cascade `c`, m². */
  function variance(h0: Float32Array, c: number) {
    let sum = 0;

    for (let i = c * N * N * 4; i < (c + 1) * N * N * 4; i++) sum += h0[i] ** 2;

    return sum;
  }

  /** Where cascade 0's waves head, by their energy: east and south parts. */
  function heading(spectrum: ReturnType<typeof buildSpectrum>) {
    let east = 0;
    let south = 0;

    for (let i = 0; i < N * N; i++) {
      const energy = spectrum.h0[i * 4] ** 2 + spectrum.h0[i * 4 + 1] ** 2;
      const k = Math.hypot(spectrum.waves[i * 4], spectrum.waves[i * 4 + 1]);

      if (k === 0) continue;

      east += (energy * spectrum.waves[i * 4]) / k;
      south += (energy * spectrum.waves[i * 4 + 1]) / k;
    }

    return [east, south].map((part) => part / Math.hypot(east, south));
  }

  const light: OceanConditions = {
    windSpeed: 2,
    windDirection: 340,
    fetch: 80000,
    swell: 0.3,
  };

  it.each([
    { height: 1.4, period: 11.5, direction: 185 },
    { height: 5, period: 10.5, direction: 170 },
    { height: 2.5, period: 6, direction: 280 },
    // Longer than the patch can carry two of: drawn at the longest it can.
    { height: 3, period: 17, direction: 180 },
  ])("draws a measured sea as high as it was measured: %o", (sea) => {
    const spectrum = buildSpectrum(N, cascades, { ...light, sea });

    expect(4 * Math.sqrt(variance(spectrum.h0, 0))).toBeCloseTo(sea.height, 1);
    // Nearly all of it the open sea's, to lose where it's sheltered.
    expect(spectrum.open).toBeGreaterThan(0.95);
    expect(spectrum.from).toBe(sea.direction);
  });

  it("sends a measured sea the way it was measured going, whatever the wind", () => {
    const south = buildSpectrum(N, cascades, {
      ...light,
      sea: { height: 3, period: 10, direction: 180 },
    });

    const [east, southward] = heading(south);

    // From the south: northward, which is -z.
    expect(southward).toBeLessThan(-0.9);
    expect(Math.abs(east)).toBeLessThan(0.2);

    const west = buildSpectrum(N, cascades, {
      ...light,
      sea: { height: 3, period: 10, direction: 270 },
    });

    expect(heading(west)[0]).toBeGreaterThan(0.9);
  });

  it("draws swell that's come far as longer waves than a wind sea as high", () => {
    const swell = buildSpectrum(N, cascades, {
      ...light,
      sea: { height: 2, period: 13, direction: 180 },
    });

    const chop = buildSpectrum(N, cascades, {
      ...light,
      sea: { height: 2, period: 5.5, direction: 180 },
    });

    expect(swell.length).toBeCloseTo(264, 0);
    expect(chop.length).toBeCloseTo(47, 0);
  });

  it("leaves the wind's finer waves as they were, measured sea or not", () => {
    const gale = { ...light, windSpeed: 15, windDirection: 190, fetch: 500000 };
    const guessed = buildSpectrum(N, cascades, gale);

    const measured = buildSpectrum(N, cascades, {
      ...gale,
      sea: { height: 1, period: 9, direction: 180 },
    });

    expect(variance(measured.h0, 1)).toBe(variance(guessed.h0, 1));
    expect(variance(measured.h0, 2)).toBe(variance(guessed.h0, 2));
  });

  it("takes the measured sea over the wind's guess at it", () => {
    const gale = { ...light, windSpeed: 15, windDirection: 190, fetch: 500000 };
    const guessed = buildSpectrum(N, cascades, gale);

    // The wind over the Southern Ocean's fetch would raise a sea of metres.
    expect(4 * Math.sqrt(variance(guessed.h0, 0))).toBeGreaterThan(3);
    expect(guessed.from).toBe(190);
    expect(guessed.open).toBeGreaterThan(0.9);

    // The buoy says it hasn't: what's left is what a harbour would have.
    const measured = buildSpectrum(N, cascades, {
      ...gale,
      sea: { height: 0.3, period: 4, direction: 200 },
    });

    const height = 4 * Math.sqrt(variance(measured.h0, 0));

    expect(height).toBeGreaterThan(0.3);
    expect(height).toBeLessThan(1.2);
    expect(measured.open).toBeLessThan(0.3);
  });

  it("deals the same dice whatever the sea, so it doesn't reshuffle", () => {
    const a = buildSpectrum(N, cascades, light);
    const b = buildSpectrum(N, cascades, light);

    expect(a.h0).toEqual(b.h0);
  });
});

describe("the open sea's reach", () => {
  const N = SHELTER_SIZE;
  const CELL = 100;
  const swell = { from: 180, length: 200 };

  /** A sea `deep` metres everywhere but where `land` says. */
  function chart(land: (column: number, row: number) => boolean, deep = 400) {
    const depth = new Float32Array(N * N);

    for (let row = 0; row < N; row++) {
      for (let column = 0; column < N; column++) {
        depth[row * N + column] = land(column, row) ? 0 : deep;
      }
    }

    return depth;
  }

  const at = (map: Uint8Array, column: number, row: number) =>
    map[row * N + column] / 255;

  it("is everywhere on a sea with no land", () => {
    const map = exposure(
      chart(() => false),
      CELL,
      swell
    );

    expect(Math.min(...map)).toBe(255);
  });

  it("stops at land across its way", () => {
    // A coast from edge to edge, the sea to its south (rows go north to south).
    const map = exposure(
      chart((_, row) => row >= 120 && row < 124),
      CELL,
      swell
    );

    expect(at(map, 128, 200)).toBe(1);
    expect(at(map, 128, 126)).toBe(1);
    expect(at(map, 128, 122)).toBe(0);
    expect(at(map, 128, 100)).toBe(0);
    expect(at(map, 128, 10)).toBe(0);
  });

  it("comes through a gap in part, and spreads thinner beyond it", () => {
    const map = exposure(
      chart(
        (column, row) => row >= 120 && row < 124 && Math.abs(column - 128) > 6
      ),
      CELL,
      swell
    );

    const inside = at(map, 128, 110);
    const beyond = at(map, 128, 40);

    expect(inside).toBeGreaterThan(0.5);
    expect(inside).toBeLessThan(1);
    expect(beyond).toBeGreaterThan(0.05);
    expect(beyond).toBeLessThan(inside);
    // Round the corner from the gap, none.
    expect(at(map, 30, 110)).toBe(0);
  });

  it("comes from where the sea does", () => {
    // A coast running north to south, the sea to its west.
    const map = exposure(
      chart((column) => column >= 120 && column < 124),
      CELL,
      { ...swell, from: 270 }
    );

    expect(at(map, 60, 128)).toBe(1);
    expect(at(map, 200, 128)).toBe(0);
  });

  it("is worn down by shoal water, the further the more, and long waves most", () => {
    // Deep to the south, a shelf ten metres deep north of row 128.
    const depth = chart(() => false);

    for (let row = 0; row < 128; row++) depth.fill(10, row * N, (row + 1) * N);

    const long = exposure(depth, CELL, swell);

    expect(at(long, 128, 200)).toBe(1);
    expect(at(long, 128, 118)).toBeLessThan(0.95);
    expect(at(long, 128, 28)).toBeLessThan(at(long, 128, 118) / 2);

    // Waves 30 m long don't feel a bottom 10 m down.
    const short = exposure(depth, CELL, { from: 180, length: 30 });

    expect(at(short, 128, 28)).toBe(1);
  });

  it("grows back past the land, if it's the wind's own", () => {
    const coast = chart((_, row) => row >= 220 && row < 224);
    const map = exposure(coast, CELL, { ...swell, grows: 40_000 });

    // 2 km and 20 km downwind of it: a twentieth and half the energy.
    expect(at(map, 128, 200)).toBeCloseTo(Math.sqrt(2 / 40), 1);
    expect(at(map, 128, 20)).toBeCloseTo(Math.sqrt(20 / 40), 1);
  });

  it("leaves the harbour's own share of the sea standing where there's none", () => {
    expect(standing(0.9, 1)).toBe(1);
    expect(standing(0, 0)).toBe(1);
    expect(standing(1, 0)).toBe(0);
    // A quarter of the energy is half the height.
    expect(standing(0.75, 0)).toBe(0.5);
    expect(standing(0.75, 0.5)).toBeCloseTo(0.66, 2);
  });
});

describe("the open sea in the scene", () => {
  /** Lets requests in flight be answered, under the fake timers. */
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(0);
      }
    });

  function answer(waves: () => Response) {
    const asked: string[] = [];

    server.use(
      http.get(`${ORIGIN}/api/waves`, ({ request }) => {
        asked.push(request.url);

        return waves();
      })
    );

    return asked;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    setSceneTime(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    setSceneTime(null);
    history.replaceState(null, "", "/");
  });

  it("is unknown until the buoy's heard from, then as it measured", async () => {
    answer(() => HttpResponse.json(reading(NOW - 25 * 60_000)));

    const { result } = renderHook(() => useSwell());

    expect(result.current).toBeNull();

    await settle();

    expect(result.current).toEqual({ height: 2, period: 10, direction: 185 });
  });

  it("is asked after again every ten minutes, and follows the buoy", async () => {
    let height = 2;

    const asked = answer(() =>
      HttpResponse.json(reading(NOW - 25 * 60_000 + height, height))
    );

    const { result } = renderHook(() => useSwell());

    await settle();
    height = 3;
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000 - 1));
    await settle();

    expect(asked).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(1));
    await settle();

    expect(asked).toHaveLength(2);
    expect(result.current?.height).toBe(3);
  });

  it("stays unknown when the buoy's reading is old", async () => {
    answer(() => HttpResponse.json(reading(NOW - 4 * 3600_000)));

    const { result } = renderHook(() => useSwell());

    await settle();

    expect(result.current).toBeNull();
  });

  it("stays unknown when the buoy can't be had", async () => {
    answer(() =>
      HttpResponse.json({ error: "waves unavailable" }, { status: 502 })
    );

    const { result } = renderHook(() => useSwell());

    await settle();

    expect(result.current).toBeNull();
  });

  it("is ?swell's, with one to try out, and the buoy's not asked", async () => {
    history.replaceState(null, "", "/?swell=5,12,180");
    const asked = answer(() => HttpResponse.json(reading(NOW)));

    const { result } = renderHook(() => useSwell());

    await settle();

    expect(asked).toEqual([]);
    expect(result.current).toEqual({ height: 5, period: 12, direction: 180 });
  });

  it("is left to the wind with ?swell=wind", async () => {
    history.replaceState(null, "", "/?swell=wind");
    const asked = answer(() => HttpResponse.json(reading(NOW)));

    const { result } = renderHook(() => useSwell());

    await settle();

    expect(asked).toEqual([]);
    expect(result.current).toBeNull();
  });
});
