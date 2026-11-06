import type { NextApiRequest, NextApiResponse } from "next";
import { loadWind } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import type { WindReadings } from "../../lib/windStations";

/**
 * The wind at each of GWRC's weather stations on the map, for the homepage
 * scene, as the AWS poller logged it (see lib/live.ts): it asks every five
 * minutes. Now, or with `?at=<epoch ms>` then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WindReadings | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const wind = await loadWind(at);

    if (!wind) throw new Error("nothing measured yet");
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=60, stale-while-revalidate=300", at)
    );
    res.status(200).json(wind);
  } catch (e) {
    console.error("[wind] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "wind unavailable" });
  }
}
