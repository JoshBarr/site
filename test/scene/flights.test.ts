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

/** Fixes from seconds after `start`, as adsb.lol had them. */
const from = (start: number, fixes: Fix[]): Fix[] =>
  fixes.map(([e, n, alt, s, ...rest]) => [
    e,
    n,
    alt,
    start + s * 1000,
    ...rest,
  ]);

/**
 * ANZ327 at the domestic terminal on 2026-11-10: pushed back, the nose
 * swung from east-south-east round to north as the tail went west and south,
 * then a minute and a half's wait and off north up the taxiway. adsb.lol's
 * track is where the nose points through the pushback.
 */
const PUSHBACK = from(1794248040000, [
  [1751430, 5423015, null, 20, 0, 112.5, null],
  [1751430, 5423015, null, 30, 0, 112.5, null],
  [1751405, 5423027, null, 53, 1.95, 112.5, null],
  [1751391, 5423038, null, 63, 1.95, 81.56, null],
  [1751378, 5423041, null, 70, 1.65, 47.81, null],
  [1751363, 5423025, null, 83, 1.95, 8.44, null],
  [1751359, 5423009, null, 92, 1.65, 5.62, null],
  [1751359, 5423006, null, 99, 0.05, 5.62, null],
  [1751359, 5423006, null, 148, 0, 5.62, null],
  [1751358, 5423008, null, 279, 0, 5.62, null],
  [1751360, 5423020, null, 293, 1.44, 2.81, null],
  [1751361, 5423041, null, 303, 2.68, 2.81, null],
  [1751364, 5423075, null, 313, 3.7, 2.81, null],
  [1751366, 5423116, null, 322, 4.53, 2.81, null],
]);

/**
 * ANZ810M taxiing out on 2026-11-10: west along the apron, north, a dogleg
 * west and up the taxiway, round onto the runway and away. The track lags
 * behind the turns: 244.69 for 40 s after it's turned north.
 */
const TAXI = from(1794248040000, [
  [1751514, 5423131, null, 0, 2.47, 244.69, null],
  [1751481, 5423123, null, 13, 4.01, 244.69, null],
  [1751429, 5423127, null, 24, 5.25, 244.69, null],
  [1751382, 5423133, null, 34, 5.04, 244.69, null],
  [1751371, 5423180, null, 44, 4.73, 244.69, null],
  [1751375, 5423232, null, 54, 5.56, 244.69, null],
  [1751380, 5423291, null, 64, 6.07, 2.81, null],
  [1751358, 5423342, null, 74, 6.07, 303.75, null],
  [1751320, 5423380, null, 84, 5.76, 348.75, null],
  [1751325, 5423440, null, 93, 6.58, 2.81, null],
  [1751331, 5423522, null, 104, 8.49, 2.81, null],
  [1751385, 5424278, null, 194, 6.79, 2.81, null],
  [1751366, 5424331, null, 204, 5.76, 309.38, null],
  [1751308, 5424342, null, 214, 6.07, 261.56, null],
  [1751280, 5424304, null, 223, 5.04, 191.25, null],
  [1751274, 5424233, null, 234, 15.18, 182.81, null],
  [1751252, 5423927, null, 244, 42.7, 182.81, null],
  [1751214, 5423410, 15, 254, 61.84, 182.86, 0],
]);

const wrap = (angle: number) =>
  angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));

/**
 * The aircraft's pose every half second along `fixes`' path, from `start` to
 * `end` seconds after the first, with which way it moved since the last.
 */
function sample(fixes: Fix[], start: number, end: number) {
  const path = buildPath(fixes, fixes[0][3], toWorld, groundAt);
  const poses: (Pose & { travel: number | null; turn: number })[] = [];

  for (let t = start; t <= end; t += 0.5) {
    const at = pose();

    if (!poseAt(path, t, at)) continue;
    const last = poses.at(-1);
    const dx = last ? at.x - last.x : 0;
    const dz = last ? at.z - last.z : 0;

    poses.push({
      ...at,
      travel: Math.hypot(dx, dz) > 0.3 ? Math.atan2(dx, -dz) : null,
      turn: last ? Math.abs(wrap(at.heading - last.heading)) / 0.5 : 0,
    });
  }

  return poses;
}

