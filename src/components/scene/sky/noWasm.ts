// Stands in for satellite.js's WASM builds (next.config.ts aliases them
// here). Its main entry re-exports a bulk propagator that lazily imports
// Emscripten loaders, and the multi-thread one spawns a Worker of its own
// file, which Turbopack follows as a new worker entry forever: the build
// hung until Vercel killed it. The scene only uses the plain JS SGP4.
export default function createWasmModule(): never {
  throw new Error("satellite.js WASM isn't bundled; use the JS propagator");
}
