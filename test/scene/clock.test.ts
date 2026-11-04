// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "../clock";

// The scene's clock, jumping it to another time, and the loading progress:
// each keeps its state in its module, so each test imports them afresh.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** The clock and jumps as a page at `search` starts with them. */
async function load(search = "") {
  history.replaceState(null, "", `/${search}`);
  vi.resetModules();

  return {
    ...(await import("../../src/components/scene/clock")),
    ...(await import("../../src/components/scene/time/jump")),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => history.replaceState(null, "", "/"));

describe("the scene's clock", () => {
  it("is now, running, without anything asked for", async () => {
    const clock = await load();

    expect(clock.sceneNow()).toBe(NOW);
    vi.advanceTimersByTime(5 * SECOND);
    expect(clock.sceneNow()).toBe(NOW + 5 * SECOND);
    expect(clock.layerUrl("/api/buses")).toBe("/api/buses");
  });

  it("starts at ?t=, running on from there", async () => {
    const clock = await load("?t=2026-11-01T07:00:00Z");
    const then = Date.parse("2026-11-01T07:00:00Z");

    expect(clock.sceneNow()).toBe(then);
    vi.advanceTimersByTime(5 * SECOND);
    expect(clock.sceneNow()).toBe(then + 5 * SECOND);
  });

  it("ignores a ?t= that isn't a time", async () => {
    const clock = await load("?t=yesterday");

    expect(clock.sceneNow()).toBe(NOW);
    expect(clock.layerUrl("/api/buses")).toBe("/api/buses");
  });

  it("holds still with ?freeze, as a replay", async () => {
    const clock = await load("?freeze");

    // Held from when it's first read.
    expect(clock.sceneNow()).toBe(NOW);
    vi.advanceTimersByTime(MINUTE);
    expect(clock.sceneNow()).toBe(NOW);
    // NOW's on a whole ten seconds.
    expect(clock.layerUrl("/api/buses")).toBe(`/api/buses?at=${NOW}`);

    // Set while frozen, it holds at the new time.
    clock.setSceneTime(NOW - DAY);
    vi.advanceTimersByTime(MINUTE);
    expect(clock.sceneNow()).toBe(NOW - DAY);
  });

  it("tells those listening each time it's set", async () => {
    const clock = await load();
    // With the React the clock has, imported afresh with it.
    const { act, renderHook } = await import("@testing-library/react");
    const { result, unmount } = renderHook(() => clock.useSeek());

    expect(result.current).toEqual({ epoch: NOW, replaying: false });

    act(() => clock.setSceneTime(NOW - DAY));
    expect(result.current).toEqual({ epoch: NOW - DAY, replaying: true });

    act(() => clock.setSceneTime(null));
    expect(result.current).toEqual({ epoch: NOW, replaying: false });
    unmount();
  });

  describe("replaying", () => {
    it("asks for layers on a whole step, adding to a query", async () => {
      const clock = await load();

      clock.setSceneTime(NOW - DAY + 12_345);

      expect(clock.layerUrl("/api/buses")).toBe(
        `/api/buses?at=${NOW - DAY + 10_000}`
      );

      expect(clock.layerUrl("/api/flights?history", MINUTE)).toBe(
        `/api/flights?history&at=${Math.floor((NOW - DAY) / MINUTE) * MINUTE}`
      );
    });

    it("asks for nothing further back than the logs go", async () => {
      const clock = await load();

      clock.setSceneTime(NOW - 30 * DAY + MINUTE);
      expect(clock.layerUrl("/api/buses")).not.toBeNull();

      clock.setSceneTime(NOW - 30 * DAY - MINUTE);
      expect(clock.layerUrl("/api/buses")).toBeNull();
    });

    it("takes times as the scene's, not the server's", async () => {
      const clock = await load();

      expect(clock.skewFrom(NOW - 1500)).toBe(1500);
      clock.setSceneTime(NOW - DAY);
      expect(clock.skewFrom(NOW - 1500)).toBe(0);
    });
  });
});

describe("jumping to a time", () => {
  it("goes there now, the first time, and says so in the address", async () => {
    const clock = await load();

    clock.jump(NOW - DAY);

    expect(clock.sceneNow()).toBe(NOW - DAY);
    expect(new URL(location.href).searchParams.get("t")).toBe(
      new Date(NOW - DAY).toISOString()
    );
  });

  it("goes live for a time within a couple of minutes of now", async () => {
    const clock = await load("?t=2026-11-01T07:00:00Z");

    clock.jump(NOW - 90 * SECOND);

    expect(clock.sceneNow()).toBe(NOW);
    expect(location.search).toBe("");
  });

  it("keeps a time inside the logs, with room for the trails", async () => {
    const clock = await load();

    clock.jump(NOW - 40 * DAY);

    expect(clock.sceneNow()).toBe(NOW - 30 * DAY + clock.MARGIN);
  });

  it("waits five seconds after the last, the newest pick replacing those waiting", async () => {
    const clock = await load();

    clock.jump(NOW - 2 * DAY);
    vi.advanceTimersByTime(SECOND);

    clock.jump(NOW - 3 * DAY);
    clock.jump(NOW - 4 * DAY);
    expect(clock.isTravelling()).toBe(true);
    expect(clock.sceneNow()).toBe(NOW - 2 * DAY + SECOND);

    vi.advanceTimersByTime(4 * SECOND);
    expect(clock.sceneNow()).toBe(NOW - 4 * DAY);
    expect(clock.isTravelling()).toBe(false);
  });

  it("goes back to live straight away, waiting or not", async () => {
    const clock = await load();

    clock.jump(NOW - 2 * DAY);
    clock.jump(NOW - 3 * DAY);
    clock.jump(null);

    expect(clock.isTravelling()).toBe(false);
    expect(clock.sceneNow()).toBe(NOW);

    vi.advanceTimersByTime(10 * SECOND);
    expect(clock.sceneNow()).toBe(NOW + 10 * SECOND);
  });

  it("travels until every layer that set out has arrived, once each", async () => {
    const clock = await load();
    const first = clock.arrive();

    // The page's first load isn't travelling.
    expect(clock.isTravelling()).toBe(false);
    first();

    clock.jump(NOW - DAY);
    const buses = clock.arrive();
    const trains = clock.arrive();

    buses();
    buses();
    expect(clock.isTravelling()).toBe(true);

    trains();
    expect(clock.isTravelling()).toBe(false);
  });
});

describe("the scene's loading", () => {
  const loading = async () => {
    vi.resetModules();

    return import("../../src/components/scene/loading");
  };

  it("counts what's in flight, and what's done of all asked for", async () => {
    const l = await loading();
    let inFlight = 3;
    let queued = 5;

    const remove = l.addLoadingSource(
      () => inFlight,
      () => queued
    );

    expect(l.loadingCount()).toBe(3);
    expect(l.loadedShare()).toBe(0);

    inFlight = 2;
    queued = 4;
    l.countLoaded();
    l.countLoaded();
    expect(l.loadedShare()).toBe(2 / 8);

    remove();
    expect(l.loadingCount()).toBe(0);
    expect(l.loadedShare()).toBe(1);
  });

  it("counts a promise until it settles, failed or not", async () => {
    const l = await loading();
    let fail: (e: Error) => void = () => {};

    const tracked = l.track(
      new Promise<void>((_, reject) => {
        fail = reject;
      })
    );

    expect(l.loadingCount()).toBe(1);
    fail(new Error("404"));
    await expect(tracked).rejects.toThrow("404");

    expect(l.loadingCount()).toBe(0);
    expect(l.loadedShare()).toBe(1);
  });

  it("tells those listening how far the first view's come, until it's in", async () => {
    const l = await loading();
    const heard: number[] = [];

    const stop = l.subscribeFirstViewProgress(() =>
      heard.push(l.firstViewProgress())
    );

    l.startFirstView();
    l.setFirstViewProgress(0.4);
    l.setFirstViewProgress(0.4);
    expect(l.hasFirstViewLoaded()).toBe(false);

    l.finishFirstView();
    expect(l.hasFirstViewLoaded()).toBe(true);

    l.startFirstView();
    stop();
    l.setFirstViewProgress(0.5);

    expect(heard).toEqual([0.4, 1, 0]);
  });
});

describe("set views", () => {
  const shots = async () => {
    vi.resetModules();

    return import("../../src/components/scene/shots/shots");
  };

  it("each have their own id, and look level or down", async () => {
    const { SHOTS } = await shots();

    expect(new Set(SHOTS.map(({ id }) => id)).size).toBe(SHOTS.length);

    for (const { view } of SHOTS) expect(view[5]).toBeLessThanOrEqual(view[2]);
  });

  it("are found from ?shot=", async () => {
    const { shotFromUrl } = await shots();

    history.replaceState(null, "", "/?shot=airport");
    expect(shotFromUrl()?.name).toBe("Airport");

    history.replaceState(null, "", "/?shot=nowhere");
    expect(shotFromUrl()).toBeNull();
  });

  it("go to the camera while it's connected, and only then", async () => {
    const { SHOTS, connectCamera, currentView, goTo } = await shots();
    const went = vi.fn();

    goTo(SHOTS[0]);
    expect(currentView()).toBeNull();

    const disconnect = connectCamera(() => SHOTS[1].view, went);

    goTo(SHOTS[0]);
    expect(went).toHaveBeenCalledWith(SHOTS[0].view);
    expect(currentView()).toEqual(SHOTS[1].view);

    // A newer camera's connected: the old one going leaves it be.
    const newer = vi.fn();
    connectCamera(() => null, newer);
    disconnect();
    goTo(SHOTS[2]);
    expect(newer).toHaveBeenCalledWith(SHOTS[2].view);
  });
});
