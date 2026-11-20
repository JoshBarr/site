// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSceneTime } from "../../src/components/scene/clock";
import { useRadar } from "../../src/components/scene/radar";
import {
  type Radar,
  RADAR_SIZE,
  type RadarScan,
  rateByte,
} from "../../src/lib/radarGrid";
import { NOW } from "../clock";
import { server } from "../msw";

// The rain radar's scans, fetched for the scene: each cell's byte back as a
// rate, asked for again every two minutes, and dropped once they're old.

const ORIGIN = "http://localhost:3000";

const MINUTE = 60_000;

/** 4 mm/h over the west half of the grid, dry over the east. */
const westWet = Uint8Array.from({ length: RADAR_SIZE ** 2 }, (_, k) =>
  k % RADAR_SIZE < RADAR_SIZE / 2 ? rateByte(4) : 0
);

const scan = (time: number, cells = westWet): RadarScan => ({
  time,
  cells: Buffer.from(cells).toString("base64"),
});

/** Lets requests in flight be answered, under the fake timers. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(0);
    }
  });

/** Runs the clock on `ms`, letting fetches answer as it goes. */
const wait = async (ms: number) => {
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await settle();
};

function answer(radar: () => Radar | Response) {
  const asked: string[] = [];

  server.use(
    http.get(`${ORIGIN}/api/radar`, ({ request }) => {
      asked.push(request.url);

      const answered = radar();

      return answered instanceof Response
        ? answered
        : HttpResponse.json(answered);
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

describe("the radar's scans", () => {
  it("are each cell's rate, oldest first, once fetched", async () => {
    answer(() => ({
      scans: [scan(NOW - 18 * MINUTE), scan(NOW - 8 * MINUTE)],
    }));

    const { result } = renderHook(() => useRadar());

    expect(result.current).toBeNull();

    await settle();

    expect(result.current?.map(({ time }) => time)).toEqual([
      NOW - 18 * MINUTE,
      NOW - 8 * MINUTE,
    ]);

    const { rates } = result.current![1];

    expect(rates).toHaveLength(RADAR_SIZE ** 2);
    expect(rates[0]).toBeCloseTo(4, 1);
    expect(rates[RADAR_SIZE - 1]).toBe(0);
  });

  it("are asked for every two minutes, and kept while there's no newer", async () => {
    let scans = [scan(NOW - 8 * MINUTE)];
    const asked = answer(() => ({ scans }));
    const { result } = renderHook(() => useRadar());

    await settle();

    const first = result.current;

    await wait(2 * MINUTE);
    expect(asked).toHaveLength(2);
    expect(result.current).toBe(first);

    scans = [...scans, scan(NOW + 2 * MINUTE)];
    await wait(2 * MINUTE);
    expect(result.current).toHaveLength(2);
  });

  it("are dropped once the newest is old, though it's still what's served", async () => {
    answer(() => ({ scans: [scan(NOW - 37 * MINUTE)] }));

    const { result } = renderHook(() => useRadar());

    await settle();
    expect(result.current).toHaveLength(1);

    await wait(4 * MINUTE);
    expect(result.current).toBeNull();
  });

  it("are nothing when there are none, a scan's the wrong size, or it fails", async () => {
    for (const radar of [
      () => ({ scans: [] }),
      () => ({ scans: [scan(NOW, Uint8Array.from([1, 2, 3]))] }),
      () => new HttpResponse(null, { status: 502 }),
    ]) {
      answer(radar);

      const { result } = renderHook(() => useRadar());

      await settle();
      expect(result.current).toBeNull();
      cleanup();
    }
  });

  it("are asked for as they were at a time the scene's set to", async () => {
    const asked = answer(() => ({ scans: [scan(NOW - 3600_000)] }));

    setSceneTime(NOW - 3600_000 + 5 * MINUTE);
    renderHook(() => useRadar());
    await settle();

    // To the minute, so replays share the CDN's copy.
    expect(new URL(asked[0]).searchParams.get("at")).toBe(
      String(Math.floor((NOW - 3600_000 + 5 * MINUTE) / MINUTE) * MINUTE)
    );
  });

  it("aren't asked for with the rain tried out, or switched off", async () => {
    const asked = answer(() => ({ scans: [scan(NOW)] }));

    for (const search of ["?rain=4", "?off=radar"]) {
      history.replaceState(null, "", `/${search}`);
      renderHook(() => useRadar());
      await settle();
      cleanup();
    }

    expect(asked).toEqual([]);
  });
});
