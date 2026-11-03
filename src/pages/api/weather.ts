import type { NextApiRequest, NextApiResponse } from "next";
import { loadWeather } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import type { Conditions } from "../../lib/weather";

/**
 * Current Wellington weather for the homepage scene, from MetService, as
 * the AWS poller logged it (see lib/live.ts): it asks every half hour. Now,
 * or with `?at=<epoch ms>` then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Conditions | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const weather = await loadWeather(at);

    if (!weather) throw new Error("nothing fetched yet");
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=300, stale-while-revalidate=600", at)
    );
    res.status(200).json(weather);
  } catch (e) {
    console.error("[weather] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "weather unavailable" });
  }
}
