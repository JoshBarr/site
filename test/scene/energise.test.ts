import { PerspectiveCamera } from "three/webgpu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacedTower } from "../../src/components/scene/power/network";

// Clicking a pylon lights the grid: which tower a click means, and how the
// light runs out from it and goes again. The module keeps what's lit, so
// each test has its own.

let grid: typeof import("../../src/components/scene/power/energise");

beforeEach(async () => {
  vi.resetModules();
  grid = await import("../../src/components/scene/power/energise");
});

/** A 110 kV double-circuit tower, its arms reaching 4.2 m either side. */
const tower = (x: number, z: number, height = 30): PlacedTower => ({
  kind: "double110",
  position: [x, 0, z],
  yaw: 0,
  height,
});

/** The view's height, px. */
const HEIGHT = 800;

/** Half-way up a 30 m tower, looking north: a square view, 50° top to bottom. */
function look() {
  const camera = new PerspectiveCamera(50, 1, 1, 100_000);
  camera.position.set(0, 15, 0);
  camera.lookAt(0, 15, -1000);
  camera.updateMatrixWorld();

  return camera;
}

/** Pixels across a metre one metre away, in that view. */
const SCALE = HEIGHT / 2 / Math.tan((50 * Math.PI) / 360);

/** Pixels right of (or above) the view's middle, as the view has them: -1..1. */
const px = (pixels: number) => pixels / (HEIGHT / 2);

/** The same for metres, `depth` m in front of the camera. */
const metres = (m: number, depth: number) => px((m / depth) * SCALE);

describe("the tower a click means", () => {
  it("is one within its own width of the click", () => {
    const near = tower(0, -200);
    grid.standTowers([near]);

    const [seen] = grid.towersAt(look(), 0, 0, HEIGHT);
    expect(seen.tower).toBe(near);
    expect(seen.depth).toBeCloseTo(200);
    expect(seen.x).toBeCloseTo(0);
    expect(seen.y).toBeCloseTo(0);
    // Arm tip to arm tip.
    expect(seen.length).toBeCloseTo(8.4);

    // Out by its arms, 3 m from its middle; and past them.
    expect(grid.towersAt(look(), metres(3, 200), 0, HEIGHT)).toHaveLength(1);
    expect(grid.towersAt(look(), metres(6, 200), 0, HEIGHT)).toHaveLength(0);
  });

  it("or within a few pixels, far off where it's thinner than that", () => {
    // Its arms reach under a pixel from 5 km.
    grid.standTowers([tower(0, -5000)]);

    expect(grid.towersAt(look(), px(8), 0, HEIGHT)).toHaveLength(1);
    expect(grid.towersAt(look(), px(14), 0, HEIGHT)).toHaveLength(0);
    // A finger's blunter.
    expect(grid.towersAt(look(), px(14), 0, HEIGHT, 24)).toHaveLength(1);
  });

  it("is sighted where its middle comes nearest the click", () => {
    grid.standTowers([tower(0, -200)]);

    // 10 m over the camera's height: 25 m up the tower.
    const [up] = grid.towersAt(look(), 0, metres(10, 200), HEIGHT);
    expect(up.y).toBeCloseTo(metres(10, 200));

    // Just over its top, which is 15 m over the camera's height.
    const [over] = grid.towersAt(look(), 0, metres(16, 200), HEIGHT);
    expect(over.y).toBeCloseTo(metres(15, 200));

    // Well over it.
    expect(grid.towersAt(look(), 0, metres(25, 200), HEIGHT)).toHaveLength(0);
  });

  it("comes before another further from the click", () => {
    const left = tower(-8, -400);
    const right = tower(4, -400);
    grid.standTowers([left, right]);

    const seen = grid.towersAt(look(), metres(1, 400), 0, HEIGHT);
    expect(seen.map((sighting) => sighting.tower)).toEqual([right]);

    const between = grid.towersAt(look(), metres(-3, 400), 0, HEIGHT, 40);
    expect(between.map((sighting) => sighting.tower)).toEqual([left, right]);
  });

  it("isn't one behind the camera, or lost in the haze", () => {
    grid.standTowers([tower(0, 200)]);
    expect(grid.towersAt(look(), 0, 0, HEIGHT)).toHaveLength(0);

    grid.standTowers([tower(0, -200)]);
    expect(
      grid.towersAt(look(), 0, 0, HEIGHT, undefined, () => false)
    ).toHaveLength(0);
  });

  it("isn't there once its layer's gone", () => {
    const gone = grid.standTowers([tower(0, -200)]);
    gone();

    expect(grid.towersAt(look(), 0, 0, HEIGHT)).toHaveLength(0);
  });
});

describe("the grid's light", () => {
  const clicked = tower(0, 0);
  const other = tower(3000, 0);
  // The furthest from the first: the light has 8 km to go, and its front
  // is 1.2 km deep.
  const furthest = tower(0, -8000);

  beforeEach(() => {
    grid.standTowers([clicked, other, furthest]);
  });

  it("runs out from the tower clicked, past the furthest in 1.6 s", () => {
    const { origin, front, level } = grid.light;

    grid.toggleGrid(clicked);
    expect(origin.value.toArray()).toEqual([0, 15, 0]);
    expect(front.value).toBe(0);

    grid.stepGrid(0.8);
    expect(front.value).toBeCloseTo(4600);
    expect(level.value).toBe(1);

    grid.stepGrid(0.8);
    expect(front.value).toBeCloseTo(9200);

    // And on out to sea, but not for ever.
    grid.stepGrid(3600);
    expect(front.value).toBe(200_000);
  });

  it("stays dark until a tower's clicked", () => {
    grid.stepGrid(10);

    expect(grid.light.level.value).toBe(0);
    expect(grid.light.front.value).toBe(0);
  });

  it("goes out when any tower's clicked again", () => {
    const { level } = grid.light;

    grid.toggleGrid(clicked);
    grid.stepGrid(2);
    grid.toggleGrid(other);
    grid.stepGrid(0.25);
    expect(level.value).toBeCloseTo(0.5);

    grid.stepGrid(1);
    expect(level.value).toBe(0);
  });

  it("comes back as it was, clicked before it's gone out", () => {
    const { origin, front, level } = grid.light;

    grid.toggleGrid(clicked);
    grid.stepGrid(2);
    grid.toggleGrid(other);
    grid.stepGrid(0.25);
    grid.toggleGrid(other);

    // Not from the tower clicked this time.
    expect(origin.value.x).toBe(0);
    expect(front.value).toBeGreaterThan(9200);

    grid.stepGrid(0.25);
    expect(level.value).toBeCloseTo(1);
  });

  it("starts from the tower clicked each time it's lit from dark", () => {
    const { origin, front } = grid.light;

    grid.toggleGrid(clicked);
    grid.stepGrid(2);
    grid.toggleGrid(clicked);
    grid.stepGrid(1);
    grid.toggleGrid(other);

    expect(origin.value.x).toBe(3000);
    expect(front.value).toBe(0);
  });
});
