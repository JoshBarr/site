import type { NextApiRequest, NextApiResponse } from "next";
import { loadVessels } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import { isStale, type VesselsResponse } from "../../lib/vessels";

/**
 * Ships in Wellington Harbour for the homepage scene, from Open Waters AIS,
 * as the AWS poller logged them (see lib/live.ts): now, or with `?at=<epoch
 * ms>` then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<VesselsResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const vessels = await loadVessels(at);
    const time = at ?? Date.now();
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=10, stale-while-revalidate=20", at)
    );
    res.status(200).json({
      time,
      vessels: vessels.filter((vessel) => !isStale(vessel, time)),
    });
  } catch (e) {
    console.error("[vessels] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "vessels unavailable" });
  }
}
