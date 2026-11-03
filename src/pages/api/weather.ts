import type { NextApiRequest, NextApiResponse } from "next";
import { loadWeather } from "../../lib/live";
import type { Conditions } from "../../lib/weather";

/**
 * Current Wellington weather for the homepage scene, from MetService, as
 * the AWS poller logged it (see lib/live.ts): it asks every half hour.
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<Conditions | { error: string }>
) {
  try {
    const weather = await loadWeather();

    if (!weather) throw new Error("nothing fetched yet");
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600"
    );
    res.status(200).json(weather);
  } catch (e) {
    console.error("[weather] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "weather unavailable" });
  }
}
