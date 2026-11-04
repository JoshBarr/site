import { describe, expect, it } from "vitest";
import type { CableCarTrip } from "../../src/lib/cablecar";
import {
  carsAt,
  coveredDay,
  dayAt,
  dayStart,
  positionsAt,
  runsOn,
} from "../../src/components/scene/cablecar/timetable";

const STOPS = { KELB: 0, SALA: 0.275, TALA: 0.513, CLIF: 0.753, LAMB: 1 };

/** As Metlink's feed has them: 7:30 and 7:40 both ways, Wednesdays. */
const TIMETABLE = {
  start: "20261102",
  end: "20261113",
  services: { Weekday: ["20261104"] },
  trips: [7.5, 7 + 40 / 60].flatMap((hour): CableCarTrip[] => {
    const s = hour * 3600;

    return [
      {
        service: "Weekday",
        direction: 1,
        stops: [
          ["KELB", s],
          ["SALA", s + 77],
          ["TALA", s + 146],
          ["CLIF", s + 218],
          ["LAMB", s + 300],
        ],
      },
      {
        service: "Weekday",
        direction: 0,
        stops: [
          ["LAMB", s],
          ["CLIF", s + 81],
          ["TALA", s + 153],
          ["SALA", s + 222],
          ["KELB", s + 300],
        ],
      },
    ];
  }),
};

/** Wellington time on Wednesday 4 November 2026 (NZDT). */
const at = (time: string) => Date.parse(`2026-11-04T${time}+13:00`);

describe("the cable car", () => {
  const runs = runsOn(TIMETABLE, STOPS, "20261104");

  it("runs once a departure: the trips up and down are the same cable", () => {
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({
      times: ["07:30:00", "07:31:17", "07:32:26", "07:33:38", "07:35:00"].map(
        at
      ),
      at: [0, 0.275, 0.513, 0.753, 1],
      up: [1, 0.753, 0.513, 0.275, 0],
      down: 0,
    });
    expect(runs[1].down).toBe(1);
  });

  it("waits with one car at each end before the first run", () => {
    expect(carsAt(runs, at("06:00:00"))).toEqual([0, 1]);
  });

  it("crosses at Talavera, both cars standing there", () => {
    for (const time of ["07:32:20", "07:32:26", "07:32:32"]) {
      const [a, b] = carsAt(runs, at(time));

      expect(a).toBeCloseTo(0.513);
      expect(b).toBeCloseTo(0.513);
    }
  });

  it("stands both cars at a pair of stops together", () => {
    // Salamanca going down, Clifton coming up.
    const [a, b] = carsAt(runs, at("07:31:17"));

    expect(a).toBeCloseTo(0.275);
    expect(b).toBeCloseTo(0.753);
  });

  it("swaps the cars' ends each run", () => {
    expect(carsAt(runs, at("07:35:00"))).toEqual([1, 0]);
    expect(carsAt(runs, at("07:38:00"))).toEqual([1, 0]);
    expect(carsAt(runs, at("07:45:00"))).toEqual([0, 1]);
    expect(carsAt(runs, at("12:00:00"))).toEqual([0, 1]);
  });

  it("pulls away and in gently, never faster than it could", () => {
    const run = runs[0];
    let last = positionsAt(run, at("07:30:00"));

    for (let t = at("07:30:01"); t <= at("07:35:00"); t += 1000) {
      const now = positionsAt(run, t);

      // One down and the other up, under ~6 m/s on the ~630 m line.
      expect(now[0]).toBeGreaterThanOrEqual(last[0]);
      expect(now[1]).toBeLessThanOrEqual(last[1]);
      expect((now[0] - last[0]) * 630).toBeLessThan(6);
      expect((last[1] - now[1]) * 630).toBeLessThan(6);
      last = now;
    }

    // Barely moving a second after leaving.
    expect(positionsAt(run, at("07:30:01"))[0] * 630).toBeLessThan(0.2);
  });

  it("doesn't run on a day without its service", () => {
    expect(runsOn(TIMETABLE, STOPS, "20261105")).toEqual([]);
  });
});

describe("cable car days", () => {
  it("are Wellington's", () => {
    expect(dayAt(Date.parse("2026-11-03T11:30:00Z"))).toBe("20261104");
    expect(dayAt(Date.parse("2026-11-03T10:30:00Z"))).toBe("20261103");
  });

  it("start at midnight, or noon less 12 hours when the clocks change", () => {
    expect(dayStart("20261104")).toBe(Date.parse("2026-11-04T00:00:00+13:00"));
    expect(dayStart("20260601")).toBe(Date.parse("2026-06-01T00:00:00+12:00"));
    // Daylight saving started at 2 am on 27 September 2026.
    expect(dayStart("20260927")).toBe(Date.parse("2026-09-26T23:00:00+12:00"));
  });

  it("past the feed run as the same day of a week it covers", () => {
    expect(coveredDay(TIMETABLE, "20261104")).toBe("20261104");
    // Wednesdays.
    expect(coveredDay(TIMETABLE, "20261021")).toBe("20261104");
    expect(coveredDay(TIMETABLE, "20261125")).toBe("20261111");
  });
});
