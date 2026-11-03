import type { NextApiRequest, NextApiResponse } from "next";
import { type BusesResponse, isStale } from "../../lib/buses";
import { loadBuses } from "../../lib/live";

/**
 * Buses around Wellington for the homepage scene, from Metlink, as the AWS
 * poller logged them (see lib/live.ts).
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<BusesResponse | { error: string }>
) {
  try {
    const buses = await loadBuses();
    res.setHeader(
      "Cache-Control",
      // Buses are drawn 45 s behind live; a fix can wait up to 20 s to be
      // polled, then 10 s here and up to 10 s more served stale.
      "public, s-maxage=10, stale-while-revalidate=10"
    );
    res.status(200).json({
      time: Date.now(),
      buses: buses.filter((bus) => !isStale(bus)),
    });
  } catch (e) {
    console.error("[buses] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "buses unavailable" });
  }
}
