import type { NextApiRequest, NextApiResponse } from "next";
import { loadQuakes, QUAKES_REPORTED } from "../../lib/live";
import type { Quake } from "../../lib/quakes";
import { cacheFor, replayTime } from "../../lib/replay";

export interface QuakesResponse {
  /** The moment they're as of, epoch ms: now, or the replay's. */
  time: number;
  quakes: Quake[];
}

/**
 * Earthquakes on the map or felt in Wellington for the homepage scene, the
 * newest hundred or so of New Zealand's, from GeoNet, as the AWS poller
 * logged them (see lib/live.ts): it asks every minute. Now, or with
 * `?at=<epoch ms>` then (lib/replay.ts), with those about to strike.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<QuakesResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const quakes = await loadQuakes(at);

    res.setHeader(
      "Cache-Control",
      // Settled once every poll it was read from is in.
      cacheFor(
        "public, s-maxage=30, stale-while-revalidate=60",
        at === undefined ? undefined : at + QUAKES_REPORTED
      )
    );
    res.status(200).json({ time: at ?? Date.now(), quakes });
  } catch (e) {
    console.error("[quakes] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "quakes unavailable" });
  }
}
