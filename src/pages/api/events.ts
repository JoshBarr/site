import type { NextApiRequest, NextApiResponse } from "next";
import type { VenueEvent } from "../../lib/events";
import { loadEvents } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";

export interface EventsResponse {
  /** When they were fetched, epoch ms; null if they hadn't been then. */
  fetched: number | null;
  /** From a day before then to a week or so after, by start. */
  events: VenueEvent[];
}

/**
 * What's on at Wellington's big venues, for the homepage scene to light them
 * through it: shows from Eventfinda and the Wellington teams' home games
 * from TheSportsDB, as the AWS timetables function fetches them each
 * morning (see lib/events.ts). With `?at=<epoch ms>` (lib/replay.ts), as
 * they were fetched last before then: none, before the first.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<EventsResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const stored = await loadEvents(at);

    if (!stored && at === undefined) throw new Error("nothing fetched yet");
    // Fetched daily.
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=3600, stale-while-revalidate=86400", at)
    );
    res.status(200).json(stored ?? { fetched: null, events: [] });
  } catch (e) {
    console.error("[events] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "events unavailable" });
  }
}
