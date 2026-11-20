import type { NextApiRequest, NextApiResponse } from "next";
import { loadRadar } from "../../lib/live";
import type { Radar } from "../../lib/radarGrid";
import { cacheFor, replayTime } from "../../lib/replay";

/**
 * Where the rain radar's seen rain over the map and around it in the last
 * half hour, for the homepage scene, as the AWS poller logged it (see
 * lib/live.ts): a new frame every ten minutes. Now, or with `?at=<epoch ms>`
 * then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Radar | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const radar = await loadRadar(at);

    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=60, stale-while-revalidate=300", at)
    );
    res.status(200).json(radar);
  } catch (e) {
    console.error("[radar] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "radar unavailable" });
  }
}
