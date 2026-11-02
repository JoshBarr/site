import { Redis } from "@upstash/redis";

// Upstash Redis, for what the scene's live layers remember between requests.

/** Whether there's a Redis to use. */
export const canStore = !!(
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
);

let redis: Redis | undefined;
export const getRedis = () => (redis ??= Redis.fromEnv());
