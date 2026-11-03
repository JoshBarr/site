import type { NextApiRequest, NextApiResponse } from "next";
import { FlightsResponse, HISTORY, RECENT } from "../../lib/flights";
import { loadAircraft } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";

/**
 * Aircraft around Wellington for the homepage scene, from adsb.lol, as the
 * AWS poller logged them (see lib/live.ts), with where they've been: the last two
 * minutes, or with `?history` the last seven. Now, or with `?at=<epoch ms>`
 * then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<FlightsResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const time = at ?? Date.now();
    const window = "history" in req.query ? HISTORY : RECENT;
    const aircraft = await loadAircraft(window, at);

    res.setHeader(
      "Cache-Control",
      // Planes are drawn 30 s behind live; a fix can wait up to 10 s to be
      // polled, then 10 s here and up to 10 s more served stale.
      cacheFor("public, s-maxage=10, stale-while-revalidate=10", at)
    );
    res.status(200).json({
      time,
      aircraft,
    });
  } catch (e) {
    console.error("[flights] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "flights unavailable" });
  }
}
