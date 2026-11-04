import { z } from "zod";
import type { Aircraft } from "./flights";
import {
  aircraftDetails,
  busFix,
  conditions,
  fix,
  quake,
  routeEnd,
  seaLevel,
  speeds,
  trainFix,
  vessel,
} from "./liveRecords";
import { readJson, trailPoint } from "./schemas";

// What the AWS poller publishes once a minute, to a private S3 object
// served through CloudFront (see plans/dynamo.md): every live layer folded
// from its log as its API serves it. The site's API routes serve from it
// when they can't read the table.

const route = z.object({ from: routeEnd, to: routeEnd });

export const positions = z.object({
  /** Its format: bumped when an older reader couldn't read it. */
  v: z.literal(1),
  /** When it was written, epoch ms. */
  time: z.number(),
  trains: z.array(trainFix.extend({ trail: z.array(trailPoint) })),
  buses: z.array(busFix.extend({ trail: z.array(trailPoint) })),
  /** Each with its fixes from the last HISTORY. */
  aircraft: z.array(
    aircraftDetails.extend({
      route: route.nullable().optional(),
      fixes: z.array(fix),
    }) satisfies z.ZodType<Aircraft>
  ),
  vessels: z.array(vessel),
  /** Null until NZTA's been heard from. */
  traffic: speeds.extend({ fetched: z.number() }).nullable(),
  /** Null until MetService has. */
  weather: conditions.nullable(),
  /** Missing from those published before quakes were polled. */
  quakes: z.array(quake).default([]),
  /** Null until the tide gauge has been heard from. */
  tide: seaLevel.nullable().default(null),
});

export type Positions = z.infer<typeof positions>;

/**
 * The positions last published. Throws if they can't be fetched, or aren't
 * as expected.
 */
export async function loadPositions(): Promise<Positions> {
  // Its CloudFront URL.
  const from = process.env.LIVE_POSITIONS_URL;

  if (!from) throw new Error("LIVE_POSITIONS_URL isn't set");

  const response = await fetch(from, {
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) throw new Error(`positions: HTTP ${response.status}`);

  return readJson(response, positions, "positions");
}
