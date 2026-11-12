import { describe, expect, it } from "vitest";
import { Matrix4, PerspectiveCamera } from "three/webgpu";
import { slideOf } from "../../src/components/scene/clouds/temporal";

// How far the clouds' history takes the camera to have moved in a frame:
// still, it keeps cloud the march missed; moving, it doesn't.

/** The history's height, px. */
const HEIGHT = 450;

/** A camera 900 m up looking along -x, and where it was a frame ago. */
function view(fov = 50) {
  const camera = new PerspectiveCamera(fov, 16 / 10, 5, 80000);

  camera.position.set(0, 900, 0);
  camera.lookAt(-5000, 150, -300);
  camera.updateMatrixWorld();

  const wasWorld = new Matrix4().copy(camera.matrixWorld);
  const wasProjection = new Matrix4().copy(camera.projectionMatrix);

  return {
    camera,
    /** How far its view's slid, px, once it's been `changed`. */
    slid(change: (camera: PerspectiveCamera) => void) {
      change(camera);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      return slideOf(camera, wasWorld, wasProjection, HEIGHT);
    },
  };
}

/** Pixels to a degree at the middle of a view `fov`° tall. */
const perDegree = (fov = 50) =>
  ((HEIGHT / 2 / Math.tan((fov * Math.PI) / 360)) * Math.PI) / 180;

describe("slideOf", () => {
  it("is nothing for a camera that hasn't moved", () => {
    expect(view().slid(() => {})).toBeCloseTo(0, 6);
  });

  it("counts a turn in pixels at the middle of the view", () => {
    const slid = view().slid((camera) => camera.rotateY(Math.PI / 180));

    expect(slid).toBeCloseTo(perDegree(), 3);
  });

  it("counts a move as the nearest cloud would show it", () => {
    // A bus's frame at 15 m/s, then a dragged orbit's.
    const followed = view().slid((camera) => camera.translateX(0.25));
    const dragged = view().slid((camera) => camera.translateX(13));

    expect(followed).toBeLessThan(0.25);
    expect(dragged).toBeGreaterThan(5);
    expect(dragged / followed).toBeCloseTo(13 / 0.25, 3);
  });

  it("counts a zoom", () => {
    const slid = view().slid((camera) => {
      camera.fov = 49;
    });

    expect(slid).toBeGreaterThan(1);
  });

  it("is in the history's own pixels: more of them for a longer lens", () => {
    const wide = view(50).slid((camera) => camera.rotateY(0.001));
    const long = view(10).slid((camera) => camera.rotateY(0.001));

    expect(long / wide).toBeCloseTo(perDegree(10) / perDegree(50), 3);
  });
});
