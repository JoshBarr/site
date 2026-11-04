import type { NextApiRequest, NextApiResponse } from "next";
import { loadSatellites } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import type { Orbit } from "../../lib/satellites";

export interface SatellitesResponse {
  /** When CelesTrak's elements were fetched, epoch ms. */
  fetched: number;
  orbits: Orbit[];
}

/**
 * The orbits of the satellites bright enough to see pass over, for the
 * homepage scene's night sky, from CelesTrak, as the AWS timetables
 * function fetches them each morning (see lib/live.ts). The scene runs them
 * on to whatever time it's showing; with `?at=<epoch ms>` (lib/replay.ts),
 * they're those fetched last before then.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SatellitesResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const satellites = await loadSatellites(at);

    if (!satellites) throw new Error("nothing fetched yet");
    // Fetched daily.
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=3600, stale-while-revalidate=86400", at)
    );
    res.status(200).json(satellites);
  } catch (e) {
    console.error("[satellites] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "satellites unavailable" });
  }
}
