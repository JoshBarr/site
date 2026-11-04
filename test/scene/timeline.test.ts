import { describe, expect, it } from "vitest";
import {
  areaPath,
  linePath,
  peak,
  points,
  sunTimes,
  turns,
  valueAt,
} from "../../src/components/scene/time/marks";
import { HOUR, nzMidnight, SLOT, toDay } from "../../src/lib/timeline";

const START = nzMidnight("2026-11-04");

/** A day whose buses are `values`, a slot each from midnight. */
function day(values: (number | null)[]) {
  const timeline = toDay("2026-11-04", []);

  timeline.series.buses = [
    ...values,
    ...Array<null>(288 - values.length).fill(null),
  ];

  return timeline;
}

describe("the timeline's marks", () => {
  it("make several slots one point when they're too thin to draw", () => {
    const found = points(day([10, 20, null, 40]), "buses", 2, "mean");

    expect(found.slice(0, 2)).toEqual([
      { time: START + SLOT, value: 15 },
      { time: START + 3 * SLOT, value: 40 },
    ]);
    expect(points(day([10, 20]), "buses", 2, "max")[0].value).toBe(20);
    expect(valueAt(day([10, 20]), "buses", START + SLOT, 2, "mean")).toBe(15);
    expect(peak(found)).toEqual({ time: START + 3 * SLOT, value: 40 });
  });

  it("break lines and areas where nothing's known", () => {
    const found = [
      { time: 0, value: 1 },
      { time: 1, value: 2 },
      { time: 2, value: null },
      { time: 3, value: 3 },
    ];

    const x = (t: number) => t * 10;
    const y = (v: number) => 10 - v;

    // The point on its own is drawn a few pixels wide, or it wouldn't show.
    expect(linePath(found, x, y)).toBe("M0.0 9.0L10.0 8.0M28.5 7.0L31.5 7.0");
    expect(areaPath(found, x, y, 10)).toBe(
      "M0.0 10.0L0.0 9.0L10.0 8.0L10.0 10.0ZM28.5 10.0L28.5 7.0L31.5 7.0L31.5 10.0Z"
    );
  });

  it("find the tide's highs and lows, not the ends", () => {
    // Twelve hours and a half from high to high, sampled every 5 minutes.
    const tide = Array.from({ length: 2 * 288 }, (_, i) => ({
      time: START + i * SLOT,
      value: Math.cos((2 * Math.PI * i * SLOT) / (12.42 * HOUR)),
    }));

    const found = turns(tide, 3 * HOUR);

    expect(found.map(({ kind }) => kind)).toEqual([
      "low",
      "high",
      "low",
      "high",
      "low",
      "high",
      "low",
    ]);
    // Not the high at midnight, with nothing known before it.
    expect(found[0].time - START).toBeCloseTo(6.21 * HOUR, -6);
  });

  it.each([
    // Wellington's solstice sunrises and sunsets, as almanacs give them.
    ["2026-12-21", "05:44", "20:57"],
    ["2026-06-21", "07:47", "16:58"],
  ])("know when the sun rises and sets on %s", (date, risen, gone) => {
    const start = nzMidnight(date);
    const { rise, set } = sunTimes(start, start + 24 * HOUR);

    const clock = (time: number | null) =>
      time === null
        ? null
        : new Date(time).toLocaleTimeString("en-NZ", {
            timeZone: "Pacific/Auckland",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          });

    const minutes = (hhmm: string | null) =>
      hhmm === null
        ? NaN
        : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

    // Within a few minutes: the formulae are good to ~0.1°.
    expect(Math.abs(minutes(clock(rise)) - minutes(risen))).toBeLessThanOrEqual(
      4
    );
    expect(Math.abs(minutes(clock(set)) - minutes(gone))).toBeLessThanOrEqual(
      4
    );
  });
});
