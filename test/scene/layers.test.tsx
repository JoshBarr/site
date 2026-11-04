// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlights } from "../../src/components/scene/flights/useFlights";
import { useBuses } from "../../src/components/scene/buses/useBuses";
import { useTimetable } from "../../src/components/scene/cablecar/useTimetable";
import { setSceneTime } from "../../src/components/scene/clock";
import { useQuakes } from "../../src/components/scene/quakes/useQuakes";
import { useSatellites } from "../../src/components/scene/sky/useSatellites";
import { jump, useTravelling } from "../../src/components/scene/time/jump";
import { useHolidays } from "../../src/components/scene/traffic/useHolidays";
import { useTraffic } from "../../src/components/scene/traffic/useTraffic";
import { useTrains } from "../../src/components/scene/trains/useTrains";
import { useVessels } from "../../src/components/scene/vessels/useVessels";
import {
  lowCloudBase,
  useConditions,
  windVector,
} from "../../src/components/scene/weather";
import type { Aircraft, Fix } from "../../src/lib/flights";
import type { Quake } from "../../src/lib/quakes";
import { STALE } from "../../src/lib/traffic";
import { CSS, HST, ISS } from "../fixtures/celestrak";
import { NOW } from "../clock";
import { server } from "../msw";

// The live layers' hooks, as the scene polls its API routes: what each
// asks for and when, how it puts the server's times on the scene's clock,
// and what it keeps when a poll fails.

/** happy-dom's page, which the hooks' relative URLs resolve against. */
const ORIGIN = "http://localhost:3000";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** The server's clock: two seconds behind this browser's. */
const BEHIND = 2 * SECOND;

/** Answers `path` with `respond`, keeping each URL asked for. */
function route(path: string, respond: (url: URL) => Response) {
  const asked: URL[] = [];

  server.use(
    http.get(`${ORIGIN}${path}`, ({ request }) => {
      const url = new URL(request.url);
      asked.push(url);

      return respond(url);
    })
  );

  return asked;
}

/** Runs the clock on `ms`, letting fetches answer as it goes. */
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  });

/**
 * Lets requests in flight be answered: they go through happy-dom's fetch
 * and MSW on real I/O, which the fake timers don't run.
 */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  vi.setSystemTime(NOW);
  setSceneTime(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Unmounted, so their polls stop.
  cleanup();
  setSceneTime(null);
});

/** A thing at `time` (epoch ms), with its own fix as its trail. */
const moving = (id: string, time: number) => ({
  id,
  mmsi: Number(id.replace(/\D/g, "")) || 1,
  position: [1748800, 5427900],
  time,
  speed: 5,
  trail: [[1748800, 5427900, time]],
});

describe.each([
  { name: "buses", path: "/api/buses", every: 10 * SECOND, use: useBuses },
  { name: "trains", path: "/api/trains", every: 10 * SECOND, use: useTrains },
  {
    name: "vessels",
    path: "/api/vessels",
    every: 20 * SECOND,
    use: useVessels,
  },
])("the $name layer", ({ name, path, every, use }) => {
  /** The server's answer, with `items` in it at its time. */
  const answer =
    (...items: ReturnType<typeof moving>[]) =>
    () =>
      HttpResponse.json({ time: Date.now() - BEHIND, [name]: items });

  it("puts the server's times on this browser's clock", async () => {
    route(path, answer(moving("A1", NOW - 10 * SECOND - BEHIND)));

    const { result } = renderHook(() => use());

    expect(result.current).toEqual([]);
    await wait(0);

    expect(result.current).toMatchObject([
      {
        time: NOW - 10 * SECOND,
        trail: [[1748800, 5427900, NOW - 10 * SECOND]],
      },
    ]);
  });

  it("polls as often as the route refreshes", async () => {
    const asked = route(path, answer());

    renderHook(() => use());
    await wait(0);
    await wait(every - 1);
    expect(asked).toHaveLength(1);

    await wait(1);
    expect(asked).toHaveLength(2);
    expect(asked[1].search).toBe("");
  });

  it("keeps the last answer through a failed poll", async () => {
    route(path, answer(moving("A1", NOW - BEHIND)));
    const { result } = renderHook(() => use());

    await wait(0);
    const failed = route(path, () => new HttpResponse(null, { status: 503 }));
    await wait(every);

    expect(failed).toHaveLength(1);
    expect(result.current).toHaveLength(1);
  });

  it("skips polls while the tab's in the background", async () => {
    const asked = route(path, answer());
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    renderHook(() => use());
    await wait(3 * every);
    expect(asked).toHaveLength(0);

    hidden.mockReturnValue(false);
    await wait(every);
    expect(asked).toHaveLength(1);
  });

  it("asks for the scene's time when it's replaying, on a whole ten seconds", async () => {
    const then = NOW - 3 * DAY + 4321;
    act(() => setSceneTime(then));

    const asked = route(path, () =>
      // Replays are on the scene's clock already.
      HttpResponse.json({
        time: then,
        [name]: [moving("A1", then - 5 * SECOND)],
      })
    );

    const { result } = renderHook(() => use());
    await wait(0);

    expect(asked[0].searchParams.get("at")).toBe(String(NOW - 3 * DAY));
    expect(result.current).toMatchObject([{ time: then - 5 * SECOND }]);
  });

  it("asks nothing further back than the logs go", async () => {
    act(() => setSceneTime(NOW - 31 * DAY));
    const asked = route(path, answer());

    const { result } = renderHook(() => use());
    await wait(every);

    expect(asked).toEqual([]);
    expect(result.current).toEqual([]);
  });

  it("starts over, showing nothing until it's answered, when the clock's set", async () => {
    route(path, answer(moving("A1", NOW - BEHIND)));
    const { result } = renderHook(() => use());

    await wait(0);
    expect(result.current).toHaveLength(1);

    route(path, () => new HttpResponse(null, { status: 500 }));
    act(() => setSceneTime(NOW - DAY));

    expect(result.current).toEqual([]);
    await wait(0);
    expect(result.current).toEqual([]);
  });
});

