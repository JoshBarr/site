// Tiling noise shared by the generators in the cloud and terrain workers.

/** 0..1 from integer coordinates. Mixes fully, so nearby seeds are unrelated. */
function hash(x: number, y: number, z: number, seed: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h ^= Math.imul(z, 2147483647) ^ Math.imul(seed, 144665);
  // murmur3's finaliser
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Gradient noise with period `p` in every axis, roughly -1..1. */
export function perlin(x: number, y: number, z: number, p: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const corner = (dx: number, dy: number, dz: number) => {
    const cx = mod(xi + dx, p);
    const cy = mod(yi + dy, p);
    const cz = mod(zi + dz, p);
    // Random unit-ish gradient from three hashes.
    const gx = hash(cx, cy, cz, seed) * 2 - 1;
    const gy = hash(cx, cy, cz, seed + 1) * 2 - 1;
    const gz = hash(cx, cy, cz, seed + 2) * 2 - 1;
    return gx * (xf - dx) + gy * (yf - dy) + gz * (zf - dz);
  };
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);
  return lerp(
    lerp(
      lerp(corner(0, 0, 0), corner(1, 0, 0), u),
      lerp(corner(0, 1, 0), corner(1, 1, 0), u),
      v
    ),
    lerp(
      lerp(corner(0, 0, 1), corner(1, 0, 1), u),
      lerp(corner(0, 1, 1), corner(1, 1, 1), u),
      v
    ),
    w
  );
}

/** Inverted cellular noise with `cells` cells per period: 1 at feature points. */
export function worley(x: number, y: number, z: number, cells: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  let nearest = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const cy = yi + dy;
        const cz = zi + dz;
        const hx = mod(cx, cells);
        const hy = mod(cy, cells);
        const hz = mod(cz, cells);
        const px = cx + hash(hx, hy, hz, seed) - x;
        const py = cy + hash(hx, hy, hz, seed + 7) - y;
        const pz = cz + hash(hx, hy, hz, seed + 13) - z;
        nearest = Math.min(nearest, px * px + py * py + pz * pz);
      }
    }
  }
  return 1 - Math.min(Math.sqrt(nearest), 1);
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const remap = (v: number, a: number, b: number, c: number, d: number) =>
  c + ((v - a) / (b - a)) * (d - c);

/**
 * Stretch each channel to the full 0..255 range. FBM clusters around the
 * middle, which would make coverage thresholds barely bite.
 */
export function normalise(data: Uint8Array, channels: number[]) {
  for (const c of channels) {
    let lo = 255;
    let hi = 0;
    for (let i = c; i < data.length; i += 4) {
      lo = Math.min(lo, data[i]);
      hi = Math.max(hi, data[i]);
    }
    const scale = 255 / Math.max(hi - lo, 1);
    for (let i = c; i < data.length; i += 4) {
      data[i] = (data[i] - lo) * scale;
    }
  }
  return data;
}
