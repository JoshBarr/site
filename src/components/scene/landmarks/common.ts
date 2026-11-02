import { useFrame } from "@react-three/fiber";
import { PerspectiveCamera } from "three/webgpu";
import { cos, sin, uniform, vec3 } from "three/tsl";

// State and helpers shared by the landmark assets.

/**
 * Angle one CSS pixel subtends at the centre of the view, in radians. Distance
 * times this is the size of a pixel there, which thin structures use to stay
 * at least a pixel wide rather than flicker in and out.
 */
export const pixelAngle = uniform(0.001);

/** The same for a device pixel, as screen-space derivatives see them. */
export const devicePixelAngle = uniform(0.001);

/** 0..1: how far through lighting-up; each obstruction light has its moment. */
export const obstructionLights = uniform(0);

/** Keeps pixelAngle current. Mount once per canvas. */
export function usePixelAngle() {
  useFrame(({ camera, size, viewport }) => {
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 50;
    pixelAngle.value =
      (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(size.height, 1);
    devicePixelAngle.value = pixelAngle.value / viewport.dpr;
  });
}

// Rotations about the axes, right-handed, for node vectors.

export function rotateX(v, angle) {
  const c = cos(angle);
  const s = sin(angle);

  return vec3(v.x, v.y.mul(c).sub(v.z.mul(s)), v.y.mul(s).add(v.z.mul(c)));
}

export function rotateY(v, angle) {
  const c = cos(angle);
  const s = sin(angle);

  return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
}

export function rotateZ(v, angle) {
  const c = cos(angle);
  const s = sin(angle);

  return vec3(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)), v.z);
}

/** Deterministic 0..1 values from an integer, for per-instance variety. */
export function random(seed: number) {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