describe("the buses layer, as buses go quiet", () => {
  it("drops one not heard from in five minutes", async () => {
    route("/api/buses", () =>
      HttpResponse.json({ time: Date.now(), buses: [moving("2158", NOW)] })
    );

    const { result } = renderHook(() => useBuses());
    await wait(0);

    route("/api/buses", () => new HttpResponse(null, { status: 503 }));
    await wait(5 * MINUTE - 10 * SECOND);
    expect(result.current).toHaveLength(1);

    await wait(20 * SECOND);
    expect(result.current).toEqual([]);
  });
});

describe("the flights layer", () => {
  /** A fix `seconds` before the server's NOW. */
  const fix = (seconds: number): Fix => [
    1752000,
    5431000,
    945,
    NOW - BEHIND - seconds * SECOND,
    90,
    200,
    -3,
  ];

  const anz = (fixes: Fix[], route?: Aircraft["route"]): Aircraft => ({
    hex: "c81e2c",
    callsign: "ANZ441",
    registration: "ZK-NHA",
    type: "A21N",
    category: "A3",
    ...(route !== undefined && { route }),
    fixes,
  });

  const AKL_WLG: Aircraft["route"] = {
    from: { code: "AKL", at: [1757000, 5720000], elevation: null },
    to: { code: "WLG", at: [1749000, 5427000], elevation: 12.5 },
  };

  const answer = (aircraft: Aircraft[]) => () =>
    HttpResponse.json({ time: Date.now() - BEHIND, aircraft });

  it("asks for the history first, then only what's new, merged in by time", async () => {
    let aircraft = [anz([fix(300), fix(60)], AKL_WLG)];
    const asked = route("/api/flights", () => answer(aircraft)());

    const { result } = renderHook(() => useFlights());
    await wait(0);

    // The later answer repeats one fix and leaves the route out: a lookup
    // that failed.
    aircraft = [anz([fix(60), fix(-5)])];
    await wait(10 * SECOND);

    expect(asked.map((url) => url.search)).toEqual(["?history", ""]);
    expect(result.current.skew).toBe(BEHIND);

    expect(result.current.aircraft).toEqual([
      anz([fix(300), fix(60), fix(-5)], AKL_WLG),
    ]);
  });

  it("lets fixes go once they're older than its history, and the aircraft with them", async () => {
    route("/api/flights", answer([anz([fix(6 * 60), fix(10)])]));

    const { result } = renderHook(() => useFlights());
    await wait(0);

    route("/api/flights", answer([]));
    await wait(2 * MINUTE);
    expect(result.current.aircraft[0].fixes).toEqual([fix(10)]);

    await wait(10 * MINUTE);
    expect(result.current.aircraft).toEqual([]);
  });

  it("asks for the history again after being in the background", async () => {
    const asked = route("/api/flights", answer([]));
    const hidden = vi.spyOn(document, "hidden", "get");

    renderHook(() => useFlights());
    await wait(0);
    hidden.mockReturnValue(true);
    await wait(10 * SECOND);
    hidden.mockReturnValue(false);
    await wait(10 * SECOND);

    expect(asked.map((url) => url.search)).toEqual(["?history", "?history"]);
  });

  it("polls every two minutes through the airport's curfew", async () => {
    // 2:00 am, NZDT.
    vi.setSystemTime(Date.parse("2026-11-02T02:00:00+13:00"));
    const asked = route("/api/flights", answer([]));

    renderHook(() => useFlights());
    await wait(0);
    await wait(MINUTE);
    expect(asked).toHaveLength(1);

    await wait(MINUTE);
    expect(asked).toHaveLength(2);
  });
});

