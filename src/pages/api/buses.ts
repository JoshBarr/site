import type { NextApiRequest, NextApiResponse } from "next";
import { loadBuses } from "../../lib/busStore";
import type { BusesResponse } from "../../lib/buses";

/**
 * Buses around Wellington for the homepage scene, from Metlink:
 * refreshed every 10 seconds or so by whichever request is due, and
 * otherwise as last fetched.
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<BusesResponse | { error: string }>
) {
  try {
    const buses = await loadBuses();
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=5, stale-while-revalidate=10"
    );
    res.status(200).json({ time: Date.now(), buses });
  } catch (e) {
    console.error("[buses] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "buses unavailable" });
  }
}
