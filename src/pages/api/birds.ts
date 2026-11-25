import type { NextApiRequest, NextApiResponse } from "next";
import type { FlockSummary } from "../../lib/flocks";
import { loadFlocks } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";

export interface BirdsResponse extends FlockSummary {
  /** When they were summed up, epoch ms; null if they hadn't been then. */
  summarised: number | null;
}

/**
 * Where Wellington's flocks gather, for the homepage scene to fly its birds
 * from: birders' eBird checklists over the month, summed up into sites by
 * kind of bird (lib/flocks.ts) each time the AWS timetables function fetches
 * them, every three hours. Not where the birds are now: the scene flies
 * them. With `?at=<epoch ms>` (lib/replay.ts), as last summed up before
 * then: none, before the first.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<BirdsResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const stored = await loadFlocks(at);

    if (!stored && at === undefined) throw new Error("nothing summed up yet");
    // Summed up every three hours.
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=3600, stale-while-revalidate=86400", at)
    );
    res
      .status(200)
      .json(stored ?? { summarised: null, sites: [], species: {} });
  } catch (e) {
    console.error("[birds] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "birds unavailable" });
  }
}
