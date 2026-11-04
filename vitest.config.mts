import { defineConfig } from "vitest/config";

/**
 * What the site and the poller read from the environment, and the AWS SDK
 * and Vercel's OIDC with them. A Vercel build has the real ones set, so
 * they're cleared before the test workers start: the tests run the same
 * there as here, against MSW, and each stubs what it needs.
 */
const DEPLOYED =
  /^(NEXT_PUBLIC_|LIVE_|AWS_|METLINK_|METSERVICE_|OPENWATERS_|UPSTASH_|KV_|VERCEL_OIDC)/;

for (const name of Object.keys(process.env)) {
  if (DEPLOYED.test(name)) delete process.env[name];
}

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
