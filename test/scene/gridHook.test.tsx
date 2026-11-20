// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSceneTime } from "../../src/components/scene/clock";
import { SUBSTATIONS } from "../../src/components/scene/power/feed";
import { useGridFlow } from "../../src/components/scene/power/flow";
import type { GridFlow } from "../../src/lib/gridFlow";
import { NOW } from "../clock";
import { server } from "../msw";

// What the grid's carrying, as the scene asks /api/grid for it: nothing
// known until it answers, asked again as time runs on and when it's set.

const ORIGIN = "http://localhost:3000";

const UNKNOWN = {
  link: null,
  levels: SUBSTATIONS.map(() => 1),
  farms: { westWind: null, millCreek: null },
};

const sending = (mw: number, time: number): GridFlow => ({
  hvdc: { time, mw },
  northIsland: null,
  sites: null,
});

/** Lets requests in flight be answered, under the fake timers. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(0);
    }
  });

function answer(grid: () => Response) {
  const asked: string[] = [];

  server.use(
    http.get(`${ORIGIN}/api/grid`, ({ request }) => {
      asked.push(new URL(request.url).search);

      return grid();
    })
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

describe("what the scene knows of the grid", () => {
  it("is nothing until /api/grid answers, then what it's carrying", async () => {
    answer(() => HttpResponse.json(sending(900, NOW - 1800_000)));

    const { result } = renderHook(() => useGridFlow());

    expect(result.current).toEqual(UNKNOWN);

    await settle();

    expect(result.current.link).toEqual({ heading: 1, transfer: 0.75 });
  });

  it("stays nothing when it can't be had", async () => {
    answer(() =>
      HttpResponse.json({ error: "grid unavailable" }, { status: 502 })
    );

    const { result } = renderHook(() => useGridFlow());
    const before = result.current;

    await settle();

    // The same thing: nothing downstream is worked out again.
    expect(result.current).toBe(before);
  });

  it("asks again every five minutes, and lets what it knows go stale", async () => {
    const asked = answer(() => HttpResponse.json(sending(900, NOW - 1800_000)));
    const { result } = renderHook(() => useGridFlow());

    await settle();
    expect(asked).toHaveLength(1);

    // Transpower's stopped posting: an hour and three quarters on, what
    // was half an hour old is past two.
    for (let minutes = 0; minutes < 95; minutes += 5) {
      await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
      await settle();
    }

    expect(asked).toHaveLength(20);
    expect(result.current.link).toBeNull();
  });

  it("asks for it as it was when the scene's clock is set back", async () => {
    const asked = answer(() =>
      HttpResponse.json(sending(-300, NOW - 3 * 3600_000))
    );

    const { result } = renderHook(() => useGridFlow());

    await settle();
    // Three hours old now: not known.
    expect(result.current.link).toBeNull();

    act(() => setSceneTime(NOW - 2.5 * 3600_000));
    await settle();

    expect(asked).toEqual(["", `?at=${NOW - 2.5 * 3600_000 - 20_000}`]);
    expect(result.current.link).toEqual({ heading: -1, transfer: 0.25 });
  });

  it("goes by ?hvdc before anything's heard, and after", async () => {
    history.replaceState(null, "", "/?hvdc=-600");
    answer(() => HttpResponse.json(sending(900, NOW - 1800_000)));

    const { result } = renderHook(() => useGridFlow());

    expect(result.current.link).toEqual({ heading: -1, transfer: 0.5 });

    await settle();

    expect(result.current.link).toEqual({ heading: -1, transfer: 0.5 });
  });
});
