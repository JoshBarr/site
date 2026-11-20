import type { NextApiRequest, NextApiResponse } from "next";
import { loadWaves } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import type { Waves } from "../../lib/waves";

/**
 * The sea off Baring Head by GWRC's wave buoy, for the homepage scene, as
 * the AWS poller logged it (see lib/live.ts): it asks every ten minutes,
 * and the buoy reports every half hour. Now, or with `?at=<epoch ms>` then
 * (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Waves | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const waves = await loadWaves(at);

    if (!waves) throw new Error("nothing measured yet");
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=300, stale-while-revalidate=600", at)
    );
    res.status(200).json(waves);
  } catch (e) {
    console.error("[waves] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "waves unavailable" });
  }
}
