// @vitest-environment happy-dom
import { CameraControlsImpl } from "@react-three/drei";
import { Vector3 } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderScene } from "./render";

/** How far in front of the camera the scene is, m, wherever it's read. */
const DEPTH = 1500;

const NOON = new Date("2026-01-15T12:00:00+13:00");

let scene: Awaited<ReturnType<typeof renderScene>> | undefined;

afterEach(async () => {
  await scene?.unmount();
  scene = undefined;
});

// It mounts the whole scene.
describe("holding a press on the map", { timeout: 30_000 }, () => {
  it("turns onto the point held, unless the press goes on to drag", async () => {
    scene = await renderScene(NOON);
    const { until, state } = scene;
    let n = 0;
    await until(() => ++n >= 5);

    const { controls: c, gl } = state();

    if (!(c instanceof CameraControlsImpl)) throw new Error("no controls");

    // Nothing's drawn without a GPU: read back ground everywhere at DEPTH
    // (each point's pixel is its depth, then three channels unread).
    vi.spyOn(gl, "readRenderTargetPixelsAsync").mockImplementation(
      async (_target, _x, _y, width) =>
        new Float32Array(width * 4).map((_, i) => (i % 4 ? 0 : DEPTH))
    );

    const element = gl.domElement;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 400, 800);
    const target = () => c.getTarget(new Vector3());

    const frames = async (count: number) => {
      let i = 0;
      await until(() => ++i >= count);
    };

    const pointer = (type: string, at: EventTarget, y: number) =>
      at.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: 200,
          clientY: y,
          bubbles: true,
        })
      );

    // Held still, below the middle: once the hold's up, the view turns
    // onto the ground there.
    const start = target();
    pointer("pointerdown", element, 600);
    await until(() => target().distanceTo(start) > 1);
    pointer("pointerup", document, 600);
    await frames(60);

    const held = target();
    expect(held.distanceTo(start)).toBeGreaterThan(100);

    // Held as long, then dragged while it's turning: a drag after all. The
    // view goes back, and the drag turns it about where it was aimed.
    const polar = c.polarAngle;
    pointer("pointerdown", element, 600);
    await until(() => target().distanceTo(held) > 1);

    for (let y = 590; y >= 500; y -= 10) {
      pointer("pointermove", document, y);
      await frames(1);
    }

    pointer("pointerup", document, 500);
    await frames(60);

    expect(target().distanceTo(held)).toBeLessThan(1);
    expect(Math.abs(c.polarAngle - polar)).toBeGreaterThan(0.01);
  });
});
