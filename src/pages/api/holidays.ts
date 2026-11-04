import type { NextApiRequest, NextApiResponse } from "next";
import { fetchHolidays, YEARS } from "../../lib/holidays";
import type { HolidaysResponse } from "../../lib/holidays";

/**
 * Wellington's public holidays in `?year=`, for how busy the scene's roads
 * are: from Nager.Date (lib/holidays.ts), cached a day, since they're set
 * well ahead.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<HolidaysResponse | { error: string }>
) {
  const year = Number(req.query.year);

  if (!Number.isInteger(year) || year < YEARS[0] || year > YEARS[1]) {
    res.setHeader("Cache-Control", "public, s-maxage=86400");
    res.status(400).json({ error: "no such year" });

    return;
  }

  try {
    const dates = await fetchHolidays(year);

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=86400, stale-while-revalidate=604800"
    );
    res.status(200).json({ year, dates });
  } catch (e) {
    console.error("[holidays] fetch failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=300");
    res.status(502).json({ error: "holidays unavailable" });
  }
}
