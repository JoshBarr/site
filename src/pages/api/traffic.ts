import type { NextApiRequest, NextApiResponse } from "next";
import { loadTraffic } from "../../lib/live";
import type { TrafficResponse } from "../../lib/traffic";

/**
 * Live speeds on SH1 and SH2 around Wellington for the homepage scene, from
 * NZTA, as the AWS poller logged them (see lib/live.ts): it asks every
 * minute.
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<TrafficResponse | { error: string }>
) {
  try {
    const traffic = await loadTraffic();

    if (!traffic) throw new Error("nothing fetched yet");
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=60"
    );
    res.status(200).json({ time: Date.now(), ...traffic });
  } catch (e) {
    console.error("[traffic] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "traffic unavailable" });
  }
}
