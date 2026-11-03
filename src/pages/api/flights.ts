import type { NextApiRequest, NextApiResponse } from "next";
import { FlightsResponse, HISTORY, RECENT } from "../../lib/flights";
import { loadAircraft } from "../../lib/live";

/**
 * Aircraft around Wellington for the homepage scene, from adsb.lol, as the
 * AWS poller logged them (see lib/live.ts), with where they've been: the last two
 * minutes, or with `?history` the last seven.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<FlightsResponse | { error: string }>
) {
  try {
    const now = Date.now();
    const window = "history" in req.query ? HISTORY : RECENT;
    const aircraft = await loadAircraft(window, now);

    res.setHeader(
      "Cache-Control",
      // Planes are drawn 30 s behind live; a fix can wait up to 10 s to be
      // polled, then 10 s here and up to 10 s more served stale.
      "public, s-maxage=10, stale-while-revalidate=10"
    );
    res.status(200).json({
      time: now,
      aircraft,
    });
  } catch (e) {
    console.error("[flights] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "flights unavailable" });
  }
}
