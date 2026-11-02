// Generates a tiling ground-detail texture off the main thread.
// Request: { size }
// Response: { data: Uint8Array (size² RGBA) }
//
// r    canopy: rounded crowns of shrubs and trees, 0 between them
// g/b  slope of r per texel along u and v, as 0.5 + slope * SLOPE_SCALE
// a    mottling: blotchy variation for albedo

import { clamp01, normalise, perlin, worley } from "../noise";

/** Must match DETAIL_SLOPE_SCALE in the terrain material. */
const SLOPE_SCALE = 4;

/** Crowns per side of the tile. */
const CROWNS = 16;

function generate(size: number) {
  const canopy = new Float32Array(size * size);
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      const crowns =
        worley(u * CROWNS, v * CROWNS, 0.5, CROWNS, 1) * 0.7 +
        worley(u * CROWNS * 2, v * CROWNS * 2, 0.5, CROWNS * 2, 2) * 0.3;

      canopy[y * size + x] = crowns;

      let mottle = 0;
      let amplitude = 0.5;

      for (let o = 0, f = 4; o < 5; o++, f *= 2, amplitude *= 0.5) {
        mottle += amplitude * perlin(u * f, v * f, 0.5, f, 20 + o);
      }

      data[(y * size + x) * 4 + 3] = clamp01(mottle + 0.5) * 255;
    }
  }

  const at = (x: number, y: number) =>
    canopy[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const du = (at(x + 1, y) - at(x - 1, y)) / 2;
      const dv = (at(x, y + 1) - at(x, y - 1)) / 2;
      data[i] = canopy[y * size + x] * 255;
      data[i + 1] = clamp01(0.5 + du * SLOPE_SCALE) * 255;
      data[i + 2] = clamp01(0.5 + dv * SLOPE_SCALE) * 255;
    }
  }

  return normalise(data, [3]);
}

self.onmessage = (event: MessageEvent<{ size: number }>) => {
  const data = generate(event.data.size);
  self.postMessage({ data }, { transfer: [data.buffer] });
};
