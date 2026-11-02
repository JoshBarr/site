import { DataTexture } from "three/webgpu";
import { clamp, texture, vec2 } from "three/tsl";

/** The 2D coverage map spans this many metres before repeating. */
export const WEATHER_SCALE = 24000;

/**
 * Each layer samples the noise rotated, so the tiles don't line up into rows,
 * within a layer or between them. Radians.
 */
export const LOW_ANGLE = 0.41;
export const MID_ANGLE = -0.83;

/**
 * Where a layer's clouds are, at xz with the layer's drift `offset`: two
 * scales of coverage map, the finer one turned again, so the pattern doesn't
 * repeat for tens of kilometres. Also returns the samples and the rotated
 * position, which the cloud bodies reuse for their warp.
 */
export function coverageMap(weather: DataTexture, xz, offset, angle: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const moved = xz.add(offset);
  const rotated = vec2(
    moved.x.mul(c).sub(moved.y.mul(s)),
    moved.x.mul(s).add(moved.y.mul(c))
  );

  const broad = texture(weather, rotated.div(WEATHER_SCALE));
  const fine = texture(
    weather,
    vec2(rotated.y, rotated.x.negate()).div(WEATHER_SCALE * 0.37)
  );
  // Blending two maps squeezes their range toward the middle; stretch it
  // back so the area over the threshold tracks the coverage value.
  const map = clamp(
    broad.r.mul(0.7).add(fine.r.mul(0.3)).sub(0.5).mul(1.9).add(0.5),
    0,
    1
  );
  return { rotated, broad, fine, map };
}

/** The weather texture's red and green at uv, as the GPU samples it: bilinear, repeating. */
function sampleWeather(weather: DataTexture, u: number, v: number) {
  const { data, width, height } = weather.image as {
    data: Uint8Array;
    width: number;
    height: number;
  };
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const texel = (i: number, j: number, channel: number) => {
    const column = ((i % width) + width) % width;
    const row = ((j % height) + height) % height;
    return data[(row * width + column) * 4 + channel] / 255;
  };
  const channel = (c: number) => {
    const top = texel(x0, y0, c) * (1 - fx) + texel(x0 + 1, y0, c) * fx;
    const bottom =
      texel(x0, y0 + 1, c) * (1 - fx) + texel(x0 + 1, y0 + 1, c) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  return { r: channel(0), g: channel(1) };
}

/** coverageMap, worked out on the CPU at one point. */
export function coverageMapAt(
  weather: DataTexture,
  x: number,
  z: number,
  offset: { x: number; y: number },
  angle: number
) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const mx = x + offset.x;
  const mz = z + offset.y;
  const rx = mx * c - mz * s;
  const rz = mx * s + mz * c;
  const broad = sampleWeather(weather, rx / WEATHER_SCALE, rz / WEATHER_SCALE);
  const fine = sampleWeather(
    weather,
    rz / (WEATHER_SCALE * 0.37),
    -rx / (WEATHER_SCALE * 0.37)
  );
  const blended = (broad.r * 0.7 + fine.r * 0.3 - 0.5) * 1.9 + 0.5;
  return { broad, map: Math.min(Math.max(blended, 0), 1) };
}
