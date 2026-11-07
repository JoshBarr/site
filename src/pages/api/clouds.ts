import type { NextApiRequest, NextApiResponse } from "next";
import type { CloudMap } from "../../lib/cloudMap";
import { loadClouds } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";

/**
 * Where Himawari saw cloud over the map, for the homepage scene, as the AWS
 * poller logged it (see lib/live.ts): a new scan every ten minutes. Now, or
 * with `?at=<epoch ms>` then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CloudMap | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const map = await loadClouds(at);

    if (!map) throw new Error("nothing seen yet");
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=120, stale-while-revalidate=600", at)
    );
    res.status(200).json(map);
  } catch (e) {
    console.error("[clouds] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "clouds unavailable" });
  }
}
