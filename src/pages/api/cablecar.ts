import type { NextApiRequest, NextApiResponse } from "next";
import type { Timetable } from "../../lib/cablecar";
import { loadTimetable } from "../../lib/live";

/**
 * The cable car's timetable for the homepage scene, from Metlink's GTFS
 * feed, as the AWS timetables function keeps it (see lib/live.ts). Its cars
 * have no live positions, so the scene runs them to this, at whatever time
 * it's showing.
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<Omit<Timetable, "etag"> | { error: string }>
) {
  try {
    const timetable = await loadTimetable();

    if (!timetable) throw new Error("nothing fetched yet");
    // Checked for daily, and new every few weeks.
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400"
    );
    res.status(200).json(timetable);
  } catch (e) {
    console.error("[cablecar] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "timetable unavailable" });
  }
}