describe("the quakes layer", () => {
  const quake = (id: string, time: number, magnitude = 3): Quake => ({
    id,
    time,
    position: [1748000, 5428000],
    depth: 12,
    magnitude,
    locality: "Wellington",
    quality: "automatic",
  });

  /** Ripple starts by quake, as the hook has them. */
  const starts = (shown: ReturnType<typeof useQuakes>) =>
    Object.fromEntries(
      [...shown.current].map(([id, { start }]) => [id, start])
    );

  it("ripples as each's heard of, if that's soon after it struck", async () => {
    route("/api/quakes", () =>
      HttpResponse.json({
        time: Date.now(),
        quakes: [
          quake("late", NOW - 5 * MINUTE),
          quake("old", NOW - 20 * MINUTE),
        ],
      })
    );

    const { result } = renderHook(() => useQuakes());
    await wait(0);

    expect(starts(result.current)).toEqual({ late: NOW, old: null });
  });

  it("ripples as it struck when replaying, keeping that as it's revised", async () => {
    const then = NOW - DAY;
    act(() => setSceneTime(then));

    // Replays come with those about to strike.
    route("/api/quakes", () =>
      HttpResponse.json({
        time: then,
        quakes: [quake("coming", then + 30 * SECOND)],
      })
    );

    const { result } = renderHook(() => useQuakes());
    await wait(0);
    expect(starts(result.current)).toEqual({ coming: then + 30 * SECOND });

    route("/api/quakes", () =>
      HttpResponse.json({
        time: then + MINUTE,
        quakes: [quake("coming", then + 30 * SECOND, 3.4)],
      })
    );

    await wait(MINUTE);

    expect(result.current.current.get("coming")).toMatchObject({
      quake: { magnitude: 3.4 },
      start: then + 30 * SECOND,
    });
  });

  it("lets those GeoNet's dropped go", async () => {
    route("/api/quakes", () =>
      HttpResponse.json({
        time: Date.now(),
        quakes: [quake("gone", NOW - MINUTE)],
      })
    );

    const { result } = renderHook(() => useQuakes());
    await wait(0);
    route("/api/quakes", () =>
      HttpResponse.json({ time: Date.now(), quakes: [] })
    );
    await wait(MINUTE);

    expect(result.current.current.size).toBe(0);
  });

  it("asks once even in the background, so a ripple's ready", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    const asked = route("/api/quakes", () =>
      HttpResponse.json({ time: Date.now(), quakes: [] })
    );

    renderHook(() => useQuakes());
    await wait(5 * MINUTE);

    expect(asked).toHaveLength(1);
  });

  it("strikes one to try out from ?quake=", async () => {
    history.replaceState(null, "", "/?quake=5.5,1750000,5430000,20,4");
    route("/api/quakes", () =>
      HttpResponse.json({ time: Date.now(), quakes: [] })
    );

    try {
      const { result } = renderHook(() => useQuakes());
      await wait(0);

      expect(result.current.current.get("trial")).toEqual({
        quake: expect.objectContaining({
          magnitude: 5.5,
          position: [1750000, 5430000],
          depth: 20,
          time: NOW + 4 * SECOND,
        }),
        start: NOW + 4 * SECOND,
      });
    } finally {
      history.replaceState(null, "", "/");
    }
  });
});

