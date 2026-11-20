import type { NextApiRequest, NextApiResponse } from "next";
import type { GridFlow } from "../../lib/gridFlow";
import { loadGrid } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";

/**
 * What the national grid's carrying around Wellington for the homepage
 * scene (lib/gridFlow.ts): the HVDC link's transfer, the North Island's
 * load, and each substation's where there's a key for them, as the AWS
 * poller logged it (see lib/live.ts). It asks every five minutes. Now, or
 * with `?at=<epoch ms>` then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<GridFlow | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const grid = await loadGrid(at);

    if (!grid) throw new Error("nothing heard yet");
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=60, stale-while-revalidate=300", at)
    );
    res.status(200).json(grid);
  } catch (e) {
    console.error("[grid] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "grid unavailable" });
  }
}
