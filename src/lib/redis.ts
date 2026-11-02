import { Redis } from "@upstash/redis";
import { z } from "zod";

// Upstash Redis, for what the scene's live layers remember between requests.

/** Whether there's a Redis to use. */
export const canStore = () =>
  !!(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL);

let redis: Redis | undefined;

export const getRedis = () => (redis ??= Redis.fromEnv());

/**
 * What's stored at `key`, as `schema` reads it: null if there's nothing, or
 * it isn't what's expected (stored by an older deploy, say).
 */
export async function getStored<T>(
  key: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  const result = schema.nullable().safeParse(await getRedis().get(key));

  if (!result.success) {
    console.error(`[redis] ${key}:`, z.prettifyError(result.error));

    return null;
  }

  return result.data;
}
