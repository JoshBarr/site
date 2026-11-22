import { PerspectiveCamera, Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { pivotAt, pivotView, pointAt } from "../../src/components/scene/pivot";

// Holding a press on something to orbit around it: the point under the
// pointer, where the camera goes to orbit it, and the turn there.

const close = (a: Vector3, b: Vector3, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
};

describe("the point under a held press", () => {
  const camera = new PerspectiveCamera(50, 1.6, 1, 10000);
  camera.position.set(0, 100, 0);
  camera.lookAt(0, 0, -1000);

  it("is the depth along the view axis, in the middle of the view", () => {
    const point = pointAt(camera, 0, 0, 500);
    const axis = camera.getWorldDirection(new Vector3());

    close(point, axis.multiplyScalar(500).add(camera.position));
  });

  it("is that depth along the axis off to the side, not that distance away", () => {
    const point = pointAt(camera, 0.8, -0.5, 500);
    const axis = camera.getWorldDirection(new Vector3());

    expect(point.clone().sub(camera.position).dot(axis)).toBeCloseTo(500);
    expect(point.distanceTo(camera.position)).toBeGreaterThan(500);

    // And back where it was pressed.
    const seen = point.clone().project(camera);
    expect(seen.x).toBeCloseTo(0.8);
    expect(seen.y).toBeCloseTo(-0.5);
  });
});

describe("orbiting a picked point", () => {
  const from = new Vector3(0, 100, 0);

  it("leaves the camera where it is", () => {
    const point = new Vector3(300, 20, -400);
    const [p, t] = pivotView(from, point, 10, 14000);

    close(p, from);
    close(t, point);
  });

  it("steps back from something nearer than the orbit goes", () => {
    const point = new Vector3(0, 97, -2);
    const [p] = pivotView(from, point, 10, 14000);

    expect(p.distanceTo(point)).toBeCloseTo(10);
  });

  it("rises to look level at something above it, the orbit never looking up", () => {
    const point = new Vector3(0, 400, -2000);
    const [p] = pivotView(from, point, 10, 14000);

    expect(p.y).toBeCloseTo(400);
    expect(p.x).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
  });

  it("slides the map over, looking as it did, in map view", () => {
    const aim = new Vector3(0, 0, -1000);
    const point = new Vector3(500, 30, -1500);
    const [p, t] = pivotView(from, point, 0, Infinity, aim);

    close(t, point);
    close(p.clone().sub(t), from.clone().sub(aim));
  });

  it("turns from one view to the other, steadily", () => {
    const start: [Vector3, Vector3] = [from, new Vector3(0, 0, -2000)];
    const end: [Vector3, Vector3] = [from, new Vector3(100, 80, -50)];
    const out: [Vector3, Vector3] = [new Vector3(), new Vector3()];

    close(pivotAt(start, end, 0, out)[1], start[1], 3);
    close(pivotAt(start, end, 1, out)[1], end[1], 3);

    const look = (s: number) =>
      pivotAt(start, end, s, out)[1].clone().sub(out[0]).normalize();

    const whole = look(0).angleTo(look(1));
    expect(look(0).angleTo(look(0.5))).toBeCloseTo(whole / 2);

    // The target's distance halfway, by ratio: the middle of 2 km and ~120 m.
    const half = pivotAt(start, end, 0.5, out)[1].distanceTo(out[0]);
    const ends = [start, end].map(([p, t]) => p.distanceTo(t));
    expect(half).toBeCloseTo(Math.sqrt(ends[0] * ends[1]));
  });
});
