import { z } from "zod";
import type { CloudLayer } from "./metar";
import { readJson } from "./schemas";

/** Current weather for the homepage scene. Units: metres, m/s, degrees, 0..1. */
export interface Conditions {
  time: string;
  /** Fraction of sky covered. */
  cloudCover: number;
  /** Metres above sea level, or null when there's no cloud to have a base. */
  cloudBase: number | null;
  /** Metres. */
  visibility: number;
  /** Relative humidity, 0..1. */
  humidity: number;
  /** mm/h. */
  precipitation: number;
  /**
   * °C at 2 m. Missing from conditions logged before it was asked for, and
   * null when MetService has none.
   */
  temperature?: number | null;
  /** At 10m: drives the sea. Direction is where the wind blows from. */
  wind: { speed: number; direction: number };
  /** At 100m: drives the clouds. */
  windAloft: { speed: number; direction: number };
  /**
   * The cloud's layers as the airport's ceilometer saw them lately
   * (./metar.ts), lowest first: empty for none seen. Missing or null when
   * it's all forecast, which gives a cover and base, not layers.
   */
  layers?: CloudLayer[] | null;
  /** When what's observed in them was, epoch ms; missing or null if none. */
  observed?: number | null;
}

const CONDITION_VARIABLES = [
  "cloud.cover",
  "cloud.base.height",
  "air.visibility",
  "air.humidity.at-2m",
  "precipitation.rate",
  "air.temperature.at-2m",
  "wind.speed.at-10m",
  "wind.direction.at-10m",
  "wind.speed.at-100m",
  "wind.direction.at-100m",
];

const forecast = z.object({
  /** By name, each with a value for every time asked for. */
  variables: z.record(
    z.string(),
    z.object({ data: z.array(z.number().nullable()) })
  ),
});

const HOUR = 3_600_000;

/**
 * The hour whose forecast is nearest `now` (epoch ms), as MetService's
 * times are written: within half an hour, either way.
 */
export const forecastHour = (now = Date.now()) =>
  new Date(Math.round(now / HOUR) * HOUR).toISOString();

export async function getConditions(): Promise<Conditions | null> {
  const apiKey = process.env.METSERVICE_API_KEY;

  if (!apiKey) {
    console.error("[weather] missing METSERVICE_API_KEY");

    return null;
  }

  const hour = forecastHour();

  try {
    const response = await fetch(
      "https://forecast-v2.metoceanapi.com/point/time",
      {
        method: "post",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          points: [{ lon: 174.7787, lat: -41.276825 }],
          variables: CONDITION_VARIABLES,
          time: { from: hour, interval: "1h", repeat: 0 },
        }),
      }
    );

    if (!response.ok) {
      console.error(
        `[weather] HTTP ${response.status}:`,
        await response.text()
      );

      return null;
    }

    const { variables } = await readJson(response, forecast, "metservice");

    const value = (name: string): number | null =>
      variables[name]?.data[0] ?? null;

    // MetOcean gives it in kelvin.
    const kelvin = value("air.temperature.at-2m");

    return {
      time: hour,
      cloudCover: (value("cloud.cover") ?? 0) / 100,
      cloudBase: value("cloud.base.height"),
      visibility: value("air.visibility") ?? 30000,
      humidity: (value("air.humidity.at-2m") ?? 70) / 100,
      precipitation: value("precipitation.rate") ?? 0,
      temperature: kelvin === null ? null : kelvin - 273.15,
      wind: {
        speed: value("wind.speed.at-10m") ?? 5,
        direction: value("wind.direction.at-10m") ?? 340,
      },
      windAloft: {
        speed: value("wind.speed.at-100m") ?? 8,
        direction: value("wind.direction.at-100m") ?? 340,
      },
    };
  } catch (e) {
    console.error("[weather]", e);

    return null;
  }
}
