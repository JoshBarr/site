import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Vector3 } from "three/webgpu";
import { flowAlong } from "../../src/components/scene/rivers/flow";
import {
  createRiversGeometry,
  type RiversFile,
} from "../../src/components/scene/rivers/geometry";
import { paintRipples } from "../../src/components/scene/rivers/ripples";

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

  it("carries how its water runs: how far down, how far off its middle", () => {
    const geometry = createRiversGeometry(file, [1748000, 5428000]);
    const flow = geometry.getAttribute("flow");
    const reach = geometry.getAttribute("reach");
    const stations = [0, 1, 2, 3, 4, 5];

    // Which side, bank by bank; and a river 20 m wide has the pattern at
    // two thirds of life.
    expect(stations.map((i) => reach.getX(i))).toEqual([-1, 1, -1, 1, -1, 1]);

    for (const i of stations) expect(reach.getZ(i)).toBeCloseTo(2 / 3);

    // Down the river, bank to bank the same, and off its middle, the left
    // bank's under 0: both in the pattern's metres, half as long again.
    const [downs, offs] = [
      stations.map((i) => flow.getX(i)),
      stations.map((i) => flow.getY(i)),
    ];

    for (const [i, down] of [0, 0, 15, 15, 30, 30].entries()) {
      expect(downs[i]).toBeCloseTo(down);
    }

    for (const [i, off] of [-15, 15, -15, 15, -15, 15].entries()) {
      expect(offs[i]).toBeCloseTo(off);
    }

    // Its speed, bank to bank the same, and running.
    for (const i of [0, 2, 4]) {
      expect(flow.getZ(i)).toBe(flow.getZ(i + 1));
      expect(flow.getZ(i)).toBeGreaterThan(0);
    }
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

describe("a river's flow", () => {
  /**
   * A straight river running east, a station every 10 m: `widths` wide at
   * each, its water falling `falls` m to the next.
   */
  const reach = (widths: number[], falls: number[]) => {
    const points: number[] = [];
    const levels: number[] = [];
    let level = 50;

    for (const [station, width] of widths.entries()) {
      points.push(
        station * 10,
        width / 2,
        level,
        station * 10,
        -width / 2,
        level
      );
      levels.push(level);
      level -= falls[station] ?? 0;
    }

    return flowAlong("Test", points, levels);
  };

  const steady = (stations: number, width: number, fall: number) =>
    reach(
      Array.from({ length: stations }, () => width),
      Array.from({ length: stations }, () => fall)
    );

  it("measures each station's way down the river, and half its width", () => {
    const { along, halfWidths } = steady(4, 30, 0.02);

    expect(along).toEqual([0, 10, 20, 30]);
    expect(halfWidths).toEqual([15, 15, 15, 15]);
  });

  it("runs quicker down a steeper fall", () => {
    const [gentle] = steady(40, 30, 0.01).speeds.slice(20);
    const [steep] = steady(40, 30, 0.08).speeds.slice(20);

    expect(steep).toBeGreaterThan(gentle * 1.5);
  });

  it("runs slower where it's wider", () => {
    const [narrow] = steady(40, 15, 0.02).speeds.slice(20);
    const [wide] = steady(40, 60, 0.02).speeds.slice(20);

    expect(wide).toBeLessThan(narrow);
  });

  it("still moves where its water's level", () => {
    const { speeds, roughs } = steady(40, 150, 0);

    for (const speed of speeds) {
      expect(speed).toBeGreaterThan(0.05);
      expect(speed).toBeLessThan(0.5);
    }

    expect(Math.max(...roughs)).toBe(0);
  });

  it("breaks white down a riffle, and not in the pools either side", () => {
    // 300 m of pool, 100 m of riffle falling 1.5 m, 300 m of pool.
    const falls = Array.from({ length: 70 }, (_, station) =>
      station >= 30 && station < 40 ? 0.15 : 0.002
    );

    const { roughs, speeds } = reach(
      falls.map(() => 30),
      falls
    );

    expect(roughs[35]).toBeGreaterThan(0.5);
    expect(roughs[10]).toBe(0);
    expect(roughs[60]).toBe(0);
    expect(speeds[35]).toBeGreaterThan(speeds[10] * 2);
  });

  it("draws the pattern smaller on a narrow river, never on a wide one", () => {
    const stream = steady(20, 6, 0.05);
    const river = steady(20, 60, 0.02);

    expect(stream.scales[10]).toBeCloseTo(0.2);
    expect(river.scales[10]).toBe(1);

    // Ten metres of a stream is fifty of the pattern's; of a river, ten.
    expect(stream.drifts[11] - stream.drifts[10]).toBeCloseTo(50);
    expect(river.drifts[11] - river.drifts[10]).toBeCloseTo(10);
  });

  it("carries a riffle's foam on downstream, thinning out", () => {
    // 300 m of pool, 100 m of riffle falling 1.5 m, 600 m of pool.
    const falls = Array.from({ length: 100 }, (_, station) =>
      station >= 30 && station < 40 ? 0.15 : 0.002
    );

    const { foams } = reach(
      falls.map(() => 30),
      falls
    );

    // None above it, all there is on it, and less and less below.
    expect(foams[10]).toBe(0);
    expect(foams[35]).toBe(1);
    expect(foams[55]).toBeGreaterThan(0.2);
    expect(foams[55]).toBeLessThan(foams[45]);
    expect(foams[95]).toBeLessThan(0.05);
  });

  it("has the Hutt quick down its valley and slack across its estuary", () => {
    const file: RiversFile = JSON.parse(
      readFileSync("public/rivers/rivers.json", "utf8")
    );

    const hutt = file.rivers.find(
      ({ name }) => name === "Te Awa Kairangi / Hutt River"
    )!;

    const { speeds, roughs, foams } = flowAlong(
      hutt.name,
      hutt.points,
      hutt.levels
    );

    const sorted = speeds.toSorted((a, b) => a - b);

    // About a metre a second, as a gravel river that size runs.
    expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThan(0.6);
    expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(1.4);
    expect(sorted.at(-1)).toBeLessThan(3);

    // Its last kilometre, at the sea's level: slack, and unbroken.
    for (const speed of speeds.slice(-120)) expect(speed).toBeLessThan(0.4);

    expect(Math.max(...roughs.slice(-120))).toBe(0);

    // And clear: what foam its riffles raise is long gone by the sea.
    expect(Math.max(...foams.slice(-120))).toBeLessThan(0.01);
  });
});

describe("the ripples' pattern", () => {
  const { size, texels } = paintRipples();

  /** One channel's texels. */
  const channel = (c: number) =>
    Array.from({ length: size * size }, (_, i) => texels[i * 4 + c]);

  it("uses each channel's range, the slopes about level", () => {
    for (const c of [0, 1]) {
      const slopes = channel(c);
      const mean = slopes.reduce((sum, v) => sum + v, 0) / slopes.length;

      expect(mean).toBeGreaterThan(125);
      expect(mean).toBeLessThan(130);
      expect(Math.max(...slopes) - Math.min(...slopes)).toBeGreaterThan(200);
    }

    const streaks = channel(2);

    expect(Math.min(...streaks)).toBe(0);
    expect(Math.max(...streaks)).toBe(255);
  });

  it("draws its foam as lines: a few in a hundred of it, and whole", () => {
    const lines = channel(3);
    const cover = lines.reduce((sum, v) => sum + v, 0) / lines.length / 255;

    expect(cover).toBeGreaterThan(0.015);
    expect(cover).toBeLessThan(0.08);
    expect(Math.max(...lines)).toBeGreaterThan(230);
    expect(Math.min(...lines)).toBe(0);
  });

  it("repeats without a seam: no step at its edges like none inside", () => {
    for (const c of [0, 1, 2, 3]) {
      const texel = (x: number, y: number) =>
        texels[((y % size) * size + (x % size)) * 4 + c];

      let atEdge = 0;
      let inside = 0;

      for (let i = 0; i < size; i++) {
        // From the last column round to the first, and the last row to
        // the first; against every step between neighbours inside.
        atEdge = Math.max(
          atEdge,
          Math.abs(texel(size - 1, i) - texel(0, i)),
          Math.abs(texel(i, size - 1) - texel(i, 0))
        );

        for (let j = 0; j < size - 1; j++) {
          inside = Math.max(
            inside,
            Math.abs(texel(j, i) - texel(j + 1, i)),
            Math.abs(texel(i, j) - texel(i, j + 1))
          );
        }
      }

      expect(atEdge).toBeLessThanOrEqual(inside);
    }
  });
});
