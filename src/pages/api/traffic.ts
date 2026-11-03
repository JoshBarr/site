import type { NextApiRequest, NextApiResponse } from "next";
import { loadTraffic } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import type { TrafficResponse } from "../../lib/traffic";

/**
 * Live speeds on SH1 and SH2 around Wellington for the homepage scene, from
 * NZTA, as the AWS poller logged them (see lib/live.ts): it asks every
 * minute. Now, or with `?at=<epoch ms>` then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TrafficResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const traffic = await loadTraffic(at);

    if (!traffic) throw new Error("nothing fetched yet");
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=30, stale-while-revalidate=60", at)
    );
    res.status(200).json({ time: at ?? Date.now(), ...traffic });
  } catch (e) {
    console.error("[traffic] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "traffic unavailable" });
  }
}
