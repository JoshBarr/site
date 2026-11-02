// @vitest-environment happy-dom
import { DirectionalLight, Sprite } from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";
import type { Aircraft } from "../../src/lib/flights";
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
      drawn("cars").length > 0
  );

  return scene;
}

function sun(drawn: (name: string) => unknown[]) {
  const [light] = drawn("sun");

  if (!(light instanceof DirectionalLight)) throw new Error("no sun");

  return light;
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
});
