import { describe, expect, it } from "vitest";
import type { Fix } from "../../src/lib/flights";
import {
  addSample,
  HOUR,
  METRICS,
  nzDate,
  nzMidnight,
  type Sample,
  sample,
  SLOT,
  toDay,
} from "../../src/lib/timeline";
import type { Vessel } from "../../src/lib/vessels";
import { ago, NOW } from "../clock";

const AT: [number, number] = [1748900, 5428300];

// SAFETY: one entry for each of METRICS, which are Sample's keys.
const nothing = Object.fromEntries(
  METRICS.map((metric) => [metric, null])
) as Sample;

const ship = (speed: number, seconds: number): Vessel => ({
  mmsi: 512000000 + seconds,
  name: null,
  type: 60,
  position: AT,
  speed,
  course: null,
  heading: null,
  dimension: null,
  time: ago(seconds),
  trail: [],
});

const aircraft = (hex: string, altitude: number | null, seconds: number) => ({
  aircraft: {
    hex,
    callsign: null,
    registration: null,
    type: null,
    category: null,
  },
  fix: [...AT, altitude, ago(seconds), 120, 0, 0] satisfies Fix,
});

describe("the timeline", () => {
  describe("sample", () => {
    it("counts what the scene would draw", () => {
      const vehicle = (id: string, seconds: number) => ({
        id,
        direction: 0,
        position: AT,
        bearing: null,
        time: ago(seconds),
      });

      const taken = sample(
        {
          trains: {
            sk: ago(10),
            data: {
              trains: [
                { ...vehicle("FP4123", 20), line: "HVL" },
                // Out of service.
                { ...vehicle("FP4124", 6 * 60), line: "HVL" },
              ],
            },
          },
          buses: {
            sk: ago(10),
            data: { buses: [{ ...vehicle("2310", 30), route: "2" }] },
          },
          flights: {
            sk: ago(5),
            data: {
              sightings: [
                aircraft("c81e2c", 3000, 5),
                // On the ground, and long gone.
                aircraft("c81e2d", null, 5),
                aircraft("c81e2e", 3000, 90),
              ],
            },
          },
          vessels: {
            sk: ago(20),
            data: {
              // Under way, moored, and under way but quiet too long.
              vessels: [ship(12, 60), ship(0, 60), ship(12, 11 * 60)],
            },
          },
        },
        NOW
      );

      expect(taken).toMatchObject({
        trains: 1,
        buses: 1,
        flights: 1,
        ships: 1,
      });
    });

    it("counts nothing from polls left overnight, but not without one", () => {
      const taken = sample(
        {
          trains: {
            sk: ago(6 * 3600),
            data: {
              trains: [
                {
                  id: "FP4123",
                  line: "HVL",
                  direction: 0,
                  position: AT,
                  bearing: null,
                  time: ago(6 * 3600),
                },
              ],
            },
          },
        },
        NOW
      );

      expect(taken).toEqual({ ...nothing, trains: 0 });
    });

    it("weighs road speeds by length, and carries the tide on", () => {
      const taken = sample(
        {
          traffic: {
            sk: ago(30),
            data: { links: { "A To B|3": 100, "B To C|1": 20 }, legs: {} },
          },
          tide: {
            sk: ago(120),
            data: { time: ago(10 * 60), level: 0.5, rate: -0.6 },
          },
          weather: {
            sk: ago(20 * 60),
            data: {
              time: "2026-11-02T07:00:00.000Z",
              cloudCover: 0.4,
              cloudBase: 900,
              visibility: 30000,
              humidity: 0.8,
              precipitation: 1.5,
              temperature: 14.2,
              wind: { speed: 9, direction: 340 },
              windAloft: { speed: 12, direction: 340 },
            },
          },
        },
        NOW
      );

      expect(taken.tide).toBeCloseTo(0.4);
      expect(taken).toMatchObject({
        roads: 80,
        temperature: 14.2,
        rain: 1.5,
        cloud: 0.4,
        wind: 9,
      });
    });
  });

  describe("addSample", () => {
    const START = Date.parse("2026-11-02T07:00:00Z");

    it("sums each slot's samples, and counts them", () => {
      let hour = addSample(null, START + 20_000, { ...nothing, buses: 140 });

      hour = addSample(hour, START + 80_000, { ...nothing, buses: 150 });
      hour = addSample(hour, START + SLOT + 1, { ...nothing, buses: 7 });

      expect(hour.sums).toEqual({
        buses: [290, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      });
      expect(hour.counts).toEqual({
        buses: [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      });
    });

    it("keeps each quake once, as last revised, if it struck lately", () => {
      const quake = (id: string, time: number, magnitude: number) => ({
        id,
        time,
        position: AT,
        depth: 21.4,
        magnitude,
        locality: "10 km north of Wellington",
        quality: "automatic",
      });

      let hour = addSample(null, START + 60_000, nothing, [
        quake("2026p1", START - 10 * 60_000, 3.1),
        quake("2026p0", START - 3 * HOUR, 4),
      ]);

      hour = addSample(hour, START + 120_000, nothing, [
        quake("2026p1", START - 10 * 60_000, 3.04),
      ]);

      expect(hour.quakes).toEqual([
        {
          id: "2026p1",
          time: START - 10 * 60_000,
          magnitude: 3,
          depth: 21,
          locality: "10 km north of Wellington",
        },
      ]);
    });
  });

  describe("NZ days", () => {
    it("start at NZ midnight, daylight saving or not", () => {
      expect(nzMidnight("2026-11-04")).toBe(Date.parse("2026-11-03T11:00Z"));
      expect(nzMidnight("2026-07-01")).toBe(Date.parse("2026-06-30T12:00Z"));
      expect(nzDate(Date.parse("2026-11-03T11:00Z"))).toBe("2026-11-04");
      expect(nzDate(Date.parse("2026-11-03T10:59Z"))).toBe("2026-11-03");
    });

    it("are 23 hours when the clocks go forward", () => {
      const day = toDay("2026-09-27", []);

      expect(day.end - day.start).toBe(23 * HOUR);
    });
  });

  describe("toDay", () => {
    it("means each slot, and keeps the day's quakes", () => {
      const start = nzMidnight("2026-11-02");
      const end = nzMidnight("2026-11-03");

      const quake = {
        id: "2026p9",
        time: end - 60_000,
        magnitude: 2.5,
        depth: 5,
        locality: "Seatoun",
      };

      const day = toDay("2026-11-02", [
        {
          sk: start + HOUR,
          data: {
            sums: { trains: [24, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11] },
            counts: { trains: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2] },
            quakes: [],
          },
        },
        // The hour after the day, for quakes heard after midnight.
        {
          sk: end,
          data: {
            sums: { trains: Array(12).fill(1) },
            counts: { trains: Array(12).fill(1) },
            quakes: [quake],
          },
        },
      ]);

      const trains = day.series.trains ?? [];

      expect(trains).toHaveLength(24 * 12);
      expect(trains.slice(12, 24)).toEqual([4.8, ...Array(10).fill(null), 5.5]);
      expect(trains.filter((mean) => mean !== null)).toHaveLength(2);
      expect(day.quakes).toEqual([quake]);
    });
  });
});
