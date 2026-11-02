import { z } from "zod";

// Checking what comes back over the network, from the APIs the scene's live
// layers draw on and from what they've stored in Redis, before it's trusted.

/** NZTM2000 easting and northing. */
export const point = z.tuple([z.number(), z.number()]);

/** A trail point: easting, northing and time (epoch ms). */
export const trailPoint = z.tuple([z.number(), z.number(), z.number()]);

/**
 * A response's JSON body, as `schema` reads it. Throws, naming `source`, if
 * it isn't what was expected.
 */
export async function readJson<T>(
  response: Response,
  schema: z.ZodType<T>,
  source: string
): Promise<T> {
  const result = schema.safeParse(await response.json());

  if (!result.success) {
    throw new Error(
      `${source}: unexpected response: ${z.prettifyError(result.error)}`
    );
  }

  return result.data;
}
