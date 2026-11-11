import { describe, expect, it } from "vitest";
import { createGovernor, SCALES } from "../../src/components/scene/governor";

// The scene's render scale, following the time between frames.

/** The screen's refresh, ms: frames come on whole ones. */
const REFRESH = 1000 / 60;

/**
 * Runs the governor for `seconds` on a machine that takes `cost(scale)` ms
 * to draw a frame, shown at the screen's next refresh, or every `cap`
 * refreshes at most. Returns the scale each frame was drawn at.
 */
function run(
  governor: ReturnType<typeof createGovernor>,
  seconds: number,
  cost: (scale: number, time: number) => number,
  { cap = 1, steady = true } = {}
) {
  const scales: number[] = [];
  let scale = 1;

  for (let time = 0; time < seconds * 1000;) {
    const refreshes = Math.max(Math.ceil(cost(scale, time) / REFRESH), cap);
    const interval = refreshes * REFRESH;

    time += interval;
    scale = governor.frame(interval / 1000, steady);
    scales.push(scale);
  }

  return scales;
}

/** How many times the scale changed. */
const changes = (scales: number[]) =>
  scales.filter((scale, i) => i > 0 && scale !== scales[i - 1]).length;

describe("createGovernor", () => {
  const governed = () => createGovernor({ fixed: null, on: true });

  it("stays at full size while frames keep up", () => {
    const scales = run(governed(), 120, () => 12);

    expect(new Set(scales)).toEqual(new Set([1]));
  });

  it("settles at the size that keeps up, without hunting", () => {
    // 30 ms at full size, by the pixel: under 16.7 from 0.7 down.
    const scales = run(governed(), 600, (scale) => 30 * scale * scale);

    expect(scales.at(-1)).toBe(0.7);

    // Down in two steps, then a try at the next size up now and then, each
    // twice as long after the last: a handful in ten minutes.
    expect(changes(scales)).toBeLessThanOrEqual(14);

    const late = scales.slice(-Math.round(60_000 / REFRESH));

    expect(changes(late)).toBeLessThanOrEqual(2);
  });

  it("goes back up when the load lifts", () => {
    const governor = governed();

    run(governor, 60, (scale) => 30 * scale * scale);

    const scales = run(governor, 600, () => 10);

    expect(scales.at(-1)).toBe(1);
  });

  it("gives up where drawing smaller doesn't help", () => {
    // A browser holding the page to 30 frames a second.
    const scales = run(governed(), 300, () => 10, { cap: 2 });

    expect(Math.min(...scales)).toBe(SCALES.at(-1));
    expect(scales.at(-1)).toBe(1);
    // Down once, back up once, and no more tries.
    expect(changes(scales)).toBe(SCALES.length);
  });

  it("ignores the odd long frame", () => {
    const scales = run(governed(), 120, (_, time) =>
      Math.floor(time / 1000) % 5 === 0 && time % 1000 < 17 ? 120 : 12
    );

    expect(new Set(scales)).toEqual(new Set([1]));
  });

  it("holds while the scene isn't steady", () => {
    const scales = run(governed(), 60, () => 60, { steady: false });

    expect(new Set(scales)).toEqual(new Set([1]));
  });

  it("holds a scale that's asked for", () => {
    const scales = run(createGovernor({ fixed: 0.6, on: true }), 30, () => 60);

    expect(new Set(scales)).toEqual(new Set([0.6]));
  });

  it("holds at full size when it's off", () => {
    const scales = run(
      createGovernor({ fixed: null, on: false }),
      30,
      () => 60
    );

    expect(new Set(scales)).toEqual(new Set([1]));
  });
});
