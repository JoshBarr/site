import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    unstubEnvs: true,
    // What the API routes read, set to what the tests serve. Each test can
    // stub them otherwise.
    env: {
      // Served by test/fixtures/positions.ts.
      LIVE_POSITIONS_URL: "https://live.test/live/positions.json",
    },
  },
});
