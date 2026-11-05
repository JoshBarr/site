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
import { renderScene, shown } from "./render";

/** Midsummer in Wellington, NZDT. */
const NOON = new Date("2026-01-15T12:00:00+13:00");
const MIDNIGHT = new Date("2026-01-15T00:00:00+13:00");

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

let scene: Awaited<ReturnType<typeof renderScene>> | undefined;

afterEach(async () => {
  stop();
  setCut(false);
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
});
