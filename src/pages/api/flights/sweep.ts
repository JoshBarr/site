import type { NextApiRequest, NextApiResponse } from "next";
import {
  canStore,
  fetchAirspace,
  saveSightings,
} from "../../../lib/flightStore";
import { canVerify, verifyQStash } from "../../../lib/qstash";

export const config = {
  // QStash signs the raw body.
  api: { bodyParser: false },
};

/**
 * Stores what's in the air every couple of minutes, called by a QStash
 * schedule (see scripts/flights/schedule.mjs), so every visitor sees trails,
 * not just those who arrive while someone else is watching.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ stored: number } | { error: string }>
) {
  if (!canStore || !canVerify) {
    res.status(503).json({ error: "sweep not configured" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!(await verifyQStash(req))) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  try {
    const sightings = await fetchAirspace();
    // Trimmed here only, so visitor requests don't pay for it.
    await saveSightings(sightings, { trim: true });
    res.status(200).json({ stored: sightings.length });
  } catch (e) {
    console.error("[flights] sweep failed:", e);
    // Not worth a retry: the next sweep is a couple of minutes away.
    res.status(200).json({ error: "sweep failed" });
  }
}
