import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { snowlineAt } from "../../src/components/scene/farland/FarLand";
import {
  FAR_LAND_EAST,
  parseFarLand,
} from "../../src/components/scene/farland/mesh";
import { originIndex } from "../fixtures/terrain";

// The South Island on the horizon: its mesh as the build writes it, and the
// snow on its tops through the year.

/** World x is the easting, z the northing turned round. */
const { manifest } = originIndex();

/** land.bin, as scripts/farland/build_farland.py lays it out. */
function pack(
  [west, north, cell]: [number, number, number],
  vertices: [number, number, number][],
  triangles: [number, number, number][]
) {
  const header = new Uint32Array([
    vertices.length,
    triangles.length,
    west,
    north,
    cell,
  ]);

  const packed = new Int16Array(vertices.flat());
  const indices = new Uint16Array(triangles.flat());

  const file = new Uint8Array(
    header.byteLength + packed.byteLength + indices.byteLength
  );

  file.set(new Uint8Array(header.buffer), 0);
  file.set(new Uint8Array(packed.buffer), header.byteLength);

  file.set(
    new Uint8Array(indices.buffer),
    header.byteLength + packed.byteLength
  );

  return file.buffer;
}

describe("parseFarLand", () => {
  it("puts each vertex on the map, columns east and rows south", () => {
    const { positions, indices } = parseFarLand(
      pack(
        [1500000, 5500000, 250],
        [
          [0, 0, -60],
          [4, 0, 120],
          [4, 2, 2655],
        ],
        [[0, 2, 1]]
      ),
      manifest
    );

    expect([...positions]).toEqual(
      [
        [1500000, -60, -5500000],
        [1501000, 120, -5500000],
        [1501000, 2655, -5499500],
      ].flat()
    );

    expect([...indices]).toEqual([0, 2, 1]);
  });
});

describe("the mesh that's built", () => {
  const load = async () => {
    const file = await readFile("public/farland/land.bin");

    return parseFarLand(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
      manifest
    );
  };

  /** A vertex's easting, height and northing. */
  const vertex = (positions: Float32Array, i: number) => [
    positions[i * 3],
    positions[i * 3 + 1],
    -positions[i * 3 + 2],
  ];

  it("is the top of the South Island, and none of the North", async () => {
    const { positions } = await load();
    const count = positions.length / 3;
    let highest = 0;

    for (let i = 0; i < count; i++) {
      const [easting, height] = vertex(positions, i);

      expect(easting).toBeLessThanOrEqual(FAR_LAND_EAST);
      highest = Math.max(highest, height);
    }

    // Tapuae-o-Uenuku, 2885 m, less what a 250 m grid takes off a summit.
    expect(highest).toBeGreaterThan(2500);
    expect(highest).toBeLessThan(2900);
  });

  it("faces up, every triangle with land in it", async () => {
    const { positions, indices } = await load();

    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => vertex(positions, indices[t + k]));

      // Anticlockwise from above: on the map, where north is up, too.
      const turn =
        (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);

      expect(turn).toBeGreaterThan(0);
      expect(Math.max(a[1], b[1], c[1])).toBeGreaterThan(0);
    }
  });

  it("is drawn from the farthest of it to the nearest", async () => {
    const { positions, indices } = await load();
    // The scene's origin, in Te Aro (public/terrain/manifest.json).
    const [east, north] = [1748000, 5428000];

    const distances: number[] = [];

    for (let t = 0; t < indices.length; t += 3) {
      const corners = [0, 1, 2].map((k) => vertex(positions, indices[t + k]));

      distances.push(
        corners.reduce(
          (sum, [e, , n]) => sum + Math.hypot(e - east, n - north),
          0
        ) / 3
      );
    }

    // Float32 eastings and northings: good to a metre.
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeLessThanOrEqual(distances[i - 1] + 1);
    }

    // From past the Kaikōuras to Arapawa Island, across the strait.
    expect(distances[0]).toBeGreaterThan(150_000);
    expect(distances.at(-1)).toBeLessThan(40_000);
  });
});

describe("snowlineAt", () => {
  const line = (date: string) => snowlineAt(new Date(`${date}T00:00:00Z`));

  it("is lowest at the end of winter and highest at summer's", () => {
    expect(line("2026-08-25")).toBeCloseTo(1200, -1);
    expect(line("2026-02-24")).toBeCloseTo(2600, -1);
  });

  it("climbs through spring", () => {
    const spring = ["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"];
    const lines = spring.map(line);

    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).toBeGreaterThan(lines[i - 1]);
    }
  });
});
