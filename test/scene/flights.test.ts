import { describe, expect, it } from "vitest";
import type { Fix } from "../../src/lib/flights";
import { createClearance } from "../../src/components/scene/flights/clearance";
import {
  buildPath,
  Pose,
  poseAt,
  ToWorld,
} from "../../src/components/scene/flights/path";

const ORIGIN = [1751000, 5423000];
const toWorld: ToWorld = (e, n) => [e - ORIGIN[0], -(n - ORIGIN[1])];
const groundAt = () => 5;
const B738 = 39.5;

/**
 * QFA171 (VH-VZL, a 737-800) pulling into stand 29 at the International
 * Terminal on 2026-11-03, then a last fix at no speed 28 m on, inside the
 * pier.
 */
const T = 1793672386000;

const PARKING: Fix[] = [
  [1751426, 5423365, null, T, 3.19, 84.38, null],
  [1751521, 5423364, null, T + 29_000, 2.47, 90, null],
  [1751573, 5423347, null, T + 50_000, 2.98, 120.94, null],
  [1751575, 5423327, null, T + 60_000, 1.95, 171.56, null],
  [1751575, 5423315, null, T + 70_000, 1.44, 180, null],
  [1751574, 5423308, null, T + 79_000, 0.72, 180, null],
  [1751574, 5423303, null, T + 89_000, 0.41, 180, null],
  [1751573, 5423303, null, T + 99_000, 0, 180, null],
  [1751579, 5423275, null, T + 109_000, 0, 180, null],
];

const pose = (): Pose => ({
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  pitch: 0,
  bank: 0,
  ground: true,
  height: 0,
});

const northing = (z: number) => ORIGIN[1] - z;

describe("aircraft on the ground", () => {
  it("stays where it stopped when a fix jumps at no speed", () => {
    const path = buildPath(PARKING, T, toWorld, groundAt);
    const at = pose();

    expect(poseAt(path, 200, at)).toBe(true);
    expect(northing(at.z)).toBeCloseTo(5423303, 0);
  });

  it("backs out of the terminal it was parked into", () => {
    const clearance = createClearance(toWorld);
    const [x, z] = toWorld(1751579, 5423275);
    const south = Math.PI;
    const shift = clearance(x, z, south, B738);

    // Backed north, nose out of the pier, to about where it stopped.
    expect(shift).toBeLessThan(-20);
    expect(shift).toBeGreaterThan(-B738);
    expect(clearance(x, z + shift, south, B738)).toBe(0);

    const path = buildPath(PARKING.slice(-1), T, toWorld, groundAt, (x, z, h) =>
      clearance(x, z, h, B738)
    );

    const at = pose();
    poseAt(path, 120, at);
    expect(northing(at.z)).toBeCloseTo(5423275 - shift, 0);
  });

  it("leaves aircraft clear of buildings where they are", () => {
    const clearance = createClearance(toWorld);

    // Where it stopped: its nose a metre or so short of the pier.
    const [x, z] = toWorld(1751574, 5423303);
    expect(Math.abs(clearance(x, z, Math.PI, B738))).toBeLessThanOrEqual(2);

    // Out on the apron and the runway.
    expect(clearance(...toWorld(1751640, 5423303), Math.PI, B738)).toBe(0);
    expect(clearance(...toWorld(1751200, 5423000), 0, B738)).toBe(0);
  });
});
