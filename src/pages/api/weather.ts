import type { NextApiRequest, NextApiResponse } from "next";
import { Conditions, getConditions } from "../../lib/weather";

/**
 * Current Wellington weather for the homepage scene. Cached at the edge so
 * MetService is asked at most every half hour, and the key stays server-side.
 */
export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<Conditions | { error: string }>
) {
  const conditions = await getConditions();

  if (!conditions) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(502).json({ error: "weather unavailable" });

    return;
  }

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=1800, stale-while-revalidate=3600"
  );
  res.status(200).json(conditions);
}
