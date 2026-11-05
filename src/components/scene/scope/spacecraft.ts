import { Group } from "three/webgpu";
import type { Builder } from "./craft";
import { ball, box, cone, dish, panel, tube } from "./shapes";
import type { Materials } from "./surface";

// Satellites other than the stations: Hubble, AST SpaceMobile's BlueBirds
// (nine of the passes), the Soviet-built Cosmos family and their kin, and
// anything else as a bus with wings, varied by name. Sizes from published
// figures where there are any; the Cosmos and the rest are typical shapes.

/** Hubble: the tube with its door open, two wings, two antennas on booms. */
export function hubble(m: Materials, { model, arrays }: Builder) {
  tube(model, m.foil, 2.1, 6, "x", [-3.6, 0, 0]);
  tube(model, m.foil, 1.55, 7.2, "x", [3, 0, 0]);
  tube(model, m.dark, 2.12, 0.3, "x", [-0.6, 0, 0]);
  tube(model, m.dark, 1.5, 0.05, "x", [6.62, 0, 0]);
  // The aperture door, open, flat out forward from the top.
  box(model, m.foil, [3, 0.08, 3], [8.1, 1.55, 0]);

  for (const side of [-1, 1]) {
    tube(model, m.metal, 0.05, 4.4, "y", [-1.5, side * 4.3, 0]);
    dish(model, m.white, 0.65, 0.3, "x", [-1.4, side * 6.5, 0]);
  }

  const g = arrays(0.5, 0, 0);

  for (const side of [-1, 1]) {
    tube(g, m.metal, 0.06, 1.8, "z", [0, 0, side * 2.6]);
    panel(g, m.cells, 7.6, 2.45, "x", [0, 0, side * 3.8]);
  }
}

/**
 * A BlueBird: a flat phased array `size` metres square facing the Earth,
 * solar cells on its back, a small bus on top. The first five are 8 m
 * across; the second block 15 m.
 */
export function bluebird(size: number) {
  return (m: Materials, { model }: Builder) => {
    box(model, m.body, [size, 0.15, size], [0, -0.1, 0]);
    box(model, m.cells, [size * 0.98, 0.1, size * 0.98], [0, 0.05, 0]);
    box(model, m.foil, [1.2, 1, 1.2], [0, 0.6, 0]);
  };
}

/**
 * A Cosmos of the kind in the visual group (Tselina, Okean and the like): a
 * tall cylinder with cells round it and petal panels out from its foot, a
 * gravity-gradient boom up and whip antennas. Built about its middle.
 */
export function cosmos(m: Materials, { model }: Builder) {
  const craft = new Group();
  craft.position.y = -3.5;
  model.add(craft);

  tube(craft, m.body, 0.95, 4.5, "y");
  tube(craft, m.cells, 0.97, 2.4, "y", [0, -0.8, 0]);
  cone(craft, m.body, 0.95, 0.6, 0.8, "y", [0, 2.65, 0]);
  tube(craft, m.metal, 0.05, 6, "y", [0, 6.05, 0]);
  ball(craft, m.body, 0.25, [0, 9.2, 0]);

  for (let k = 0; k < 6; k++) {
    const petal = new Group();
    petal.rotation.y = (k * Math.PI) / 3;
    craft.add(petal);
    box(petal, m.cells, [0.05, 2.4, 1], [1.55, -2.2, 0]).rotation.z = 0.5;
  }

  for (const [x, z] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ]) {
    tube(craft, m.metal, 0.03, 3, x ? "x" : "z", [x * 2.4, 2.2, z * 2.4]);
  }
}

/** A number 0..1 from `name` and `k`: the same each time. */
function pick(name: string, k: number) {
  let h = 2166136261 ^ k;

  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  }

  return ((h >>> 0) % 10007) / 10007;
}

/** How far across `satellite(name)` is, m. */
export function satelliteSpan(name: string) {
  const across = 1.8 + pick(name, 3);
  const long = 5 + 4 * pick(name, 5);

  return 2 * (across / 2 + 0.8 + long);
}

/**
 * Anything else: a foil-wrapped bus, an instrument deck and a sensor
 * looking down, a dish, and one wing or two on yokes, sized by its name.
 */
export function satellite(name: string) {
  return (m: Materials, { model, arrays }: Builder) => {
    const bus: [number, number, number] = [
      2 + 2 * pick(name, 1),
      1.8 + pick(name, 2),
      1.8 + pick(name, 3),
    ];

    box(model, m.foil, bus);
    box(
      model,
      m.dark,
      [bus[0] * 0.9, 0.3, bus[2] * 0.9],
      [0, -bus[1] / 2 - 0.15, 0]
    );
    tube(model, m.metal, 0.4, 0.8, "y", [bus[0] * 0.25, -bus[1] / 2 - 0.6, 0]);
    box(
      model,
      m.radiator,
      [bus[0] * 0.8, bus[1] * 0.7, 0.05],
      [0, 0, bus[2] / 2 + 0.03]
    );

    const antenna = dish(model, m.white, 0.7, 0.25, "y", [
      -bus[0] * 0.3,
      -bus[1] / 2 - 0.5,
      0,
    ]);

    antenna.rotation.x = Math.PI;

    const long = 5 + 4 * pick(name, 5);
    const wide = 2 + pick(name, 6);
    const sides = pick(name, 4) < 0.5 ? [1] : [-1, 1];
    const g = arrays(0, 0, 0);

    for (const side of sides) {
      const from = bus[2] / 2;
      tube(g, m.metal, 0.06, 0.8, "z", [0, 0, side * (from + 0.4)]);
      panel(g, m.cells, long, wide, "z", [
        0,
        0,
        side * (from + 0.8 + long / 2),
      ]);
    }
  };
}
