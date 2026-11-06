import { describe, expect, it } from "vitest";
import sharp from "sharp";
import path from "node:path";
import {
  flowAt,
  unpackField,
  type WindField,
} from "../../src/components/scene/wind/field";
import { GroundLookup } from "../../src/components/scene/wind/ground";
import {
  type TerrainManifest,
  TileIndex,
} from "../../src/components/scene/terrain/manifest";
import manifest from "../../public/terrain/manifest.json";

const FIELD = path.join(__dirname, "../../public/wind/field.png");

async function loadField(): Promise<WindField> {
  const { data, info } = await sharp(FIELD)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return unpackField(data, info.width, info.height);
}

const { origin, rootSize } = manifest;

/** The surface flow at an NZTM point under a wind blowing from `from`. */
function flowFrom(field: WindField, [e, n]: [number, number], from: number) {
  const toward = ((from + 180) * Math.PI) / 180;
  const wx = Math.sin(toward);
  const wz = -Math.cos(toward);

  return flowAt(field, rootSize, e - origin[0], -(n - origin[1]), wx, wz);
}

const speed = ([x, z]: [number, number]) => Math.hypot(x, z);

const COOK_STRAIT: [number, number] = [1735000, 5415000];
const CBD: [number, number] = [1748900, 5428200];
const HARBOUR: [number, number] = [1756500, 5431500];
// The hills above Makara, where the wind farm is.

const MAKARA: [number, number] = [1740500, 5432500];

describe("the wind field", () => {
  it("leaves the wind as it is out in Cook Strait, whichever way it blows", async () => {
    const field = await loadField();

    for (const from of [0, 90, 180, 270, 340]) {
      expect(speed(flowFrom(field, COOK_STRAIT, from))).toBeGreaterThan(0.9);
      expect(speed(flowFrom(field, COOK_STRAIT, from))).toBeLessThan(1.1);
    }
  });

  it("slows the wind among the city's buildings, and less on the hilltops", async () => {
    const field = await loadField();
    const city = speed(flowFrom(field, CBD, 340));

    expect(city).toBeLessThan(0.8 * speed(flowFrom(field, COOK_STRAIT, 340)));
    expect(speed(flowFrom(field, MAKARA, 340))).toBeGreaterThan(city * 1.2);
  });

  it("blows a southerly up the harbour", async () => {
    const [x, z] = flowFrom(await loadField(), HARBOUR, 180);

    // Northward is -z.
    expect(-z).toBeGreaterThan(0.8);
    expect(Math.abs(x)).toBeLessThan(0.2);
  });

  it("adds the eastward and southward flows in proportion to the wind", async () => {
    const field = await loadField();

    const at = (wx: number, wz: number) =>
      flowAt(field, rootSize, 1234, -5678, wx, wz);

    const [ex, ez] = at(1, 0);
    const [sx, sz] = at(0, 1);
    const [x, z] = at(7, -3);

    expect(x).toBeCloseTo(7 * ex - 3 * sx, 6);
    expect(z).toBeCloseTo(7 * ez - 3 * sz, 6);
  });

  it("says where there's land, blurred at the shore, for trails to rise over", async () => {
    const field = await loadField();

    const land = ([e, n]: [number, number]) => {
      const cell = rootSize / field.size;
      const i = Math.floor((e - origin[0] + rootSize / 2) / cell);
      const j = Math.floor((-(n - origin[1]) + rootSize / 2) / cell);

      return field.land[j * field.size + i];
    };

    expect(land(COOK_STRAIT)).toBe(0);
    expect(land(MAKARA)).toBe(255);
    // Just off Oriental Bay: part way.
    expect(land([1750100, 5427200])).toBeGreaterThan(20);
    expect(land([1750100, 5427200])).toBeLessThan(235);
  });

  it("needs the two solutions stacked, square over square", () => {
    expect(() => unpackField(new Uint8Array(4 * 4 * 4), 4, 4)).toThrow();
  });
});

describe("the ground lookup", () => {
  const index = new TileIndex({
    crs: "EPSG:2193",
    origin: [0, 0],
    rootSize: 1000,
    tileCells: 256,
    apron: 1,
    encoding: { offset: 0, scale: 1 },
    levels: [0, 1, 2].map((level) => ({
      level,
      resolution: 4,
      range: [0, 2 ** level, 0, 2 ** level],
      tiles: [],
    })),
  } satisfies TerrainManifest);

  const tile = (level: number, x: number, y: number) => ({
    level,
    x,
    y,
    minHeight: 0,
    maxHeight: 0,
  });

  /** A cell's entry: west and north edges, size and layer. */
  const entry = (lookup: GroundLookup, x: number, y: number) =>
    Array.from(
      // SAFETY: GroundLookup makes its texture over a Float32Array.
      (lookup.texture.image.data as Float32Array).subarray(
        (y * lookup.cells + x) * 4,
        (y * lookup.cells + x + 1) * 4
      )
    );

  it("points each cell at the finest tile the cache holds there", () => {
    const lookup = new GroundLookup(index);

    lookup.update({
      version: 1,
      // Out of order: the coarse tile mustn't paint over the fine one.
      loaded: () => [
        { tile: tile(2, 1, 2), slot: 7 },
        { tile: tile(0, 0, 0), slot: 3 },
      ],
    });

    expect(lookup.cells).toBe(4);
    expect(entry(lookup, 1, 2)).toEqual([-250, 0, 250, 7]);
    expect(entry(lookup, 0, 0)).toEqual([-500, -500, 1000, 3]);
    expect(entry(lookup, 3, 3)).toEqual([-500, -500, 1000, 3]);
  });

  it("repaints only when the cache has changed", () => {
    const lookup = new GroundLookup(index);

    const cache = {
      version: 1,
      loaded: () => [{ tile: tile(0, 0, 0), slot: 3 }],
    };

    lookup.update(cache);
    cache.loaded = () => [{ tile: tile(0, 0, 0), slot: 5 }];
    lookup.update(cache);
    expect(entry(lookup, 0, 0)[3]).toBe(3);

    cache.version = 2;
    lookup.update(cache);
    expect(entry(lookup, 0, 0)[3]).toBe(5);
  });
});
