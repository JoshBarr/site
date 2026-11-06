import type { NextConfig } from "next";

/**
 * The scene's tiles, thousands of them, rarely change: cached for an hour
 * without asking, then served while they're checked for another day, so
 * coming back to the scene doesn't revalidate each one. A rebuilt tile can
 * take that long to reach a returning visitor, short of a hard reload. Their
 * manifests and the one-off files still revalidate every time.
 */
const TILE_CACHE = "public, max-age=3600, stale-while-revalidate=86400";

/** satellite.js's WASM builds, which hang Turbopack; see noWasm.ts. */
const NO_WASM = "./src/components/scene/sky/noWasm.ts";

const config: NextConfig = {
  turbopack: {
    resolveAlias: {
      "#wasm-single-thread": NO_WASM,
      "#wasm-multi-thread": NO_WASM,
    },
  },
  /** Old addresses, from before the blog and about pages were renamed. */
  async redirects() {
    return [
      { source: "/articles", destination: "/blog", permanent: true },
      {
        source: "/articles/:slug",
        destination: "/blog/:slug",
        permanent: true,
      },
      { source: "/work", destination: "/about", permanent: true },
    ];
  },
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
