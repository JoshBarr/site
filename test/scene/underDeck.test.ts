import { Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  arcUnder,
  beneath,
  ceilingFor,
} from "../../src/components/scene/underDeck";

const polar = (camera: Vector3, target: Vector3) =>
  camera
    .clone()
    .sub(target)
    .angleTo(new Vector3(0, 1, 0));

describe("ceilingFor", () => {
  it("is the clear-sky height without a deck, else under the deck", () => {
    expect(ceilingFor(null, 4000)).toBe(4000);
    expect(ceilingFor(600, 4000)).toBe(500);
    expect(ceilingFor(6000, 4000)).toBe(4000);
  });
});

describe("beneath", () => {
  it("leaves a view under the ceiling as it is", () => {
    const camera = new Vector3(100, 400, 200);
    const target = new Vector3(0, 0, 0);

    expect(beneath(camera, target, 500, 10)).toBe(false);
    expect(camera.toArray()).toEqual([100, 400, 200]);
    expect(target.toArray()).toEqual([0, 0, 0]);
  });

  it("tips a view down about its target, the same distance off", () => {
    const target = new Vector3(1000, 0, 1000);

    // 3 km off, 66° from straight down, from the south.
    const angle = (66 * Math.PI) / 180;

    const camera = new Vector3(
      1000,
      3000 * Math.cos(angle),
      1000 + 3000 * Math.sin(angle)
    );

    expect(beneath(camera, target, 800, 10)).toBe(true);
    expect(camera.y).toBeCloseTo(800);
    expect(camera.distanceTo(target)).toBeCloseTo(3000);
    // Still from the south, looking north.
    expect(camera.x).toBeCloseTo(1000);
    expect(camera.z).toBeGreaterThan(target.z);
    expect(target.y).toBe(0);
  });

  it("comes in nearer rather than looking level", () => {
    const target = new Vector3(0, 0, 0);
    const camera = new Vector3(0, 3000, 3000);

    beneath(camera, target, 100, 10);

    expect(camera.y).toBeCloseTo(100);
    expect(camera.distanceTo(target)).toBeLessThan(600);
    expect(polar(camera, target)).toBeCloseTo((78 * Math.PI) / 180);
  });

  it("brings a target in the cloud down under it", () => {
    // Following an aircraft, looking level ahead at 3 km.
    const camera = new Vector3(0, 3000, 0);
    const target = new Vector3(0, 3000, -2000);

    beneath(camera, target, 800, 10);

    expect(target.y).toBe(790);
    expect(camera.y).toBe(800);
    // Looking the same way, more or less, but down.
    expect(camera.z).toBeGreaterThan(target.z);
  });

  it("looks north at a target straight below", () => {
    const camera = new Vector3(0, 3000, 0);
    const target = new Vector3(0, 0, 0);

    beneath(camera, target, 500, 10);

    expect(camera.y).toBe(500);
    expect(camera.x).toBeCloseTo(0);
    expect(camera.z).toBeGreaterThan(0);
  });
});

describe("arcUnder", () => {
  it("arcs no higher than the ceiling, nor lower than the way", () => {
    expect(arcUnder(200, 300, 4000)).toBe(500);
    expect(arcUnder(200, 1500, 800)).toBe(800);
    // Setting off from above it, the way's own height.
    expect(arcUnder(1200, 500, 800)).toBe(1200);
  });
});
