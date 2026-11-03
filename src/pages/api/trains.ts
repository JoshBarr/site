import type { NextApiRequest, NextApiResponse } from "next";
import { loadTrains } from "../../lib/live";
import { isStale, type TrainsResponse } from "../../lib/trains";

/**
 * Trains on the Wellington network for the homepage scene, from Metlink, as
 * the AWS poller logged them (see lib/live.ts).
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<TrainsResponse | { error: string }>
) {
  try {
    const trains = await loadTrains();
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=5, stale-while-revalidate=10"
    );
    res.status(200).json({
      time: Date.now(),
      trains: trains.filter((train) => !isStale(train)),
    });
  } catch (e) {
    console.error("[trains] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "trains unavailable" });
  }
}
