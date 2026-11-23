import { describe, expect, it } from "vitest";
import {
  createEquipmentGeometry,
  LIGHTHOUSE_HEIGHT,
} from "../../src/components/scene/playground/equipment";
import {
  BANDS,
  EQUIPMENT,
  EXTENT,
  groundAt,
  PATCHES,
  type Point,
} from "../../src/components/scene/playground/layout";
import { GROUND } from "../../src/components/scene/playground/site";
import { createSurfaceGeometry } from "../../src/components/scene/playground/surface";

const SCALE = 1.15;
const [WEST, SOUTH, EAST, NORTH] = EXTENT;

const inside = ([e, n]: Point) =>
  e >= WEST && e <= EAST && n >= SOUTH && n <= NORTH;

describe("the playground's ground", () => {
  const { step, west, south, columns, heights } = GROUND;

  it("reads the DEM's heights at its grid points", () => {
    expect(groundAt(west, south)).toBeCloseTo(heights[0]);
    expect(groundAt(west + 3 * step, south + 2 * step)).toBeCloseTo(
      heights[2 * columns + 3]
    );
  });

  it("blends between them", () => {
    const e = west + 4.5 * step;
    const n = south + 6 * step;
    const between = (heights[6 * columns + 4] + heights[6 * columns + 5]) / 2;

    expect(groundAt(e, n)).toBeCloseTo(between);
  });

  it("holds the edge value past the grid", () => {
    expect(groundAt(west - 50, south - 50)).toBeCloseTo(heights[0]);
  });

  it("covers the painted surface", () => {
    const rows = heights.length / columns;

    expect(heights.length % columns).toBe(0);
    expect(west).toBeLessThanOrEqual(WEST);
    expect(south).toBeLessThanOrEqual(SOUTH);
    expect(west + (columns - 1) * step).toBeGreaterThanOrEqual(EAST);
    expect(south + (rows - 1) * step).toBeGreaterThanOrEqual(NORTH);
  });
});

describe("the playground's layout", () => {
  it("paints inside its canvas", () => {
    for (const { outline } of PATCHES) expect(outline.every(inside)).toBe(true);

    for (const { line } of BANDS) expect(line.every(inside)).toBe(true);
  });

  it("clips paint only to the zones it lies in", () => {
    const zones = new Set(["blue", "deep"]);

    for (const { within } of [...PATCHES, ...BANDS]) {
      if (within !== undefined) expect(zones).toContain(PATCHES[within].paint);
    }
  });

  it("puts the equipment on the painted ground", () => {
    expect(inside(EQUIPMENT.lighthouse)).toBe(true);
    expect(inside(EQUIPMENT.carousel)).toBe(true);
    expect(inside(EQUIPMENT.waka.bow)).toBe(true);
    expect(inside(EQUIPMENT.waka.stern)).toBe(true);
    expect(EQUIPMENT.fishnet.every(({ at }) => inside(at))).toBe(true);
  });
});

describe("the playground's meshes", () => {
  it("lays the surface just over the ground the terrain draws", () => {
    const geometry = createSurfaceGeometry(SCALE);
    const position = geometry.getAttribute("position");
    const columns = EAST - WEST + 1;

    expect(position.count).toBe(columns * (NORTH - SOUTH + 1));
    // The vertex at the anchor: x east, z south.
    const i = -SOUTH * columns - WEST;

    expect(position.getX(i)).toBeCloseTo(0);
    expect(position.getZ(i)).toBeCloseTo(0);
    expect(position.getY(i) - groundAt(0, 0) * SCALE).toBeCloseTo(0.05);
  });

  it("builds the equipment in one tinted geometry, within the site", () => {
    const geometry = createEquipmentGeometry(SCALE);
    const position = geometry.getAttribute("position");

    expect(geometry.getAttribute("tint").count).toBe(position.count);
    expect(Array.from(position.array).every(Number.isFinite)).toBe(true);

    geometry.computeBoundingBox();
    const box = geometry.boundingBox;

    expect(box).not.toBeNull();
    // x east, z south of the anchor.
    expect(box?.min.x).toBeGreaterThanOrEqual(WEST);
    expect(box?.max.x).toBeLessThanOrEqual(EAST);
    expect(box?.min.z).toBeGreaterThanOrEqual(-NORTH);
    expect(box?.max.z).toBeLessThanOrEqual(-SOUTH);

    const highest = Math.max(...GROUND.heights) * SCALE;

    expect(box?.max.y).toBeLessThanOrEqual(highest + LIGHTHOUSE_HEIGHT);
  });
});
