import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    unstubEnvs: true,
    // What the API routes read, set to what the tests serve. Each test can
    // stub them otherwise (to run without Redis, say).
    env: {
      // Served by test/redis.ts.
      UPSTASH_REDIS_REST_URL: "https://redis.test",
      UPSTASH_REDIS_REST_TOKEN: "test",
      KV_REST_API_URL: "",
      METLINK_API_KEY: "metlink-key",
      METSERVICE_API_KEY: "metservice-key",
      OPENWATERS_TOKEN: "",
      QSTASH_CURRENT_SIGNING_KEY: "current-signing-key",
      QSTASH_NEXT_SIGNING_KEY: "next-signing-key",
    },
  },
});
