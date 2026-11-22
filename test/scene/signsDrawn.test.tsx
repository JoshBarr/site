// @vitest-environment happy-dom
import { readFile } from "node:fs/promises";
import { Mesh } from "three/webgpu";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSigns } from "../../src/components/scene/traffic/signs/build";
import {
  DOTS_HIGH,
  DOTS_WIDE,
} from "../../src/components/scene/traffic/signs/dots";
import type {
  SignsFile,
  Structure,
} from "../../src/components/scene/traffic/signs/file";
import {
  BACK,
  HOUSING,
  LAMPS,
  PAINTED,
  STEEL,
} from "../../src/components/scene/traffic/signs/geometry";
import {
  type Ground,
  placeAll,
} from "../../src/components/scene/traffic/signs/layout";
import { renderScene, shown } from "./render";

// The signs as meshes and lamps: built from a couple of made-up structures
// on a straight road, and in the whole scene from the real ones.

/** A flat road running north from the origin at 100 km/h. */
const north: Ground = {
  toWorld: (easting, northing) => [easting, -northing],
  at: (on) => (on === "N" ? { y: 0, tx: 0, tz: -1, limit: 100 / 3.6 } : null),
};

const message = (id: string, ids: number[], s: number): Structure => ({
  id,
  kind: "post",
  on: "N",
  s,
  a: [-8, s],
  b: [-8, s],
  panels: [{ on: "N", s, t: 0, face: { kind: "vms", ids, size: "large" } }],
});

const file: SignsFile = {
  structures: [
    message("first", [7], 100),
    message("second", [9, 8], 200),
    {
      id: "exit",
      kind: "post",
      on: "N",
      s: 300,
      a: [-8, 300],
      b: [-8, 300],
      panels: [
        {
          on: "N",
          s: 300,
          t: 0,
          face: { kind: "direction", lines: ["Karori"], arrow: "left" },
        },
      ],
    },
    {
      id: "limit",
      kind: "post",
      on: "N",
      s: 400,
      a: [-6, 400],
      b: [-6, 400],
      panels: [{ on: "N", s: 400, t: 0, face: { kind: "speed", limit: 80 } }],
    },
  ],
};

/** How many lamps are lit in sign `k`'s band, on each page. */
function lit(signs: ReturnType<typeof createSigns>, k: number) {
  const { data } = signs.lampMap.image;

  if (!(data instanceof Uint8Array)) throw new Error("the lamps aren't bytes");

  const pages = [0, 0];

  for (let row = 0; row < DOTS_HIGH; row++) {
    for (let x = 0; x < DOTS_WIDE * 2; x++) {
      if (data[(k * DOTS_HIGH + row) * DOTS_WIDE * 2 + x]) {
        pages[x < DOTS_WIDE ? 0 : 1]++;
      }
    }
  }

  return pages;
}

