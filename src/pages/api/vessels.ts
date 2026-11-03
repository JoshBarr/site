import type { NextApiRequest, NextApiResponse } from "next";
import { loadVessels } from "../../lib/live";
import { isStale, type VesselsResponse } from "../../lib/vessels";

/**
 * Ships in Wellington Harbour for the homepage scene, from Open Waters AIS,
 * as the AWS poller logged them (see lib/live.ts).
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<VesselsResponse | { error: string }>
) {
  try {
    const vessels = await loadVessels();
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=10, stale-while-revalidate=20"
    );
    res.status(200).json({
      time: Date.now(),
      vessels: vessels.filter((vessel) => !isStale(vessel)),
    });
  } catch (e) {
    console.error("[vessels] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "vessels unavailable" });
  }
}
