// @vitest-environment happy-dom
import { fireEvent } from "@testing-library/dom";
import { http, HttpResponse } from "msw/http";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METRICS,
  type Metric,
  nzMidnight,
  nextDay,
  SLOT,
  type TimelineDay,
} from "../../src/lib/timeline";
import { NOW } from "../clock";
import { server } from "../msw";

// The time-travel drawer: the last 30 days of the timeline, a day at a
// time from /api/timeline, to pick a moment to replay from.

const ORIGIN = "http://localhost:3000";
const MINUTE = 60_000;

/** The drawer's timeline is this wide, px. */
const WIDTH = 1000;

/** A day of the timeline, the same every slot. */
function day(date: string): TimelineDay {
  const start = nzMidnight(date);
  const end = nzMidnight(nextDay(date));
  const slots = (end - start) / SLOT;

  const values: Record<Metric, number> = {
    flights: 12,
    ships: 3,
    trains: 7,
    buses: 140,
    roads: 81.4,
    tide: -0.25,
    temperature: 14.56,
    rain: 0,
    cloud: 0.4,
    wind: 8,
  };

  return {
    day: date,
    start,
    end,
    series: Object.fromEntries(
      METRICS.map((m) => [m, Array<number | null>(slots).fill(values[m])])
    ),
    quakes: [],
  };
}

/** Serves each day asked for with `answer`, keeping the days asked. */
function timeline(
  answer: (date: string) => Response = (date) => HttpResponse.json(day(date))
) {
  const asked: string[] = [];

  server.use(
    http.get(`${ORIGIN}/api/timeline`, ({ request }) => {
      const date = new URL(request.url).searchParams.get("day") ?? "";
      asked.push(date);

      return answer(date);
    })
  );

  return asked;
}

/**
 * The drawer, open or not, with the React, clock and caches a page just
 * loaded has: each keeps its state in its module.
 */
async function load(open: boolean) {
  vi.resetModules();

  const rtl = await import("@testing-library/react");

  const { TimeTravel } =
    await import("../../src/components/scene/time/TimeTravel");

  const clock = await import("../../src/components/scene/clock");

  const { container } = rtl.render(
    <TimeTravel open={open}>
      <button type="button">Riding along</button>
    </TimeTravel>
  );

  /** The timeline itself: what's dragged, hovered and clicked. */
  const track = container.querySelector<HTMLElement>('[style*="touch-action"]');

  if (!track) throw new Error("no timeline");

  // Where it is on screen: scrolled along under the drawer's left edge.
  vi.spyOn(track, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(-(track.parentElement?.scrollLeft ?? 0), 0, 0, 0)
  );

  /** Until the days in view are in. */
  const loaded = () =>
    rtl.waitFor(() =>
      expect(rtl.screen.queryByRole("status", { name: "Loading" })).toBeNull()
    );

  /** The column reading out each row at the time in focus. */
  const values = () => {
    const column = container.querySelector<HTMLElement>(
      '[style*="width: 76px"]'
    );

    if (!column) throw new Error("no values");

    return [...column.children].map((value) => value.textContent);
  };

  return { ...rtl, ...clock, container, track, loaded, values };
}

/**
 * Scroll positions, which happy-dom keeps at 0 as it lays nothing out:
 * kept as set, each telling the element it's scrolled, as a browser does.
 */
