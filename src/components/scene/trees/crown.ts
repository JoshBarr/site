import { LOBES, topOfLobe } from "./geometry";

// The top of a tree's crown, worked out as material.ts draws it close up:
// its top lobe, and where that lobe's uppermost faces are. For whatever
// sits on a tree (the birds). The shapes and random numbers here are the
// shader's: change one, change the other.

/** Lobe radius jitter per vertex, ±. */
export const LOBE_LUMPS = 0.14;

/** Lobes are this much flattened, as foliage clumps are. */
export const LOBE_FLAT = 0.82;

const f32 = Math.fround;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const clamp = (value: number, least: number, most: number) =>
  Math.min(Math.max(value, least), most);

const smoothstep = (from: number, to: number, value: number) => {
  const u = clamp((value - from) / (to - from), 0, 1);

  return u * u * (3 - 2 * u);
};

/** TSL's `hash`, as the GPU works it: PCG of the seed cut to a whole number. */
export function shaderHash(seed: number) {
  const state = (Math.imul(seed >>> 0, 747_796_405) + 2_891_336_453) >>> 0;

  const word =
    Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277_803_737) >>> 0;

  return f32(((word >>> 22) ^ word) >>> 0) * 2 ** -32;
}

export interface CrownTop {
  /** The top lobe's middle: across from the trunk (x, z) and up from the ground, m. */
  x: number;
  up: number;
  z: number;
  /** The lobe's radius, m. */
  size: number;
  /** The tree's own random number, that its others come from. */
  seed: number;
}

/**
 * The top lobe of the tree whose record has `xq` and `zq` (its place in its
 * tile, as stored: 0..65535), `height` m tall with a crown of `radius` m.
 */
export function crownTop(
  xq: number,
  zq: number,
  height: number,
  radius: number
): CrownTop {
  const seed = shaderHash(f32(xq + f32(shaderHash(zq) * 1e6)));
  const random = (n: number) => shaderHash(f32(f32(seed * 1e6) + n));
  // The top lobe's: lobe 0.
  const own = (n: number) => shaderHash(f32(f32(seed * 1e5) + n));

  const slender = height / Math.max(radius * 2, 0.5);
  const conical = smoothstep(1.3, 2.6, slender * mix(0.8, 1.25, random(1)));

  const depth = clamp(
    radius * mix(1.6, 2.2, random(2)),
    height * 0.45,
    height * 0.9
  );

  const turn = random(3) * Math.PI * 2;

  // A dome's top lobe, by its middle; a cone's, the highest of its stack.
  const domeAngle = (-1 / (LOBES.near - 1) + own(1) * 0.12) * Math.PI * 2;
  const level = 1 - (0.6 / LOBES.near) * 0.92;
  const angle = mix(domeAngle, random(8) * 6.28, conical);

  const out = mix(
    mix(0.05, 0.2, own(2)),
    (1 - level) * mix(0.35, 0.5, own(2)),
    conical
  );

  const lift = mix(mix(0.6, 0.68, own(3)), level, conical);

  const size =
    mix(
      mix(0.55, 0.68, own(4)),
      (1 - level) * 0.5 + mix(0.16, 0.24, own(4)),
      conical
    ) * radius;

  const ax = Math.cos(angle) * out * radius;
  const az = Math.sin(angle) * out * radius;
  const c = Math.cos(turn);
  const s = Math.sin(turn);

  return {
    x: ax * c - az * s,
    up: height - depth + lift * depth,
    z: ax * s + az * c,
    size,
    seed,
  };
}

const { faces, points } = topOfLobe();

/**
 * A place on top of a lobe of `size` m and the tree's `seed`: on one of
 * the faces round its highest point, picked by `a` (0..1), `b` and `c`
 * across it (0..1 each). Into `out`: x, y, z from the lobe's middle, m.
 */
export function onLobe(
  size: number,
  seed: number,
  a: number,
  b: number,
  c: number,
  out: Float32Array | number[]
) {
  const face = faces[Math.min(Math.floor(a * faces.length), faces.length - 1)];
  // Mostly toward the top: the face's first corner.
  const second = b * 0.5;
  const third = c * (0.5 - second);
  const shares = [1 - second - third, second, third];
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;

  for (let k = 0; k < 3; k++) {
    const [x, y, z] = points[face[k]];

    const lump =
      1 + (shaderHash(f32(f32(seed * 1e4) + face[k])) - 0.5) * LOBE_LUMPS * 2;

    out[0] += x * size * lump * shares[k];
    out[1] += y * LOBE_FLAT * size * lump * shares[k];
    out[2] += z * size * lump * shares[k];
  }
}
