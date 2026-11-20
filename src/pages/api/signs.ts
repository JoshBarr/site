import type { NextApiRequest, NextApiResponse } from "next";
import { loadSigns } from "../../lib/live";
import { cacheFor, replayTime } from "../../lib/replay";
import type { SignsResponse } from "../../lib/signs";

/**
 * What the message signs on SH1 and SH2 around Wellington are showing, for
 * the homepage scene, from NZTA, as the AWS poller logged it (see
 * lib/live.ts): it asks every two minutes. Now, or with `?at=<epoch ms>`
 * then (lib/replay.ts).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SignsResponse | { error: string }>
) {
  const at = replayTime(req.query.at);

  if (at === null) {
    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.status(400).json({ error: "can't replay that time" });

    return;
  }

  try {
    const signs = await loadSigns(at);

    if (!signs) throw new Error("nothing fetched yet");
    res.setHeader(
      "Cache-Control",
      cacheFor("public, s-maxage=60, stale-while-revalidate=120", at)
    );
    res.status(200).json({ time: at ?? Date.now(), ...signs });
  } catch (e) {
    console.error("[signs] load failed:", e);
    res.setHeader("Cache-Control", "public, s-maxage=30");
    res.status(502).json({ error: "signs unavailable" });
  }
}