function scrollable() {
  const left = new WeakMap<Element, number>();

  vi.spyOn(Element.prototype, "scrollLeft", "get").mockImplementation(function (
    this: Element
  ) {
    return left.get(this) ?? 0;
  });

  vi.spyOn(Element.prototype, "scrollLeft", "set").mockImplementation(function (
    this: Element,
    value: number
  ) {
    left.set(this, value);
    this.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  history.replaceState(null, "", "/");
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(WIDTH);
  scrollable();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  history.replaceState(null, "", "/");
});

describe("the time-travel drawer", () => {
  it("asks for nothing while it's shut, and can't be reached", async () => {
    const asked = timeline();
    const { container, screen } = await load(false);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(asked).toEqual([]);
    expect(container.querySelector("[inert]")).not.toBeNull();
    // What rides on it is there all the same.
    expect(screen.getByRole("button", { name: "Riding along" })).toBeTruthy();
  });

  it("spins until the days around now are in, then shows them", async () => {
    const asked = timeline();
    const { screen, loaded } = await load(true);

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    await loaded();

    // Three days across, now most of the way, and the day before: today's
    // the last. Each once, and none from where the range starts.
    expect([...asked].sort()).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);

    for (const row of [
      "Quakes",
      "Flights",
      "Ships",
      "Trains",
      "Buses",
      "Roads",
      "Tide",
      "Temp",
      "Rain",
    ]) {
      expect(screen.getByText(row)).toBeTruthy();
    }
  });

  it("reads out each row at the scene's time", async () => {
    timeline();
    const { loaded, values } = await load(true);

    await loaded();

    expect(values()).toEqual([
      "12",
      "3",
      "7",
      "140",
      "81 km/h",
      "−0.25 m",
      "14.6°",
      "dry",
    ]);
  });

  it("gets on without the days it can't have", async () => {
    timeline(() => new HttpResponse(null, { status: 500 }));
    const { loaded, values } = await load(true);

    await loaded();

    expect(values()).toEqual(Array(8).fill("–"));
  });

  it("asks for days scrolled to as they come into view", async () => {
    const asked = timeline();
    const { track, loaded } = await load(true);

    await loaded();
    const scroller = track.parentElement;

    if (!scroller) throw new Error("no scroller");

    // A week back.
    scroller.scrollLeft -= 7 * (WIDTH / 3);

    await vi.waitFor(() => expect(asked).toContain("2026-10-26"));
  });

  it("zooms between a day, three and a week across", async () => {
    timeline();
    const { screen, track, loaded } = await load(true);

    await loaded();
    const width = () => parseFloat(track.style.width);
    const threeDays = width();
    const button = (name: string) => screen.getByRole("button", { name });

    expect(button("3 days").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button("A day"));
    expect(width()).toBeCloseTo(threeDays * 3, 3);

    fireEvent.click(button("7 days"));
    expect(width()).toBeCloseTo((threeDays * 3) / 7, 3);

    // Pressing the one pressed leaves it.
    fireEvent.click(button("7 days"));
    expect(button("7 days").getAttribute("aria-pressed")).toBe("true");
    expect(width()).toBeCloseTo((threeDays * 3) / 7, 3);

    await loaded();
  });

  describe("picking a moment", () => {
    /** The pointer pressed `x` px across the timeline, and let go `drag` on. */
    async function pick(x: number, drag = 0) {
      timeline();
      const loaded = await load(true);
      const { track } = loaded;
      const pointer = { pointerType: "mouse", pointerId: 1, button: 0 };

      await loaded.loaded();
      fireEvent.pointerDown(track, { ...pointer, clientX: x });
      fireEvent.pointerMove(track, { ...pointer, clientX: x + drag });
      fireEvent.pointerUp(track, { ...pointer, clientX: x + drag });

      return loaded;
    }

    it("jumps there, on a whole point of the timeline", async () => {
      // Now's 80% across; 400 px back is 1.2 days, three days across.
      const { sceneNow } = await pick(400);
      const t = new URL(location.href).searchParams.get("t") ?? "";

      // On a whole ten minutes: a point's width at this zoom.
      expect(Date.parse(t) % (10 * MINUTE)).toBe(0);
      expect(sceneNow()).toBe(Date.parse(t));
      expect((NOW - sceneNow()) / (24 * 60 * MINUTE)).toBeCloseTo(1.2, 2);
    });

    it("doesn't jump when the timeline's dragged", async () => {
      const { sceneNow } = await pick(400, 30);

      expect(location.search).toBe("");
      expect(sceneNow()).toBe(NOW);
    });

    it("can't pick later than now", async () => {
      const { sceneNow } = await pick(900);

      // That's live.
      expect(location.search).toBe("");
      expect(sceneNow()).toBe(NOW);
    });
  });

  it("says when the pointer's over, and reads out the rows then", async () => {
    timeline((date) =>
      HttpResponse.json(
        date === "2026-11-01"
          ? {
              ...day(date),
              series: { ...day(date).series, flights: [], rain: [] },
            }
          : day(date)
      )
    );

    const { track, loaded, values } = await load(true);

    await loaded();

    const label = () =>
      [...track.querySelectorAll("div")].find((d) =>
        /^\w{3}, \d+ \w{3}, \d+:\d\d [ap]m$/.test(d.textContent ?? "")
      );

    // A day back, onto the day without flights.
    fireEvent.pointerMove(track, {
      clientX: WIDTH * 0.8 - WIDTH / 3 - 50,
      pointerType: "mouse",
    });

    expect(label()?.textContent).toMatch(/^Sun, 1 Nov/);
    expect(values()[0]).toBe("–");
    expect(values()[7]).toBe("–");

    fireEvent.pointerOut(track, { relatedTarget: document.body });

    expect(label()).toBeUndefined();
    expect(values()[0]).toBe("12");
  });
});