describe("the signs, built", () => {
  it("are steel, painted faces with their backs, and housed lamps, in one mesh when near each other", () => {
    const signs = createSigns(placeAll(file, north));

    expect(signs.meshes).toHaveLength(1);
    const { geometry } = signs.meshes[0];
    const parts = new Set(geometry.getAttribute("part").array);

    expect(parts).toEqual(new Set([STEEL, PAINTED, LAMPS, BACK, HOUSING]));
    expect(geometry.index!.count % 3).toBe(0);
    // From the first sign to the last, and from the ground up.
    expect(geometry.boundingBox!.min.z).toBeLessThan(-399);
    expect(geometry.boundingBox!.max.z).toBeGreaterThan(-101);
    expect(geometry.boundingBox!.max.y).toBeGreaterThan(5);
    signs.dispose();
  });

  it("go in separate meshes when kilometres apart", () => {
    const far = createSigns(
      placeAll(
        { structures: [message("a", [1], 100), message("b", [2], 9000)] },
        north
      )
    );

    expect(far.meshes).toHaveLength(2);
    far.dispose();
  });

  it("map each lamp quad onto its own sign's band of the grid", () => {
    const signs = createSigns(placeAll(file, north));
    const { geometry } = signs.meshes[0];
    const part = geometry.getAttribute("part");
    const dot = geometry.getAttribute("lamp");
    const bands = new Map<number, { x: number[]; y: number[] }>();

    for (let i = 0; i < part.count; i++) {
      if (part.getX(i) !== LAMPS) continue;
      const band = bands.get(dot.getZ(i)) ?? { x: [], y: [] };

      band.x.push(dot.getX(i));
      band.y.push(dot.getY(i));
      bands.set(dot.getZ(i), band);
    }

    expect([...bands.keys()].sort()).toEqual([0, 1]);

    for (const { x, y } of bands.values()) {
      // The quad's the housing: the grid, and a bezel's worth of dots round it.
      expect(Math.min(...x)).toBeCloseTo(-3, 5);
      expect(Math.max(...x)).toBeCloseTo(DOTS_WIDE + 3, 5);
      expect(Math.min(...y)).toBeCloseTo(-3, 5);
      expect(Math.max(...y)).toBeCloseTo(DOTS_HIGH + 3, 5);
    }

    signs.dispose();
  });

  it("light each sign's lamps with its message, both pages, and nothing for a blank one", () => {
    const signs = createSigns(placeAll(file, north));

    signs.show({ 7: "CRASH AHEAD[np]EXPECT DELAYS", 8: "", 9: "" }, null);

    const [one, two] = lit(signs, 0);

    expect(one).toBeGreaterThan(50);
    expect(two).toBeGreaterThan(50);
    expect(one).not.toBe(two);
    expect(lit(signs, 1)).toEqual([0, 0]);
    signs.dispose();
  });

  it("show a one-page message on both pages, from whichever of a sign's records has one", () => {
    const signs = createSigns(placeAll(file, north));

    signs.show({ 8: "PETONE [jl4]9", 9: " " }, null);

    const [one, two] = lit(signs, 1);

    expect(one).toBeGreaterThan(20);
    expect(two).toBe(one);
    expect(lit(signs, 0)).toEqual([0, 0]);
    signs.dispose();
  });

  it("light a lane sign's square with the limit it's given, and leave it dark without", () => {
    const lanes = createSigns(
      placeAll(
        {
          structures: [
            {
              id: "lanes",
              kind: "gantry",
              on: "N",
              s: 200,
              a: [-8, 200],
              b: [8, 200],
              panels: [
                {
                  on: "N",
                  s: 200,
                  t: 0.5,
                  face: { kind: "lane", zone: "motorway" },
                },
              ],
            },
          ],
        },
        north
      )
    );

    const { geometry } = lanes.meshes[0];
    const part = geometry.getAttribute("part");
    const dot = geometry.getAttribute("lamp");
    const x: number[] = [];

    for (let i = 0; i < part.count; i++) {
      if (part.getX(i) === LAMPS) x.push(dot.getX(i));
    }

    // Its grid's the square at the left of its band.
    expect(Math.max(...x) - Math.min(...x)).toBeLessThan(DOTS_HIGH + 6);
    expect(lanes.lanes).toHaveLength(1);

    lanes.show(null, null);
    expect(lit(lanes, 0)).toEqual([0, 0]);

    lanes.show(null, "IGNORED", new Map([[lanes.lanes[0], 80]]));
    const [one, two] = lit(lanes, 0);

    expect(one).toBeGreaterThan(100);
    expect(two).toBe(one);
    lanes.dispose();
  });

  it("go dark with no messages, and all show an override", () => {
    const signs = createSigns(placeAll(file, north));

    signs.show({ 7: "CRASH AHEAD" }, null);
    signs.show(null, null);
    expect(lit(signs, 0)).toEqual([0, 0]);

    signs.show({ 7: "CRASH AHEAD" }, "TEST");
    expect(lit(signs, 0)).toEqual(lit(signs, 1));
    expect(lit(signs, 0)[0]).toBeGreaterThan(20);
    signs.dispose();
  });
});

describe("the scene's signs", () => {
  let scene: Awaited<ReturnType<typeof renderScene>> | undefined;
  let built: SignsFile;

  beforeAll(async () => {
    built = JSON.parse(await readFile("public/roads/signs.json", "utf8"));
  });

  afterEach(async () => {
    await scene?.unmount();
    scene = undefined;
  });

  it("stand along the highways, those near the camera drawn", async () => {
    scene = await renderScene(new Date("2026-11-02T00:00:00Z"));
    const { drawn, until } = scene;

    await until(() => drawn("signs").length > 0);

    const [signs] = drawn("signs");

    const meshes = signs.children.flatMap((child) =>
      child instanceof Mesh ? [child] : []
    );

    expect(meshes.length).toBeGreaterThan(3);

    // A lamp quad for every message sign and lane sign there is.
    const lamps = meshes.reduce((n, { geometry }) => {
      const part = geometry.getAttribute("part");
      let quads = 0;

      for (let i = 0; i < part.count; i++) if (part.getX(i) === LAMPS) quads++;

      return n + quads / 4;
    }, 0);

    expect(lamps).toBe(
      built.structures.flatMap(({ panels }) =>
        panels.filter(({ face }) => face.kind === "vms" || face.kind === "lane")
      ).length
    );

    // Over the city, the motorway's are drawn; Upper Hutt's aren't.
    await until(() => meshes.some((mesh) => !shown(mesh)));
    expect(meshes.some(shown)).toBe(true);
  });
});