const degrees = (radians: number) => (radians * 180) / Math.PI;

describe("aircraft taxiing", () => {
  it("turns no faster than an aircraft can, even when the track lags", () => {
    const poses = sample(TAXI, 0, 240);

    expect(degrees(Math.max(...poses.map(({ turn }) => turn)))).toBeLessThan(
      30
    );
  });

  it("goes the way its nose points, even when the track lags", () => {
    for (const { heading, travel } of sample(TAXI, 0, 240)) {
      if (travel === null) continue;
      expect(degrees(Math.abs(wrap(heading - travel)))).toBeLessThan(45);
    }
  });

  it("never runs backwards between its fixes", () => {
    for (const { heading, travel } of sample(PUSHBACK, 160, 350)) {
      if (travel === null) continue;
      expect(degrees(Math.abs(wrap(heading - travel)))).toBeLessThan(45);
    }
  });

  it("goes tail first when it's pushed back", () => {
    const poses = sample(PUSHBACK, 0, 100);
    let backing = 0;

    for (const { heading, travel } of poses) {
      if (travel === null) continue;
      backing++;
      expect(degrees(Math.abs(wrap(heading - travel)))).toBeGreaterThan(135);
    }

    expect(backing).toBeGreaterThan(40);
    expect(degrees(Math.max(...poses.map(({ turn }) => turn)))).toBeLessThan(
      30
    );
  });

  it("keeps facing the way it was pushed while it waits", () => {
    const poses = sample(PUSHBACK, 100, 270);

    for (const { heading } of poses) {
      expect(Math.abs(degrees(wrap(heading)))).toBeLessThan(20);
    }
  });
});

describe("aircraft in the air", () => {
  /** A ridge 290 m high across x = 0, on 100 m hills. */
  const ridge = (x: number) => (Math.abs(x) < 50 ? 290 : 100);

  it("keeps clear of a ridge between two fixes", () => {
    // ZK-LTU, a Cresco topdressing near Pāuatahanui, skims the hills: fixes
    // either side of the ridge, both higher than it.
    const fixes: Fix[] = [
      [ORIGIN[0] - 600, ORIGIN[1], 300, T, 60, 90, 0],
      [ORIGIN[0] + 600, ORIGIN[1], 300, T + 20_000, 60, 90, 0],
    ];

    const path = buildPath(fixes, T, toWorld, ridge);
    let lowest = Infinity;

    for (let i = 0; i < path.t.length; i++) {
      if (Math.abs(path.x[i]) < 50) lowest = Math.min(lowest, path.y[i]);
    }

    expect(lowest).toBeGreaterThanOrEqual(320);
  });

  it("comes down onto the runway it's landing on", () => {
    const fixes: Fix[] = [
      [ORIGIN[0], ORIGIN[1] - 1000, 40, T, 65, 0, -3.5],
      [ORIGIN[0], ORIGIN[1] - 500, 15, T + 8_000, 63, 0, -3],
      [ORIGIN[0], ORIGIN[1], null, T + 16_000, 55, 0, null],
    ];

    const path = buildPath(fixes, T, toWorld, groundAt);
    const at = pose();

    // A second out, the clearance has all but gone.
    expect(poseAt(path, 15, at)).toBe(true);
    expect(at.y).toBeLessThan(7);
    expect(poseAt(path, 16, at)).toBe(true);
    expect(at.ground).toBe(true);
  });

  it("isn't held up off the ground past its last fix", () => {
    const fixes: Fix[] = [
      [ORIGIN[0], ORIGIN[1] - 1000, 40, T, 65, 0, -3.5],
      [ORIGIN[0], ORIGIN[1] - 500, 15, T + 8_000, 63, 0, -3],
    ];

    const path = buildPath(fixes, T, toWorld, groundAt);

    expect(path.y[path.y.length - 1]).toBe(5);
  });
});
