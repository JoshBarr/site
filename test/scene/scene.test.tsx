// @vitest-environment happy-dom
import { CameraControlsImpl } from "@react-three/drei";
import { act } from "@react-three/test-renderer";
import {
  DirectionalLight,
  PerspectiveCamera,
  Sprite,
  Vector3,
} from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";
import type { Aircraft } from "../../src/lib/flights";
import {
  follow,
  getSnapshot,
  setCut,
  stop,
  subject,
} from "../../src/components/scene/follow/store";
import {
  getMapView,
  MAP_DISTANCE,
  MAP_POLAR_ANGLE,
  MAP_ZOOM,
  setMapView,
} from "../../src/components/scene/mapView";
import { renderScene, shown } from "./render";

/** Midsummer in Wellington, NZDT. */
const NOON = new Date("2026-01-15T12:00:00+13:00");
const MIDNIGHT = new Date("2026-01-15T00:00:00+13:00");

/** Under the test weather's cloud base, 900 m, as views are put. */
const UNDER_DECK = 800;

/**
 * An A320 cruising north over the harbour, above where landing lights go on,
 * for the last minute: planes are drawn half a minute behind.
 */
function cruising(): Aircraft {
  const now = Date.now();

  return {
    hex: "c81e2f",
    callsign: "ANZ123",
    registration: "ZK-OXB",
    type: "A320",
    category: "A3",
    route: null,
    fixes: [
      [1752500, 5420000, 5000, now - 60_000, 200, 0, 0],
      [1752500, 5432000, 5000, now, 200, 0, 0],
    ],
  };
}

/** A jet taxiing up Wellington's runway, at 8 m/s. */
function taxiing(): Aircraft {
  const now = Date.now();

  return {
    hex: "c81e30",
    callsign: "ANZ456",
    registration: "ZK-OXC",
    type: "A320",
    category: "A3",
    route: null,
    fixes: [
      [1751180, 5422800, null, now - 60_000, 8, 4, 0],
      [1751214, 5423280, null, now, 8, 4, 0],
    ],
  };
}

let scene: Awaited<ReturnType<typeof renderScene>> | undefined;

afterEach(async () => {
  stop();
  setCut(false);
  setMapView(false);
  await scene?.unmount();
  scene = undefined;
});

/** The scene, once its tiles and networks have loaded. */
async function settled(time: Date, aircraft: Aircraft[] = []) {
  scene = await renderScene(time, aircraft);
  const { drawn, until } = scene;

  await until(
    () =>
      // In view of the camera, not just loaded.
      drawn("buildings")[0]?.children.some(shown) &&
      drawn("trees")[0]?.children.length > 0 &&
      drawn("trains").length > 0 &&
      drawn("buses").length > 0 &&
      drawn("cars").length > 0
  );

  return scene;
}

function sun(drawn: (name: string) => unknown[]) {
  const [light] = drawn("sun");

  if (!(light instanceof DirectionalLight)) throw new Error("no sun");

  return light;
}

/** Runs `frames` frames of the scene. */
async function frames(count: number) {
  let n = 0;
  await scene!.until(() => ++n >= count);
}

/** From the followed vehicle, where it's drawn now, to the camera. */
function offset(camera: PerspectiveCamera) {
  return camera.position
    .clone()
    .sub(new Vector3(subject.x, subject.y, subject.z));
}

/** How many lights a light sprite draws. */
function lit(drawn: (name: string) => unknown[], name: string) {
  const [sprite] = drawn(name);

  if (!(sprite instanceof Sprite)) throw new Error(`no ${name}`);

  return shown(sprite) ? sprite.count : 0;
}

