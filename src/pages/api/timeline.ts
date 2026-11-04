import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { loadTimelineDay } from "../../lib/live";
import { REPLAY } from "../../lib/replay";
import {
  DATE,
  HOUR,
  nextDay,
  nzDate,
  nzMidnight,
  type TimelineDay,
} from "../../lib/timeline";

/**
 * Once a day's last hour is in, and the hour after's for its quakes, it
 * won't change: cached an hour at a time, so a backfill shows soon enough.
 */
const SETTLED = HOUR + 5 * 60_000;

/**
 * A day of the scene's time-travel timeline, `?day=YYYY-MM-DD` (NZ): what
 * was out in each five minutes, the roads, tide and weather, and quakes
 * (lib/timeline.ts). Any of the days that can be replayed.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<TimelineDay | { error: string }>
) {
  const asked = z.string().regex(DATE).safeParse(req.query.day);
  const now = Date.now();

  if (
    !asked.success ||
    asked.data > nzDate(now) ||
    nzMidnight(nextDay(asked.data)) < now - REPLAY
  ) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "no timeline for that day" });

    return;
  }

  const day = asked.data;

  try {
    const timeline = await loadTimelineDay(day);
    const counted = Object.keys(timeline.series).length > 0;

    res.setHeader(
      "Cache-Control",
      counted && timeline.end + SETTLED < now
        ? "public, s-maxage=3600, stale-while-revalidate=86400"
        : "public, s-maxage=60, stale-while-revalidate=300"
    );
    res.status(200).json(timeline);
  } catch (e) {
    console.error("[timeline] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "timeline unavailable" });
  }
}
