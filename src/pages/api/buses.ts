import type { NextApiRequest, NextApiResponse } from "next";
import { type BusesResponse, fresh } from "../../lib/buses";
import { loadBuses } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";

/**
 * Buses around Wellington for the homepage scene, from Metlink, as the AWS
 * poller logged them (see lib/live.ts): now, or with `?at=<epoch ms>` then
 * (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<BusesResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const buses = await loadBuses(at);
    const time = at ?? Date.now();
    res.setHeader(
      "Cache-Control",
      // Buses are drawn 45 s behind live; a fix can wait up to 20 s to be
      // polled, then 10 s here and up to 10 s more served stale.
      cacheFor("public, s-maxage=10, stale-while-revalidate=10", at)
    );
    res.status(200).json({
      time,
      buses: fresh(buses, time),
    });
  } catch (e) {
    console.error("[buses] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "buses unavailable" });
  }
}
