import { describe, expect, it } from "vitest";
import {
  FAR_RANGES,
  SHRUB_RANGES,
  shrubAttributes,
  treeAttributes,
} from "../../src/components/scene/trees/geometry";

/**
 * Faces of a lobed shape, each as its normal and centre. A lobe vertex is a
 * unit direction; a trunk one (lobe -1) is (cos, t, sin) up its axis.
 */
function faces({ lobe, index }: ReturnType<typeof shrubAttributes>) {
  const a = lobe.array;
  const ix = index.array;
  const found: { normal: number[]; centre: number[]; trunk: boolean }[] = [];

  for (let f = 0; f < ix.length; f += 3) {
    const p = [ix[f], ix[f + 1], ix[f + 2]].map((v) =>
      [0, 1, 2, 3].map((c) => a[v * 4 + c])
    );

    const e1 = [0, 1, 2].map((c) => p[1][c] - p[0][c]);
    const e2 = [0, 1, 2].map((c) => p[2][c] - p[0][c]);

    found.push({
      normal: [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ],
      centre: [0, 1, 2].map((c) => (p[0][c] + p[1][c] + p[2][c]) / 3),
      trunk: p[0][3] < 0,
    });
  }

  return found;
}

describe("tree and shrub shapes", () => {
  const shapes = {
    "near trees": treeAttributes("near"),
    "far trees": treeAttributes("far"),
    shrubs: shrubAttributes(),
  };

  for (const [name, attributes] of Object.entries(shapes)) {
    it(`${name} face outward, so their backs are culled`, () => {
      for (const { normal, centre, trunk } of faces(attributes)) {
        // Out from a lobe's middle, or out from the trunk's axis.
        const out = trunk ? [centre[0], 0, centre[2]] : centre;
        const facing = normal.reduce((sum, n, i) => sum + n * out[i], 0);
        expect(facing).toBeGreaterThan(0);
      }
    });
  }

  it("draws each far tree and shrub shape from its own part of the index", () => {
    for (const [ranges, { index }] of [
      [FAR_RANGES, shapes["far trees"]],
      [SHRUB_RANGES, shapes.shrubs],
    ] as const) {
      expect(ranges[0].start).toBe(0);
      expect(ranges[1].start).toBe(ranges[0].count);
      expect(ranges[1].start + ranges[1].count).toBe(index.count);
      // The octahedra are the cheaper shape.
      expect(ranges[1].count).toBeLessThan(ranges[0].count);
    }
  });
});
