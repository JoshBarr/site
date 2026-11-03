import type { NextApiRequest, NextApiResponse } from "next";
import { loadTrains } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import { isStale, type TrainsResponse } from "../../lib/trains";

/**
 * Trains on the Wellington network for the homepage scene, from Metlink, as
 * the AWS poller logged them (see lib/live.ts): now, or with `?at=<epoch
 * ms>` then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TrainsResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const trains = await loadTrains(at);
    const time = at ?? Date.now();
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=5, stale-while-revalidate=10", at)
    );
    res.status(200).json({
      time,
      trains: trains.filter((train) => !isStale(train, time)),
    });
  } catch (e) {
    console.error("[trains] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "trains unavailable" });
  }
}
