import type { NextApiRequest, NextApiResponse } from "next";
import { waitUntil } from "@vercel/functions";
import {
  canStore,
  fetchAirspace,
  findRoutes,
  loadSightings,
  saveSightings,
  Sighting,
  toAircraft,
} from "../../lib/flightStore";
import { FlightsResponse, HISTORY, RECENT } from "../../lib/flights";

/**
 * Aircraft around Wellington for the homepage scene, with where they've been:
 * the last few minutes, or with `?history` the last half hour. Each request
 * the edge cache lets through asks adsb.lol and stores what it says, so the
 * trails are detailed while people are watching; between visits, a sweep
 * every couple of minutes keeps them going (see ./flights/sweep.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<FlightsResponse | { error: string }>
) {
  const since = "history" in req.query ? HISTORY : RECENT;

  const [live, past] = await Promise.allSettled([
    fetchAirspace(),
    canStore() ? loadSightings(since) : Promise.resolve<Sighting[]>([]),
  ]);

  if (live.status === "rejected") {
    console.error("[flights] fetch failed:", live.reason);
  }

  if (past.status === "rejected") {
    console.error("[flights] load failed:", past.reason);
  }

  if (live.status === "rejected" && past.status === "rejected") {
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "flights unavailable" });

    return;
  }

  const fresh = live.status === "fulfilled" ? live.value : [];

  if (canStore() && fresh.length) {
    waitUntil(
      saveSightings(fresh).catch((e) =>
        console.error("[flights] save failed:", e)
      )
    );
  }

  const sightings = [
    ...(past.status === "fulfilled" ? past.value : []),
    ...fresh,
  ];

  // Without routes, trails just end where the aircraft were first and last
  // seen: no reason to fail.
  const routes = await findRoutes(sightings).catch((e) => {
    console.error("[flights] routes failed:", e);

    return undefined;
  });

  res.setHeader(
    "Cache-Control",
    // Each miss costs Redis commands; planes are drawn 30s behind to allow it.
    "public, s-maxage=15, stale-while-revalidate=20"
  );
  res.status(200).json({
    time: Date.now(),
    aircraft: toAircraft(sightings, routes),
  });
}
