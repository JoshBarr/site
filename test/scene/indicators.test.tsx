// @vitest-environment happy-dom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "../clock";

// What the scene shows while it's busy: the corner spinner and the first
// view's progress as tiles stream in, and "Travelling…" on the way to
// another time. Their state's kept in modules, so each test imports them
// afresh, with the React they render with.

const DAY = 24 * 3600_000;

async function load() {
  vi.resetModules();

  return {
    ...(await import("@testing-library/react")),
    ...(await import("../../src/components/scene/loading")),
    ...(await import("../../src/components/scene/SceneLoading")),
    ...(await import("../../src/components/scene/time/Travelling")),
    ...(await import("../../src/components/scene/time/jump")),
  };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** Runs the clock on `ms`, in the steps the spinner looks in. */
const wait = async ({ act }: Loaded, ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
      "Date",
    ],
  });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  history.replaceState(null, "", "/");
});

describe("the corner spinner", () => {
  /** Whether it's showing: it fades rather than going. */
  const showing = ({ screen }: Loaded) => {
    const status = screen.getByRole("status");

    return (
      status.style.opacity === "1" &&
      status.getAttribute("aria-label") === "Loading"
    );
  };

  it("shows only once loads have run half a second, and goes once they've stopped a while", async () => {
    const l = await load();
    let inFlight = 0;

    l.addLoadingSource(() => inFlight);
    l.render(<l.SceneLoading started hidden={false} />);

    // Most land within a frame or two.
    inFlight = 2;
    await wait(l, 400);
    inFlight = 0;
    await wait(l, 400);
    expect(showing(l)).toBe(false);

    inFlight = 2;
    await wait(l, 800);
    expect(showing(l)).toBe(true);

    inFlight = 0;
    await wait(l, 200);
    expect(showing(l)).toBe(true);
    await wait(l, 400);
    expect(showing(l)).toBe(false);
  });

  it("keeps away while the scene does", async () => {
    const l = await load();

    l.addLoadingSource(() => 1);
    l.render(<l.SceneLoading started hidden />);
    await wait(l, 2000);

    expect(showing(l)).toBe(false);
  });

  it("settles once the first view's in and nothing's loaded for a second", async () => {
    const l = await load();
    const settled = vi.fn();
    let inFlight = 0;
    let queued = 0;

    l.addLoadingSource(
      () => inFlight,
      () => queued
    );

    const { rerender } = l.render(
      <l.SceneLoading started={false} hidden={false} onSettled={settled} />
    );

    // Nothing's streamed before it's started: idle isn't settled.
    await wait(l, 3000);
    expect(settled).not.toHaveBeenCalled();

    rerender(<l.SceneLoading started hidden={false} onSettled={settled} />);
    inFlight = 3;
    queued = 2;
    await wait(l, 400);

    // Two of five done.
    inFlight = 1;
    l.countLoaded();
    l.countLoaded();
    await wait(l, 400);
    expect(l.firstViewProgress()).toBeCloseTo(0.4, 6);

    // More wanted as finer tiles are: the share falls, the progress doesn't.
    queued = 10;
    await wait(l, 400);
    expect(l.firstViewProgress()).toBeCloseTo(0.4, 6);

    // All in, but not yet a second without loads.
    inFlight = 0;
    queued = 0;
    l.countLoaded();
    l.countLoaded();
    l.countLoaded();
    await wait(l, 400);
    expect(l.firstViewProgress()).toBe(0.99);
    expect(settled).not.toHaveBeenCalled();
    expect(l.hasFirstViewLoaded()).toBe(false);

    await wait(l, 1000);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(l.hasFirstViewLoaded()).toBe(true);
    expect(l.firstViewProgress()).toBe(1);

    await wait(l, 5000);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe("travelling to another time", () => {
  it("says so over the map until every layer's there, and a moment after", async () => {
    const l = await load();

    l.render(<l.Travelling hidden={false} />);
    expect(l.screen.getByRole("status").textContent).toBe("");

    l.act(() => l.jump(NOW - DAY));
    const layer = l.arrive();

    await wait(l, 0);
    expect(l.screen.getByRole("status").textContent).toBe("Travelling…");

    l.act(() => layer());
    await wait(l, 300);
    expect(l.screen.getByRole("status").textContent).toBe("Travelling…");

    await wait(l, 200);
    expect(l.screen.getByRole("status").textContent).toBe("");
  });

  it("says so while a jump waits its turn", async () => {
    const l = await load();

    l.render(<l.Travelling hidden={false} />);

    l.act(() => l.jump(NOW - DAY));
    l.act(() => l.jump(NOW - 2 * DAY));
    expect(l.screen.getByRole("status").textContent).toBe("Travelling…");

    await wait(l, 5000);
    await wait(l, 500);
    expect(l.screen.getByRole("status").textContent).toBe("");
  });

  it("keeps away while the scene does", async () => {
    const l = await load();

    l.render(<l.Travelling hidden />);
    l.act(() => l.jump(NOW - DAY));
    l.arrive();
    await wait(l, 0);

    expect(l.screen.getByRole("status").textContent).toBe("");
  });
});
