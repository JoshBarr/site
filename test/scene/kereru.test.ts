import { describe, expect, it } from "vitest";
import { isKereru, kereruForm } from "../../src/components/scene/birds/kereru";

// The kererū's own shape: a closed body seen from outside, wings that hinge
// clear of it, and its white belly, in greys.

const { geometry, shoulder } = kereruForm();
const position = geometry.getAttribute("position");
const part = geometry.getAttribute("part");
const paint = geometry.getAttribute("paint");

interface Triangle {
  wing: boolean;
  corners: [number, number, number][];
  /** Its face's normal, by its winding; not unit length. */
  normal: [number, number, number];
  middle: [number, number, number];
  /** Its grey, 0 black to 1 white. */
  tone: number;
}

const triangles: Triangle[] = [];

for (let i = 0; i < position.count; i += 3) {
  const corners = [0, 1, 2].map((k): [number, number, number] => [
    position.getX(i + k),
    position.getY(i + k),
    position.getZ(i + k),
  ]);

  const [a, b, c] = corners;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];

  triangles.push({
    wing: part.getX(i) === 1,
    corners,
    normal: [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ],
    middle: [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ],
    tone: paint.getX(i),
  });
}

describe("the kererū's shape", () => {
  it("is the New Zealand pigeon's alone", () => {
    expect(isKereru("New Zealand Pigeon")).toBe(true);
    expect(isKereru("Rock Pigeon")).toBe(false);
  });

  it("is a wingspan of one across, longer than it's deep", () => {
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox!;

    expect(max.x - min.x).toBeCloseTo(1);
    expect(max.x).toBeCloseTo(-min.x);
    // 51 cm of a 75 cm span, about, and its tail a little long.
    expect(max.z - min.z).toBeGreaterThan(0.65);
    expect(max.z - min.z).toBeLessThan(0.78);
  });

  it("paints in greys, one to a vertex", () => {
    expect(paint.itemSize).toBe(1);

    for (const { tone } of triangles) {
      expect(tone).toBeGreaterThan(0);
      expect(tone).toBeLessThan(1);
    }
  });

  it("paints every corner of a triangle alike, and as a wing or not", () => {
    for (let i = 0; i < position.count; i += 3) {
      for (const k of [1, 2]) {
        expect(part.getX(i + k)).toBe(part.getX(i));
        expect(paint.getX(i + k)).toBe(paint.getX(i));
      }
    }
  });

  it("has wings that swing from the shoulder out, not through the body", () => {
    const wings = triangles.filter(({ wing }) => wing);

    expect(wings.length).toBeGreaterThan(0);

    for (const { corners } of wings) {
      for (const corner of corners) {
        expect(Math.abs(corner[0])).toBeGreaterThanOrEqual(shoulder - 1e-6);
      }
    }
  });

  it("has each wing as a sheet facing up over one facing down", () => {
    const wings = triangles.filter(({ wing }) => wing);
    const up = wings.filter(({ normal }) => normal[1] > 0);
    const down = wings.filter(({ normal }) => normal[1] < 0);

    expect(up.length).toBe(down.length);
    expect(up.length + down.length).toBe(wings.length);

    // Paler beneath than above, as its underwing is.
    const mean = (of: Triangle[]) =>
      of.reduce((sum, t) => sum + t.tone, 0) / of.length;

    expect(mean(down)).toBeGreaterThan(mean(up) * 2);
  });

  it("has a closed body facing outward, and a fat one", () => {
    // The volume its faces enclose, by their winding: the tail's two
    // sheets, back to back, enclose none. Inside out, it'd be negative.
    let volume = 0;

    for (const { wing, corners, normal } of triangles) {
      if (wing) continue;

      const [a] = corners;
      volume += (a[0] * normal[0] + a[1] * normal[1] + a[2] * normal[2]) / 6;
    }

    // A ball as wide as the body's widest would hold 0.0056.
    expect(volume).toBeGreaterThan(0.0056);
    expect(volume).toBeLessThan(0.015);
  });

  it("is dark about the head and breast, and white under the belly", () => {
    const under = triangles.filter(
      ({ wing, normal, middle }) =>
        !wing && normal[1] < 0 && Math.abs(middle[0]) < 0.05
    );

    // Behind the bill, ahead of the line across the breast.
    const breast = under.filter(
      ({ middle }) => middle[2] > 0.1 && middle[2] < 0.29
    );

    const belly = under.filter(
      ({ middle }) => middle[2] < 0.08 && middle[2] > -0.18
    );

    expect(breast.length).toBeGreaterThan(0);
    expect(belly.length).toBeGreaterThan(0);

    for (const face of breast) expect(face.tone).toBeLessThan(0.2);

    for (const face of belly) expect(face.tone).toBeGreaterThan(0.8);
  });
});
