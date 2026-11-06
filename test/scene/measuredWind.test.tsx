// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSceneTime } from "../../src/components/scene/clock";
import type { Calibration } from "../../src/components/scene/wind/estimate";
import { useMeasuredWind } from "../../src/components/scene/wind/stations";
import type { WindReadings } from "../../src/lib/windStations";
import { NOW } from "../clock";
import { server } from "../msw";

// The scene's wind at sea: the forecast's, set right by the weather
// stations once they and how to read them have been fetched.

const ORIGIN = "http://localhost:3000";

const forecast = { speed: 8, direction: 340 };

/** One station reading just what the wind at sea is, and sure of it. */
const same: [number, number] = [1, 0];

const calibration: Calibration = {
  directions: 16,
  stations: [
    {
      site: "NRFA at Belmont",
      gain: Array.from({ length: 16 }, () => same),
      scatter: Array.from({ length: 16 }, () => 0.01),
    },
  ],
};

const readings = (time: number): WindReadings => ({
  time,
  stations: [{ site: "NRFA at Belmont", speed: 12, direction: 330, at: time }],
});

/** Lets requests in flight be answered, under the fake timers. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(0);
    }
  });

function answer(wind: () => Response) {
  const asked: string[] = [];

  server.use(
    http.get(`${ORIGIN}/api/wind`, ({ request }) => {
      asked.push(request.url);

      return wind();
    }),
    http.get(`${ORIGIN}/wind/stations.json`, () =>
      HttpResponse.json(calibration)
    )
  );

  return asked;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date"],
  });
  vi.setSystemTime(NOW);
  setSceneTime(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  setSceneTime(null);
  history.replaceState(null, "", "/");
});

describe("the wind at sea", () => {
  it("is the forecast's until the stations are heard from, then theirs", async () => {
    answer(() => HttpResponse.json(readings(NOW - 60_000)));

    const { result } = renderHook(() => useMeasuredWind(forecast));

    expect(result.current).toBe(forecast);

    await settle();

    expect(result.current).toEqual({ speed: 12, direction: 330 });
  });

  it("stays the forecast's when the stations' readings are old", async () => {
    answer(() => HttpResponse.json(readings(NOW - 2 * 3600_000)));

    const { result } = renderHook(() => useMeasuredWind(forecast));

    await settle();

    expect(result.current).toBe(forecast);
  });

  it("stays the forecast's when the stations can't be had", async () => {
    answer(() =>
      HttpResponse.json({ error: "wind unavailable" }, { status: 502 })
    );

    const { result } = renderHook(() => useMeasuredWind(forecast));

    await settle();

    expect(result.current).toBe(forecast);
  });

  it("isn't asked for with ?wind trying a wind out", async () => {
    history.replaceState(null, "", "/?wind=20,180");
    const asked = answer(() => HttpResponse.json(readings(NOW)));

    const { result } = renderHook(() => useMeasuredWind(forecast));

    await settle();

    expect(asked).toEqual([]);
    expect(result.current).toBe(forecast);
  });
});