describe("the traffic layer", () => {
  const speeds = (fetchedAgo: number) => () =>
    HttpResponse.json({
      time: Date.now(),
      fetched: Date.now() - fetchedAgo,
      links: { "Ngauranga To Aotea|2.1": 81 },
      legs: {},
    });

  it("is ready once it's asked, with speeds if they're fresh", async () => {
    route("/api/traffic", speeds(MINUTE));
    const { result } = renderHook(() => useTraffic());

    expect(result.current).toMatchObject({ speeds: null, ready: false });
    await wait(0);

    expect(result.current).toMatchObject({
      speeds: { links: { "Ngauranga To Aotea|2.1": 81 } },
      ready: true,
    });
  });

  it("goes without speeds gone stale", async () => {
    route("/api/traffic", speeds(STALE));
    const { result } = renderHook(() => useTraffic());
    await wait(0);

    expect(result.current).toMatchObject({ speeds: null, ready: true });
  });

  it("is ready without speeds when it can't get any, so traffic can start", async () => {
    route("/api/traffic", () => new HttpResponse(null, { status: 503 }));
    const { result } = renderHook(() => useTraffic());
    await wait(0);

    expect(result.current).toMatchObject({ speeds: null, ready: true });
  });

  it("keeps the same answer when nothing's changed", async () => {
    route("/api/traffic", () => new HttpResponse(null, { status: 503 }));
    const { result } = renderHook(() => useTraffic());
    await wait(0);

    const first = result.current;
    await wait(MINUTE);

    expect(result.current).toBe(first);
  });
});

describe("the satellites layer", () => {
  it("runs the orbits fetched, asking again for the morning's in six hours", async () => {
    const asked = route("/api/satellites", () =>
      HttpResponse.json({ fetched: NOW, orbits: [ISS, HST, CSS] })
    );

    const { result } = renderHook(() => useSatellites());
    await wait(0);

    expect(result.current.map(({ name }) => name)).toHaveLength(3);
    await wait(6 * 60 * MINUTE - 1);
    expect(asked).toHaveLength(1);
    await wait(1);
    expect(asked).toHaveLength(2);
  });

  it("asks again a minute after failing", async () => {
    const asked = route(
      "/api/satellites",
      () => new HttpResponse(null, { status: 503 })
    );

    const { result } = renderHook(() => useSatellites());
    await wait(MINUTE);

    expect(asked).toHaveLength(2);
    expect(result.current).toEqual([]);
  });

  it("replays the day's, asking for a whole day", async () => {
    act(() => setSceneTime(NOW - 2 * DAY));

    const asked = route("/api/satellites", () =>
      HttpResponse.json({ fetched: NOW, orbits: [ISS] })
    );

    renderHook(() => useSatellites());
    await wait(0);

    const at = Number(asked[0].searchParams.get("at"));

    expect(at % DAY).toBe(0);
    expect(NOW - 2 * DAY - at).toBeLessThan(DAY);
  });

  it("has none further back than the logs go, without asking", async () => {
    act(() => setSceneTime(NOW - 40 * DAY));

    const asked = route("/api/satellites", () =>
      HttpResponse.json({ fetched: NOW, orbits: [ISS] })
    );

    const { result } = renderHook(() => useSatellites());
    await wait(0);

    expect(asked).toEqual([]);
    expect(result.current).toEqual([]);
  });
});

describe("the weather", () => {
  const conditions = {
    time: "2026-11-02T07:00:00.000Z",
    cloudCover: 0.2,
    cloudBase: 1100,
    visibility: 25000,
    humidity: 0.8,
    precipitation: 0.2,
    wind: { speed: 9, direction: 180 },
    windAloft: { speed: 12, direction: 190 },
  };

  afterEach(() => history.replaceState(null, "", "/"));

  it("is a fair northerly until MetService's arrive", async () => {
    route("/api/weather", () => HttpResponse.json(conditions));
    const { result } = renderHook(() => useConditions());

    expect(result.current).toMatchObject({
      cloudCover: 0.35,
      wind: { speed: 7, direction: 340 },
    });

    await wait(0);

    expect(result.current).toEqual({
      ...conditions,
      // A trace of rain is dry.
      precipitation: 0,
    });
  });

  it("is asked again every ten minutes, a new hour's taken", async () => {
    let answer = conditions;
    const asked = route("/api/weather", () => HttpResponse.json(answer));
    const { result } = renderHook(() => useConditions());

    await wait(0);
    const first = result.current;
    await wait(10 * MINUTE);

    // The same hour's again: nothing new.
    expect(asked).toHaveLength(2);
    expect(result.current).toBe(first);

    answer = {
      ...conditions,
      time: "2026-11-02T08:00:00.000Z",
      precipitation: 2,
    };
    await wait(10 * MINUTE);

    expect(result.current).toMatchObject({ precipitation: 2 });
  });

  it("can be tried out from the address", async () => {
    history.replaceState(null, "", "/?rain=4&vis=800&wind=15,200&base=300");
    route("/api/weather", () => HttpResponse.json(conditions));

    const { result } = renderHook(() => useConditions());
    await wait(0);

    expect(result.current).toMatchObject({
      precipitation: 4,
      // Rain brings cloud to fall from.
      cloudCover: 0.6,
      cloudBase: 300,
      visibility: 800,
      wind: { speed: 15, direction: 200 },
      windAloft: { speed: 21, direction: 200 },
    });
  });

  it("keeps the cover asked for, raining or not", async () => {
    history.replaceState(null, "", "/?rain=4&cloud=10&wind=oops");
    route("/api/weather", () => HttpResponse.json(conditions));

    const { result } = renderHook(() => useConditions());
    await wait(0);

    expect(result.current).toMatchObject({
      precipitation: 4,
      cloudCover: 0.1,
      wind: conditions.wind,
    });
  });

  it("puts the cloud base between 200 m and 2.5 km, guessing it from the cover", () => {
    const at = (cloudCover: number, cloudBase: number | null) =>
      lowCloudBase({ ...conditions, cloudCover, cloudBase });

    expect(at(0.5, 50)).toBe(200);
    expect(at(0.5, 4000)).toBe(2500);
    expect(at(0, null)).toBe(1400);
    expect(at(1, null)).toBe(700);
    expect(at(2, null)).toBe(700);
  });

  it("blows the way it's going: a northerly south, a westerly east", () => {
    const [x, z] = windVector(10, 0);
    const [wx, wz] = windVector(10, 270);

    expect(x).toBeCloseTo(0, 10);
    expect(z).toBeCloseTo(10, 10);
    expect(wx).toBeCloseTo(10, 10);
    expect(wz).toBeCloseTo(0, 10);
  });
});

