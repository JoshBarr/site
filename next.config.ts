import type { NextConfig } from "next";

/**
 * The scene's tiles, thousands of them, rarely change: cached for an hour
 * without asking, then served while they're checked for another day, so
 * coming back to the scene doesn't revalidate each one. A rebuilt tile can
 * take that long to reach a returning visitor, short of a hard reload. Their
 * manifests and the one-off files still revalidate every time.
 */
const TILE_CACHE = "public, max-age=3600, stale-while-revalidate=86400";

const config: NextConfig = {
  async headers() {
    return [
      {
        source: "/:layer(terrain|trees|buildings)/:z/:x/:tile",
        headers: [{ key: "Cache-Control", value: TILE_CACHE }],
      },
    ];
  },
};

export default config;
