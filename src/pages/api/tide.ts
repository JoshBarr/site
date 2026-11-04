import type { NextApiRequest, NextApiResponse } from "next";
import { loadTide } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import type { Tide } from "../../lib/tide";

/**
 * The harbour's height above mean sea level for the homepage scene, from
 * GeoNet's Queens Wharf gauge, as the AWS poller logged it (see
 * lib/live.ts): it asks every five minutes. Now, or with `?at=<epoch ms>`
 * then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Tide | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const tide = await loadTide(at);

    if (!tide) throw new Error("nothing measured yet");
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=60, stale-while-revalidate=300", at)
    );
    res.status(200).json(tide);
  } catch (e) {
    console.error("[tide] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "tide unavailable" });
  }
}
