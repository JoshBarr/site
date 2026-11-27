import { describe, expect, it } from "vitest";
import { Vector3 } from "three/webgpu";
import {
  createSolidsGeometry,
  type Solid,
} from "../../src/components/scene/vessels/marinaGeometry";
import {
  BREAKWATERS,
  PONTOONS,
} from "../../src/components/scene/vessels/marinaOutlines";

// The marinas' pontoons and breakwaters: outlines stood up into solids, a
// flat top with sides down to a foot.

/** NZTM to world: x the easting, z the northing turned round. */
const toWorld = (e: number, n: number): [number, number] => [e, -n];

/** A 10 m square with a 4 m hole in it, as the build winds them. */
const SQUARE_WITH_HOLE: Solid = {
  outline: [
    [0, 0, 10, 0, 10, 10, 0, 10],
    [3, 3, 3, 7, 7, 7, 7, 3],
  ],
  top: 0.5,
  bottom: -0.6,
  batter: 0,
  tone: [0.3, 0.16],
};

/** Each triangle: its corners, normal and tone. */
function trianglesOf(geometry: ReturnType<typeof createSolidsGeometry>) {
  const position = geometry.getAttribute("position");
  const tone = geometry.getAttribute("tone");
  const triangles: { centre: Vector3; normal: Vector3; tone: number }[] = [];

  for (let i = 0; i < position.count; i += 3) {
    const [a, b, c] = [i, i + 1, i + 2].map((j) =>
      new Vector3().fromBufferAttribute(position, j)
    );

    const normal = new Vector3()
      .subVectors(b, a)
      .cross(new Vector3().subVectors(c, a))
      .normalize();

    const centre = new Vector3().add(a).add(b).add(c).divideScalar(3);
    triangles.push({ centre, normal, tone: tone.getX(i) });
  }

  return triangles;
}

describe("createSolidsGeometry", () => {
  it("covers the top but not the hole, facing up", () => {
    const top = trianglesOf(
      createSolidsGeometry([SQUARE_WITH_HOLE], toWorld)
    ).filter(({ tone }) => tone === Math.fround(0.3));

    // Triangles that all face up, none of them over the hole.
    expect(top.length).toBeGreaterThan(0);
    expect(top.every(({ normal }) => normal.y > 0.99)).toBe(true);
    expect(top.every(({ centre }) => centre.y === 0.5)).toBe(true);

    const inHole = top.filter(
      ({ centre: { x, z } }) => x > 3 && x < 7 && -z > 3 && -z < 7
    );

    expect(inHole).toHaveLength(0);
  });

  it("faces its sides away from the solid, the hole's into the hole", () => {
    const sides = trianglesOf(
      createSolidsGeometry([SQUARE_WITH_HOLE], toWorld)
    ).filter(({ tone }) => tone === Math.fround(0.16));

    // Two triangles per edge: 4 outside, 4 round the hole.
    expect(sides).toHaveLength(16);

    for (const { centre, normal } of sides) {
      const fromMiddle = new Vector3(centre.x - 5, 0, centre.z + 5);
      const outside = Math.max(Math.abs(fromMiddle.x), Math.abs(fromMiddle.z));
      // On the outside's edges, away from the middle; on the hole's, toward.
      const facing = Math.sign(normal.dot(fromMiddle));

      expect(Math.abs(normal.y)).toBeLessThan(1e-6);
      expect(facing).toBe(outside > 4 ? 1 : -1);
    }
  });

  it("spreads a battered foot out past the top", () => {
    const mound = createSolidsGeometry(
      [
        {
          ...SQUARE_WITH_HOLE,
          outline: [SQUARE_WITH_HOLE.outline[0]],
          batter: 2,
        },
      ],
      toWorld
    );

    mound.computeBoundingBox();
    const { min, max } = mound.boundingBox!;

    [min.x, max.x, -max.z, -min.z].forEach((edge, i) =>
      expect(edge).toBeCloseTo([-2, 12, -2, 12][i], 4)
    );
  });
});

describe("the marinas' outlines", () => {
  it("has the Chaffers pontoons and Clyde Quay's breakwater walls", () => {
    const near = (outline: number[][], e: number, n: number) =>
      Math.hypot(outline[0][0] - e, outline[0][1] - n) < 400;

    // Chaffers Marina and Clyde Quay Boat Harbour, NZTM.
    expect(
      PONTOONS.filter((o) => near(o, 1749466, 5427579)).length
    ).toBeGreaterThan(5);

    expect(
      BREAKWATERS.filter(
        ({ rock, outline }) => !rock && near(outline, 1749758, 5427507)
      ).length
    ).toBeGreaterThanOrEqual(2);
  });

  it("winds each outside anticlockwise and each hole clockwise", () => {
    const area = (ring: number[]) => {
      let sum = 0;

      for (let i = 0; i < ring.length; i += 2) {
        const j = (i + 2) % ring.length;
        sum += ring[i] * ring[j + 1] - ring[j] * ring[i + 1];
      }

      return sum;
    };

    for (const [outer, ...holes] of [
      ...PONTOONS,
      ...BREAKWATERS.map(({ outline }) => outline),
    ]) {
      expect(area(outer)).toBeGreaterThan(0);
      holes.forEach((hole) => expect(area(hole)).toBeLessThan(0));
    }
  });
});
