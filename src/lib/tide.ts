import { z } from "zod";
import { readJson } from "./schemas";

// The sea's height in Wellington Harbour from GeoNet's tsunami gauge at
// Queens Wharf (WLGT), through Tilde (https://tilde.geonet.org.nz), CC BY
// 4.0, no key needed: every 15 s, a few minutes behind. It has two sensors
// whose zeros differ by 10 cm or so; this reads one. Its zero is the
// gauge's own, so heights are taken from its mean over the last 30 days:
// mean sea level near enough, which the terrain's zero is too. What's left
// is the tide, and the weather's surge on top of it.

const SERIES =
  "https://tilde.geonet.org.nz/v4/data/coastal/WLGT/water-height/40/15s/nil";

const TIMEOUT = 15_000;

export interface Tide {
  /** When the newest minute measured was, epoch ms. */
  time: number;
  /** Metres above mean sea level. */
  level: number;
  /** Metres an hour, rising positive: to carry it on between polls. */
  rate: number;
}

const series = z.array(
  z.object({
    data: z.array(
      z.object({ val: z.number().nullable(), ts: z.iso.datetime() })
    ),
  })
);

/** One point per `period` over the `latest` (Tilde's names), each its mean. */
async function means(latest: string, period: string) {
  const response = await fetch(
    `${SERIES}/latest/${latest}?aggregationPeriod=${period}&aggregationFunction=mean`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    }
  );

  if (!response.ok) throw new Error(`tilde: HTTP ${response.status}`);

  const [found] = await readJson(response, series, "tilde");

  return (found?.data ?? []).flatMap(({ val, ts }) =>
    val === null ? [] : [{ time: Date.parse(ts), value: val }]
  );
}

/** The gauge's mean over the last 30 days, metres above its zero. */
export async function fetchMeanLevel(): Promise<number> {
  const days = await means("30d", "1d");

  if (!days.length) throw new Error("tilde: no days measured");

  return days.reduce((sum, { value }) => sum + value, 0) / days.length;
}

/** How many of the newest minutes the rate's fitted over. */
const RATE_OVER = 10;

/**
 * The newest minute's height above `mean` (fetchMeanLevel), and how fast
 * it's changing; null if nothing's been measured in the last half hour.
 */
export async function fetchTide(mean: number): Promise<Tide | null> {
  const minutes = await means("30m", "1m");
  const newest = minutes.at(-1);

  if (!newest) return null;

  // A least-squares slope: the waves' and the wind's chop averages out.
  const fit = minutes.slice(-RATE_OVER);
  const t = fit.map(({ time }) => (time - newest.time) / 3_600_000);
  const tMean = t.reduce((a, b) => a + b, 0) / fit.length;
  const vMean = fit.reduce((a, { value }) => a + value, 0) / fit.length;

  const spread = t.reduce((sum, ti) => sum + (ti - tMean) ** 2, 0);

  const rate = spread
    ? fit.reduce(
        (sum, { value }, i) => sum + (t[i] - tMean) * (value - vMean),
        0
      ) / spread
    : 0;

  return {
    time: newest.time,
    // To the millimetre.
    level: Math.round((newest.value - mean) * 1000) / 1000,
    rate: Math.round(rate * 1000) / 1000,
  };
}