describe("the cable car's timetable", () => {
  it("is null until it's answered, kept through a failure", async () => {
    const timetable = {
      from: "20261101",
      to: "20261130",
      services: {},
      runs: [],
    };

    route("/api/cablecar", () => HttpResponse.json(timetable));

    const { result } = renderHook(() => useTimetable());
    expect(result.current).toBeNull();
    await wait(0);
    expect(result.current).toEqual(timetable);

    const asked = route(
      "/api/cablecar",
      () => new HttpResponse(null, { status: 503 })
    );

    await wait(6 * 60 * MINUTE);
    await wait(MINUTE);

    expect(asked).toHaveLength(2);
    expect(result.current).toEqual(timetable);
  });
});

describe("the public holidays", () => {
  it("are asked for the scene's year in New Zealand", async () => {
    const asked = route("/api/holidays", () =>
      HttpResponse.json({ year: 2027, dates: ["2027-01-01"] })
    );

    // New Year's Day already in Wellington.
    const { result } = renderHook(() =>
      useHolidays(new Date("2026-12-31T12:00:00Z"))
    );

    expect(result.current).toEqual({ holidays: null, ready: false });
    await wait(0);

    expect(asked[0].searchParams.get("year")).toBe("2027");
    expect(result.current).toEqual({
      holidays: new Set(["2027-01-01"]),
      ready: true,
    });
  });

  it("are ready but unknown when they can't be had", async () => {
    route("/api/holidays", () => new HttpResponse(null, { status: 400 }));

    const { result } = renderHook(() => useHolidays(new Date(NOW)));
    await wait(0);

    expect(result.current).toEqual({ holidays: null, ready: true });
  });

  it("are asked again for another year", async () => {
    const asked = route("/api/holidays", (url) =>
      HttpResponse.json({
        year: Number(url.searchParams.get("year")),
        dates: [],
      })
    );

    const { rerender } = renderHook(({ time }) => useHolidays(time), {
      initialProps: { time: new Date(NOW) },
    });

    await wait(0);
    rerender({ time: new Date(NOW + 10 * DAY) });
    await wait(0);
    rerender({ time: new Date(NOW + 100 * DAY) });
    await wait(0);

    expect(asked.map((url) => url.searchParams.get("year"))).toEqual([
      "2026",
      "2027",
    ]);
  });
});

describe("travelling to another time", () => {
  it("lasts until every layer has its first answer from then", async () => {
    route("/api/buses", () =>
      HttpResponse.json({ time: Date.now(), buses: [] })
    );
    let answerTrains = false;

    route("/api/trains", () =>
      answerTrains
        ? HttpResponse.json({ time: Date.now(), trains: [] })
        : new HttpResponse(null, { status: 503 })
    );

    const { result } = renderHook(() => {
      useBuses();
      useTrains();

      return useTravelling();
    });

    await wait(0);
    expect(result.current).toBe(false);

    act(() => jump(NOW - DAY));
    expect(result.current).toBe(true);

    // The trains' poll fails: it counts as arrived all the same.
    await wait(0);
    expect(result.current).toBe(false);

    answerTrains = true;
    act(() => jump(null));
    await wait(0);
    expect(result.current).toBe(false);
  });
});
