import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Vector3 } from "three/webgpu";
import {
  createLakesGeometry,
  type LakesFile,
} from "../../src/components/scene/lakes/geometry";

/** Each triangle's corners, in the world. */
function triangles(file: LakesFile, origin: [number, number]) {
  const geometry = createLakesGeometry(file, origin);
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex()!;
  const out: Vector3[][] = [];

  for (let i = 0; i < index.count; i += 3) {
    out.push(
      [0, 1, 2].map((k) =>
        new Vector3().fromBufferAttribute(position, index.getX(i + k))
      )
    );
  }

  return out;
}

/** Up, times twice the area. */
function upward([a, b, c]: Vector3[]) {
  return new Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).y;
}

describe("the lakes' sheet", () => {
  // 100 m square, an island 20 m square in it, 140 m up; its shore wound
  // clockwise and the island anticlockwise, the wrong way round for both.
  const file: LakesFile = {
    origin: [1748100, 5428200],
    lakes: [
      {
        name: "Test",
        level: 140,
        rings: [
          [0, 0, 0, 100, 100, 100, 100, 0],
          [40, 40, 60, 40, 60, 60, 40, 60],
        ],
      },
    ],
  };

  const drawn = triangles(file, [1748000, 5428000]);

  it("lies level at the lake's height, facing up", () => {
    for (const corners of drawn) {
      for (const p of corners) expect(p.y).toBe(140);

      expect(upward(corners)).toBeGreaterThan(0);
    }
  });

  it("leaves the island out", () => {
    const area = drawn.reduce((sum, t) => sum + upward(t) / 2, 0);

    expect(area).toBeCloseTo(100 * 100 - 20 * 20);
  });

  it("is placed from the terrain's origin, north as -z", () => {
    const xs = drawn.flat().map((p) => p.x);
    const zs = drawn.flat().map((p) => p.z);

    expect(Math.min(...xs)).toBe(100);
    expect(Math.max(...xs)).toBe(200);
    expect(Math.min(...zs)).toBe(-300);
    expect(Math.max(...zs)).toBe(-200);
  });
});

describe("lakes.json", () => {
  const file: LakesFile = JSON.parse(
    readFileSync("public/lakes/lakes.json", "utf8")
  );

  it("has Zealandia's two reservoirs, up in the hills", () => {
    for (const name of ["Lower Karori Reservoir", "Upper Karori Reservoir"]) {
      const lake = file.lakes.find((l) => l.name === name);

      expect(lake, name).toBeDefined();
      expect(lake!.level).toBeGreaterThan(100);
    }
  });

  it("faces every lake's triangles up", () => {
    const drawn = triangles(file, file.origin);

    expect(drawn.length).toBeGreaterThan(file.lakes.length);

    // Bar slivers along a straight shore, which float32 can tip either way.
    for (const corners of drawn) {
      expect(upward(corners)).toBeGreaterThan(-0.01);
    }
  });
});
