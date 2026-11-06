import { describe, expect, it } from "vitest";
import {
  type Calibration,
  estimate,
  fromVelocity,
  velocity,
  type Wind,
} from "../../src/components/scene/wind/estimate";
import type { StationReading } from "../../src/lib/windStations";

// The wind out at sea from the forecast and what the stations read, each
// read through how it's read against the wind at sea before.

/** A station that reads `gain` (a speed-up, and a turn in degrees) whichever way it blows. */
function station(site: string, speedUp: number, turn: number, scatter: number) {
  const angle = (turn * Math.PI) / 180;

  const gain: [number, number] = [
    speedUp * Math.cos(angle),
    speedUp * Math.sin(angle),
  ];

  return {
    site,
    gain: Array.from({ length: 16 }, () => gain),
    scatter: Array.from({ length: 16 }, () => scatter),
  };
}

/** What a station with `gain` reads under the wind at sea `wind`. */
function reads(
  site: string,
  wind: Wind,
  speedUp: number,
  turn: number
): StationReading {
  const [x, z] = velocity(wind);
  const angle = (turn * Math.PI) / 180;
  const [c, s] = [Math.cos(angle) * speedUp, Math.sin(angle) * speedUp];

  return { site, ...fromVelocity([x * c - z * s, x * s + z * c]), at: 0 };
}

const forecast: Wind = { speed: 8, direction: 340 };
const atSea: Wind = { speed: 14, direction: 320 };

describe("the wind at sea", () => {
  it("is the forecast's without stations it knows", () => {
    const calibration: Calibration = { directions: 16, stations: [] };

    const wind = estimate(
      forecast,
      [reads("Somewhere", atSea, 0.5, 0)],
      calibration
    );

    expect(wind.stations).toBe(0);
    expect(wind.speed).toBeCloseTo(8);
    expect(wind.direction).toBeCloseTo(340);
  });

  it("is what steady stations say, read through how they're slowed and turned", () => {
    const calibration: Calibration = {
      directions: 16,
      stations: [
        station("Hill", 0.8, -40, 0.01),
        station("Valley", 0.3, 20, 0.005),
      ],
    };

    const wind = estimate(
      forecast,
      [reads("Hill", atSea, 0.8, -40), reads("Valley", atSea, 0.3, 20)],
      calibration
    );

    expect(wind.stations).toBe(2);
    expect(wind.speed).toBeCloseTo(14, 0);
    expect(wind.direction).toBeCloseTo(320, 0);
  });

  it("is between the forecast and unsteady stations", () => {
    const calibration: Calibration = {
      directions: 16,
      stations: [station("Hill", 1, 0, 0.35)],
    };

    const wind = estimate(forecast, [reads("Hill", atSea, 1, 0)], calibration);

    // As sure of each: halfway, as vectors.
    const [fx, fz] = velocity(forecast);
    const [sx, sz] = velocity(atSea);
    const halfway = fromVelocity([(fx + sx) / 2, (fz + sz) / 2]);

    expect(wind.speed).toBeCloseTo(halfway.speed, 1);
    expect(wind.direction).toBeCloseTo(halfway.direction, 0);
  });

  it("leaves out a station far from the forecast and the rest", () => {
    const calibration: Calibration = {
      directions: 16,
      stations: [station("Hill", 1, 0, 0.1), station("Stuck", 1, 0, 0.1)],
    };

    const wind = estimate(
      forecast,
      [
        reads("Hill", forecast, 1, 0),
        reads("Stuck", { speed: 60, direction: 160 }, 1, 0),
      ],
      calibration
    );

    expect(wind.stations).toBe(1);
    expect(wind.speed).toBeCloseTo(8);
  });

  it("reads each station for the way it's blowing, between the directions given", () => {
    // Calm from the north (0°), twice as windy from the north-north-east
    // (22.5°): from 11.25°, halfway.
    const hill = station("Hill", 1, 0, 0.001);
    hill.gain[0] = [0.5, 0];
    hill.gain[1] = [1, 0];

    const wind = estimate(
      { speed: 10, direction: 11.25 },
      [reads("Hill", { speed: 10, direction: 11.25 }, 0.75, 0)],
      { directions: 16, stations: [hill] }
    );

    expect(wind.speed).toBeCloseTo(10, 1);
  });
});
