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