describe("the timeline's days", () => {
  /** The hook as a page just loaded has it, its cache empty. */
  async function days() {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout"],
    });
    vi.setSystemTime(NOW);
    vi.resetModules();

    const rtl = await import("@testing-library/react");

    const { useTimelineDays } =
      await import("../../src/components/scene/time/useTimeline");

    /** Runs the clock on `ms`, letting what's asked be answered. */
    const wait = (ms: number) =>
      rtl.act(async () => {
        await vi.advanceTimersByTimeAsync(ms);

        for (let i = 0; i < 20; i++) {
          await new Promise((resolve) => setImmediate(resolve));
          await vi.advanceTimersByTimeAsync(0);
        }
      });

    return { ...rtl, useTimelineDays, wait };
  }

  it("asks for each day once, and today again as it goes", async () => {
    const asked = timeline();
    const { renderHook, useTimelineDays, wait } = await days();
    const wanted = ["2026-11-01", "2026-11-02"];

    const { result } = renderHook(() =>
      useTimelineDays(wanted, "2026-11-02", true)
    );

    expect(result.current.settled).toBe(false);
    await wait(0);

    expect(result.current.settled).toBe(true);
    expect([...result.current.days.keys()]).toEqual(wanted);

    // Two minutes on: each tick's a minute, and today's asked again once
    // it's more than a minute old.
    await wait(121_000);

    expect(asked.filter((d) => d === "2026-11-01")).toHaveLength(1);
    expect(asked.filter((d) => d === "2026-11-02").length).toBeGreaterThan(1);
  });

  it("shares what it's had between panels", async () => {
    const asked = timeline();
    const { renderHook, useTimelineDays, wait } = await days();

    renderHook(() => useTimelineDays(["2026-10-20"], "2026-11-02", true));
    await wait(0);

    const { result } = renderHook(() =>
      useTimelineDays(["2026-10-20"], "2026-11-02", true)
    );

    expect(result.current.days.get("2026-10-20")).toMatchObject({
      day: "2026-10-20",
    });

    expect(asked).toEqual(["2026-10-20"]);
  });

  it("is settled once a day's failed, and asks again later", async () => {
    let failing = true;

    const asked = timeline((date) =>
      failing
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json(day(date))
    );

    const { renderHook, useTimelineDays, wait } = await days();

    const { result } = renderHook(() =>
      useTimelineDays(["2026-10-20"], "2026-11-02", true)
    );

    await wait(0);
    expect(result.current).toMatchObject({ settled: true, days: new Map() });

    failing = false;
    await wait(121_000);

    expect(asked).toHaveLength(2);
    expect(result.current.days.has("2026-10-20")).toBe(true);
  });

  it("asks nothing while it's not wanted, or for no days", async () => {
    const asked = timeline();
    const { renderHook, useTimelineDays, wait } = await days();

    const { result } = renderHook(() =>
      useTimelineDays(["2026-10-20"], "2026-11-02", false)
    );

    const none = renderHook(() => useTimelineDays([], "2026-11-02", true));

    await wait(120_000);

    expect(asked).toEqual([]);
    expect(result.current.settled).toBe(false);
    expect(none.result.current.settled).toBe(false);
  });
});
