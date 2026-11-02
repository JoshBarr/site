import { MetserviceForecast } from "./types/metservice";

export const kelvinToCelcius = (num: number) => {
  return num - 273.15;
};

export const humanTemp = (degrees: number) => {
  return degrees.toFixed(1);
};

export async function getForecast() {
  const apiKey = process.env.METSERVICE_API_KEY;

  if (!apiKey) {
    throw new Error("missing METSERVICE_API_KEY");
  }

  const url = "https://forecast-v2.metoceanapi.com/point/time";

  const data = {
    points: [{ lon: 174.7787, lat: -41.276825 }],
    variables: [
      "air.temperature.at-2m",
      "air.visibility",
      "wind.speed.at-10m",
      "wind.direction.at-10m",
      "wind.speed.gust.at-10m",
      "wave.height",
    ],
    time: {
      from: new Date().toISOString(),
      interval: "6h",
      repeat: 3,
    },
  };

  const options = {
    method: "post",
    body: JSON.stringify(data),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
  };

  try {
    const response = await fetch(url, options);

    let body = (await response.json()) as unknown;

    if (response.ok) {
      return body as MetserviceForecast;
    }

    console.error("[weather] error:", JSON.stringify(body, null, 2));

    return { error: new Error(`received status ${response.status}`) };
  } catch (e) {
    return { error: e };
  }
}

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
  /** At 10m: drives the sea. Direction is where the wind blows from. */
  wind: { speed: number; direction: number };
  /** At 100m: drives the clouds. */
  windAloft: { speed: number; direction: number };
}

const CONDITION_VARIABLES = [
  "cloud.cover",
  "cloud.base.height",
  "air.visibility",
  "air.humidity.at-2m",
  "precipitation.rate",
  "wind.speed.at-10m",
  "wind.direction.at-10m",
  "wind.speed.at-100m",
  "wind.direction.at-100m",
];

export async function getConditions(): Promise<Conditions | null> {
  const apiKey = process.env.METSERVICE_API_KEY;
  if (!apiKey) {
    console.error("[weather] missing METSERVICE_API_KEY");
    return null;
  }

  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);

  try {
    const response = await fetch(
      "https://forecast-v2.metoceanapi.com/point/time",
      {
        method: "post",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          points: [{ lon: 174.7787, lat: -41.276825 }],
          variables: CONDITION_VARIABLES,
          time: { from: hour.toISOString(), interval: "1h", repeat: 0 },
        }),
      }
    );
    const body = await response.json();
    if (!response.ok) {
      console.error("[weather] error:", JSON.stringify(body));
      return null;
    }

    const value = (name: string): number | null =>
      body.variables?.[name]?.data?.[0] ?? null;

    return {
      time: hour.toISOString(),
      cloudCover: (value("cloud.cover") ?? 0) / 100,
      cloudBase: value("cloud.base.height"),
      visibility: value("air.visibility") ?? 30000,
      humidity: (value("air.humidity.at-2m") ?? 70) / 100,
      precipitation: value("precipitation.rate") ?? 0,
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
