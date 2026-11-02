// Generates tiling noise for the clouds off the main thread.
// Request: { size, weatherSize }
// Response: { shape: Uint8Array (size³ RGBA), weather: Uint8Array (weatherSize² RGBA) }
//
// shape.r  Perlin-Worley: billowy cloud bodies
// shape.g/b/a  Worley at rising frequencies: erosion detail
// weather.r/g  Perlin FBM at two scales: where clouds are, and variety

import { clamp01, normalise, perlin, remap, worley } from "../noise";

function generateShape(size: number) {
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const w = z / size;

        let p = 0;
        let amplitude = 0.5;
        for (let o = 0, f = 4; o < 3; o++, f *= 2, amplitude *= 0.5) {
          p += amplitude * perlin(u * f, v * f, w * f, f, 11 + o);
        }
        p = clamp01(p * 0.9 + 0.5);

        const worleyFbm = (base: number, seed: number) =>
          worley(u * base, v * base, w * base, base, seed) * 0.625 +
          worley(u * base * 2, v * base * 2, w * base * 2, base * 2, seed + 1) *
            0.25 +
          worley(u * base * 4, v * base * 4, w * base * 4, base * 4, seed + 2) *
            0.125;

        const billows = worleyFbm(4, 100);
        const perlinWorley = clamp01(remap(p, 0, 1, billows - 1, 1));

        const i = ((z * size + y) * size + x) * 4;
        data[i] = perlinWorley * 255;
        data[i + 1] = worleyFbm(4, 200) * 255;
        data[i + 2] = worleyFbm(8, 300) * 255;
        data[i + 3] = worleyFbm(16, 400) * 255;
      }
    }
  }
  return data;
}

function generateWeather(size: number) {
  const data = new Uint8Array(size * size * 4);
  const fbm = (
    u: number,
    v: number,
    base: number,
    octaves: number,
    seed: number
  ) => {
    let total = 0;
    let amplitude = 0.5;
    for (let o = 0, f = base; o < octaves; o++, f *= 2, amplitude *= 0.5) {
      total += amplitude * perlin(u * f, v * f, 0.5, f, seed + o);
    }
    return clamp01(total * 1.1 + 0.5);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const i = (y * size + x) * 4;
      data[i] = fbm(u, v, 4, 5, 500) * 255;
      data[i + 1] = fbm(u, v, 2, 4, 600) * 255;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return data;
}

self.onmessage = (
  event: MessageEvent<{ size: number; weatherSize: number }>
) => {
  const { size, weatherSize } = event.data;
  const shape = normalise(generateShape(size), [0, 1, 2, 3]);
  const weather = normalise(generateWeather(weatherSize), [0, 1]);
  self.postMessage(
    { shape, weather },
    { transfer: [shape.buffer, weather.buffer] }
  );
};
