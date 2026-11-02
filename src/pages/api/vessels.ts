import type { NextApiRequest, NextApiResponse } from "next";
import { loadVessels } from "../../lib/vesselStore";
import type { VesselsResponse } from "../../lib/vessels";

/**
 * Ships in Wellington Harbour for the homepage scene, from Open Waters AIS:
 * refreshed every 20 seconds or so by whichever request is due, and
 * otherwise as last fetched.
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
    res.status(200).json({ time: Date.now(), vessels });
  } catch (e) {
    console.error("[vessels] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "vessels unavailable" });
  }
}
