import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Vector3 } from "three/webgpu";
import {
  createRiversGeometry,
  type RiversFile,
} from "../../src/components/scene/rivers/geometry";

/** Each triangle's corners, in the world. */
function triangles(file: RiversFile, origin: [number, number]) {
  const geometry = createRiversGeometry(file, origin);
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

describe("the rivers' ribbon", () => {
  // 20 m wide, running east for 20 m in two stations' steps, falling a
  // metre: left bank (north) then right (south) at each.
  const file: RiversFile = {
    origin: [1748100, 5428200],
    fade: 10,
    rivers: [
      {
        name: "Test",
        points: [
          [0, 10, 5],
          [0, -10, 5],
          [10, 10, 4.5],
          [10, -10, 4.5],
          [20, 10, 4],
          [20, -10, 4],
        ].flat(),
        levels: [5, 4.5, 3.5],
      },
    ],
  };

  const drawn = triangles(file, [1748000, 5428000]);

  it("joins bank to bank, station to station, facing up", () => {
    expect(drawn).toHaveLength(4);

    for (const corners of drawn) expect(upward(corners)).toBeGreaterThan(0);

    const area = drawn.reduce((sum, t) => sum + upward(t) / 2, 0);

    expect(area).toBeCloseTo(20 * 20);
  });

  it("carries the water's height down the river", () => {
    const heights = drawn.flat().map((p) => p.y);

    expect(Math.max(...heights)).toBe(5);
    expect(Math.min(...heights)).toBe(4);
  });

  it("fades out over its last `fade` metres, into the sea", () => {
    const fades = createRiversGeometry(file, [1748000, 5428000]).getAttribute(
      "fade"
    );

    expect(Array.from(fades.array)).toEqual([1, 1, 1, 1, 0, 0]);
  });

  it("carries the water's own level, bank to bank the same", () => {
    const levels = createRiversGeometry(file, [1748000, 5428000]).getAttribute(
      "level"
    );

    expect(Array.from(levels.array)).toEqual([5, 5, 4.5, 4.5, 3.5, 3.5]);
  });

  it("is placed from the terrain's origin, north as -z", () => {
    const xs = drawn.flat().map((p) => p.x);
    const zs = drawn.flat().map((p) => p.z);

    expect(Math.min(...xs)).toBe(100);
    expect(Math.max(...xs)).toBe(120);
    expect(Math.min(...zs)).toBe(-210);
    expect(Math.max(...zs)).toBe(-190);
  });
});

describe("rivers.json", () => {
  const file: RiversFile = JSON.parse(
    readFileSync("public/rivers/rivers.json", "utf8")
  );

  const river = (name: string) => {
    const found = file.rivers.find((r) => r.name === name);

    expect(found, name).toBeDefined();

    return found!.points;
  };

  /** NZTM of a river's last pair of points, between its banks. */
  const mouth = (points: number[]) => {
    const n = points.length;

    return [
      file.origin[0] + (points[n - 6] + points[n - 3]) / 2,
      file.origin[1] + (points[n - 5] + points[n - 2]) / 2,
    ];
  };

  it("has the Hutt, the Wainuiomata and the Ōrongorongo", () => {
    for (const name of [
      "Te Awa Kairangi / Hutt River",
      "Wainuiomata River",
      "Ōrongorongo River",
    ]) {
      expect(river(name).length, name).toBeGreaterThan(1000);
    }
  });

  it("runs every river out into the sea", () => {
    // Out past each one's mouth: the Hutt's at Petone, the others' on the
    // south coast, behind their beaches' bars.
    const mouths: [string, number, number][] = [
      ["Te Awa Kairangi / Hutt River", 1759230, 5432870],
      ["Wainuiomata River", 1756720, 5413800],
      ["Ōrongorongo River", 1758800, 5412940],
    ];

    for (const [name, e, n] of mouths) {
      const points = river(name);
      const [x, y] = mouth(points);

      expect(Math.hypot(x - e, y - n), name).toBeLessThan(400);
      expect(points.at(-1), name).toBeLessThan(0.5);
    }
  });

  it("has a level for every station, never rising on the way down", () => {
    for (const { name, points, levels } of file.rivers) {
      expect(levels.length, name).toBe(points.length / 6);

      for (let i = 1; i < levels.length; i++) {
        expect(levels[i], `${name} at ${i}`).toBeLessThanOrEqual(levels[i - 1]);
      }
    }
  });

  it("fills the Hutt's estuary, bank to bank", () => {
    // 180 m and more of water at the mouth, as the lidar has it: a ribbon
    // held to 90 m left bare flats either side, down to the sea.
    const points = river("Te Awa Kairangi / Hutt River");
    const n = points.length;

    // 200 m up from its end, so 80 m in from the coast.
    const at = n - 6 * 26;

    expect(
      Math.hypot(points[at] - points[at + 3], points[at + 1] - points[at + 4])
    ).toBeGreaterThan(150);
  });

  it("faces every river's triangles up", () => {
    const drawn = triangles(file, file.origin);

    // Bar slivers on a tight bend's inside, which float32 can tip either way.
    const down = drawn.filter((corners) => upward(corners) < -0.01);

    expect(down.length / drawn.length).toBeLessThan(0.01);
  });
});
