import { defineConfig } from "vitest/config";

// The poller's tests, with the site's test setup: its network goes through
// MSW (../test/msw.ts), and its table is in memory (test/table.ts).

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["../test/setup.ts"],
    unstubEnvs: true,
    env: {
      // As in Lambda: no Redis.
      UPSTASH_REDIS_REST_URL: "",
      KV_REST_API_URL: "",
      METLINK_API_KEY: "metlink-key",
      METSERVICE_API_KEY: "metservice-key",
      OPENWATERS_TOKEN: "",
    },
  },
});