// Each mounts the whole scene and waits for its tiles.
describe("the scene", { timeout: 30_000 }, () => {
  it("draws every layer", async () => {
    const { scene: root, drawn } = await settled(NOON);

    for (const name of [
      "sun",
      "terrain",
      "ocean",
      "buildings",
      "trees",
      "container yard",
      "obstruction lights",
      "airfield lights",
      "roads",
      "cars",
      "headlights",
      "tail lights",
      "railway track",
      "trains",
      "buses",
      "ships",
      "jets",
      "turboprops",
      "helicopters",
    ]) {
      expect(drawn(name), name).not.toHaveLength(0);
    }

    // West Wind, Mill Creek and Brooklyn's turbines; Kaukau and Mt Victoria.
    expect(drawn("wind turbines")).toHaveLength(2);
    expect(drawn("lattice tower")).toHaveLength(2);
    expect(drawn("container crane")).toHaveLength(2);
    expect(drawn("lighthouse")).toHaveLength(4);

    // The sky and the haze over everything.
    expect(root).toMatchObject({
      backgroundNode: expect.anything(),
      fogNode: expect.anything(),
    });

    // Near the camera, over Te Aro, the road and rail are laid.
    await scene!.until(
      () =>
        drawn("roads")[0].children.length > 0 &&
        drawn("railway track")[0].children.length > 0
    );
  });

  it("keeps the lights off by day", async () => {
    const { drawn } = await settled(NOON);

    expect(sun(drawn).intensity).toBeGreaterThan(1);
    expect(drawn("airfield lights").filter(shown)).toHaveLength(0);
    expect(drawn("obstruction lights").filter(shown)).toHaveLength(0);
    expect(drawn("lighthouse light").filter(shown)).toHaveLength(0);
    expect(drawn("window lights").filter(shown)).toHaveLength(0);
  });

  it("lights up at night", async () => {
    const { drawn, until } = await settled(MIDNIGHT);
    await until(() => drawn("window lights").some(shown));

    // Moonlight.
    expect(sun(drawn).intensity).toBeLessThan(0.5);
    expect(drawn("airfield lights").filter(shown)).toHaveLength(1);
    expect(drawn("obstruction lights").filter(shown)).toHaveLength(1);
    // Pencarrow's upper light is long out of use.
    expect(drawn("lighthouse light").filter(shown)).toHaveLength(3);
  });

  it("flies with only its strobes by day, all its lights at night", async () => {
    const day = await renderScene(NOON, [cruising()]);
    await day.until(() => lit(day.drawn, "aircraft lights") > 0);
    const strobes = lit(day.drawn, "aircraft lights");
    await day.unmount();

    scene = await renderScene(MIDNIGHT, [cruising()]);
    const { drawn, until } = scene;
    await until(() => lit(drawn, "aircraft lights") > 0);

    expect(strobes).toBe(2);
    expect(lit(drawn, "aircraft lights")).toBeGreaterThan(strobes);
  });

  it("looks around a followed plane by hand, then lets go", async () => {
    scene = await renderScene(NOON, [cruising()]);
    const { state } = scene;
    await scene.until(() => getSnapshot().counts.plane > 0);

    setCut(true);
    await act(async () => follow("plane"));
    await frames(30);

    const { camera, controls: c, gl } = state();

    if (!(camera instanceof PerspectiveCamera)) throw new Error("no camera");

    if (!(c instanceof CameraControlsImpl)) throw new Error("no controls");

    const shot = offset(camera).length();

    // The rig has the camera, not the hand.
    expect(c.enabled).toBe(false);
    expect(shot).toBeLessThan(300);

    // A click on the map (shutting a panel, say) isn't a hand on the
    // camera: the rig keeps it.
    const press = (type: string, target: EventTarget) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        })
      );

    press("pointerdown", gl.domElement);
    press("pointerup", window);
    await frames(30);

    expect(c.enabled).toBe(false);
    expect(offset(camera).length()).toBeCloseTo(shot, -1);

    // Zooming out keeps following it, and leaves the camera there.
    gl.domElement.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true })
    );
    await frames(120);

    expect(getSnapshot().following?.category).toBe("plane");
    expect(c.enabled).toBe(true);
    // It can be looked up at from below.
    expect(c.maxPolarAngle).toBeGreaterThan(Math.PI / 2);
    const zoomed = offset(camera);
    expect(zoomed.length()).toBeGreaterThan(shot * 1.2);

    // Carried along with it, at 200 m/s, still where the hand left it.
    await frames(60);
    expect(offset(camera).distanceTo(zoomed)).toBeLessThan(5);

    // Esc hands the camera back to the orbit.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await frames(2);

    expect(getSnapshot().following).toBeNull();
    expect(c.enabled).toBe(true);
    expect(c.maxPolarAngle).toBe(Math.PI / 2);
    // Down from its cruise, under the cloud.
    expect(camera.position.y).toBeLessThan(UNDER_DECK + 0.01);
    expect(c.getTarget(new Vector3()).y).toBeLessThan(camera.position.y);
  });

  it("hands back from a shot on the ground stepped back far enough to turn", async () => {
    scene = await renderScene(NOON, [taxiing()]);
    await scene.until(() => getSnapshot().counts.plane > 0);

    setCut(true);
    await act(async () => follow("plane"));
    await frames(30);

    const { camera, controls: c } = scene.state();

    if (!(camera instanceof PerspectiveCamera)) throw new Error("no camera");

    if (!(c instanceof CameraControlsImpl)) throw new Error("no controls");
    const looking = camera.getWorldDirection(new Vector3());

    // The rig's shot is close in, a couple of lengths off.
    expect(offset(camera).length()).toBeLessThan(300);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await frames(2);

    // Orbiting the ground it looked at, from far enough off to turn about
    // it rather than spin on the spot, looking the same way.
    const target = c.getTarget(new Vector3());

    expect(getSnapshot().following).toBeNull();
    expect(target.distanceTo(camera.position)).toBeGreaterThan(599);
    expect(
      target.clone().sub(camera.position).normalize().dot(looking)
    ).toBeGreaterThan(0.99);
  });

  it("turns less for a finger's drag than the mouse's", async () => {
    scene = await renderScene(NOON);
    await frames(5);
    const { controls: c, gl } = scene.state();

    if (!(c instanceof CameraControlsImpl)) throw new Error("no controls");
    const element = gl.domElement;
    element.getBoundingClientRect = () => new DOMRect(0, 0, 400, 800);

    const drag = async (pointerType: string) => {
      const before = c.azimuthAngle;

      const pointer = (type: string, target: EventTarget, clientX: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 1,
            pointerType,
            isPrimary: true,
            button: 0,
            buttons: 1,
            clientX,
            clientY: 400,
            bubbles: true,
          })
        );

      pointer("pointerdown", element, 100);

      for (let x = 110; x <= 200; x += 10) {
        pointer("pointermove", document, x);
        await frames(1);
      }

      pointer("pointerup", document, 200);
      await frames(60);

      return Math.abs(c.azimuthAngle - before);
    };

    const mouse = await drag("mouse");
    const finger = await drag("touch");

    // A hundred pixels of a view 800 high: an eighth of a turn by mouse.
    expect(mouse).toBeCloseTo(Math.PI / 4, 1);
    expect(finger / mouse).toBeCloseTo(0.4, 1);
  });

  it("walks the way it faces from the keyboard, and turns", async () => {
    scene = await renderScene(NOON);
    await frames(5);
    const { camera } = scene.state();

    const key = (type: string, code: string, target: EventTarget = window) =>
      target.dispatchEvent(
        new KeyboardEvent(type, { code, bubbles: true, cancelable: true })
      );

    /** Which way it's facing across the ground, and how far it's turned left. */
    const facing = () =>
      camera.getWorldDirection(new Vector3()).setY(0).normalize();

    const heading = () => Math.atan2(-facing().x, -facing().z);

    // Forward, along the ground.
    const ahead = facing();
    let from = camera.position.clone();
    key("keydown", "KeyW");
    await frames(30);
    key("keyup", "KeyW");
    await frames(30);
    const forward = camera.position.clone().sub(from).setY(0);

    expect(forward.length()).toBeGreaterThan(100);
    expect(forward.normalize().dot(ahead)).toBeGreaterThan(0.99);

    // Right, with the arrow.
    from = camera.position.clone();
    key("keydown", "ArrowRight");
    await frames(30);
    key("keyup", "ArrowRight");
    await frames(30);
    const right = camera.position.clone().sub(from).setY(0).normalize();

    expect(right.dot(new Vector3(-ahead.z, 0, ahead.x))).toBeGreaterThan(0.99);

    // Q turns left.
    const before = heading();
    key("keydown", "KeyQ");
    await frames(30);
    key("keyup", "KeyQ");
    await frames(60);

    expect(heading() - before).toBeGreaterThan(0.2);

    // Not while typing.
    const input = document.createElement("input");
    document.body.append(input);
    from = camera.position.clone();
    key("keydown", "KeyW", input);
    await frames(30);
    key("keyup", "KeyW", input);
    input.remove();

    expect(camera.position.distanceTo(from)).toBeLessThan(1e-6);
  });

  it("goes up to the map view and back, panned by the mouse at the edge", async () => {
    scene = await renderScene(NOON);
    await frames(5);
    const { camera, controls: c, gl } = scene.state();

    if (!(c instanceof CameraControlsImpl)) throw new Error("no controls");
    const { ACTION } = CameraControlsImpl;
    const element = gl.domElement;

    // happy-dom lays nothing out: the map's 1000 × 600, for the scene's own
    // handlers and the controls' zoom to the mouse alike.
    element.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600);

    // It re-renders the scene, without its clouds.
    const key = (code: string) =>
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            code,
            bubbles: true,
            cancelable: true,
          })
        );
      });

    const mouse = (type: string, clientX: number, clientY: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerType: "mouse",
          clientX,
          clientY,
          bubbles: true,
        })
      );

    setCut(true);
    await key("KeyM");
    await frames(5);

    // High over the ground it was looking at, facing north, at the map's
    // angle, and every drag pans.
    const target = c.getTarget(new Vector3());

    expect(getMapView()).toBe(true);
    expect(camera.position.x - target.x).toBeCloseTo(0, 0);
    expect(camera.position.z).toBeGreaterThan(target.z);
    expect(c.polarAngle).toBeCloseTo(MAP_POLAR_ANGLE, 2);
    expect(c.distance).toBeCloseTo(MAP_DISTANCE, -1);
    expect(c.mouseButtons.left).toBe(ACTION.TRUCK);

    // The mouse at the right edge pans east, and says so.
    mouse("pointermove", 999, 300);
    await frames(30);
    const moved = c.getTarget(new Vector3()).sub(target);

    expect(element.style.cursor).toBe("e-resize");
    expect(moved.x).toBeGreaterThan(100);
    expect(Math.abs(moved.z)).toBeLessThan(moved.x * 0.05);
    expect(c.polarAngle).toBeCloseTo(MAP_POLAR_ANGLE, 2);

    // Off the map, it stops (but for the controls' smoothing).
    mouse("pointerleave", 1200, 300);
    await frames(30);
    const stopped = c.getTarget(new Vector3());
    await frames(30);

    expect(c.getTarget(new Vector3()).distanceTo(stopped)).toBeLessThan(5);

    // Zooming in close, toward the mouse, at the same angle.
    for (let i = 0; i < 12; i++) {
      const wheel = new WheelEvent("wheel", {
        deltaY: -2000,
        bubbles: true,
        cancelable: true,
      });

      // happy-dom's wheel events have no position.
      Object.defineProperties(wheel, {
        clientX: { value: 700 },
        clientY: { value: 300 },
      });

      element.dispatchEvent(wheel);
      await frames(1);
    }

    await frames(20);
    const zoomed = c.getTarget(new Vector3());

    expect(c.distance).toBeLessThan(MAP_ZOOM[0] * 1.1);
    expect(c.polarAngle).toBeCloseTo(MAP_POLAR_ANGLE, 2);
    // Toward the right of the view: east.
    expect(zoomed.x).toBeGreaterThan(stopped.x + 100);

    // Again, and it's back down to orbiting.
    await key("KeyM");
    await frames(5);

    expect(getMapView()).toBe(false);
    // Under the cloud the map view hid.
    expect(camera.position.y).toBeLessThan(UNDER_DECK + 0.01);
    expect(c.mouseButtons.left).toBe(ACTION.ROTATE);
    expect(c.maxDistance).toBe(14000);
  });
});
