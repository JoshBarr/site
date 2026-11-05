import type { Group } from "three/webgpu";
import type { Builder } from "./craft";
import { ball, box, cone, panel, tube } from "./shapes";
import type { Materials } from "./surface";

// The two stations, laid out from their published dimensions, near enough:
// x along the way they fly, y up away from the Earth, z across. Visiting
// ships and the modules' arrangement are as of 2025; which ports are taken
// changes month to month, so these are a guess at a typical day.

/** A Soyuz (or Progress), its docking end at `at`, pointing −`way` from it. */
function soyuz(
  m: Materials,
  group: Group,
  [x, y, z]: [number, number, number],
  axis: "x" | "y"
) {
  const out = (d: number): [number, number, number] =>
    axis === "x" ? [x - d, y, z] : [x, y - d, z];

  ball(group, m.white, 1.1, out(1.1));
  cone(group, m.dark, 1.1, 1.2, 2.1, axis, out(3.2));
  tube(group, m.white, 1.36, 2.6, axis, out(5.5));

  // Its two wings, out to either side.
  for (const side of [-1, 1]) {
    const [px, py, pz] = out(5.5);
    panel(group, m.cells, 4, 1.9, "z", [px, py, pz + side * (1.36 + 2.1)]);
  }
}

/**
 * The ISS: the US lab and nodes forward, the Russian segment aft, Kibo and
 * Columbus out to the sides, the truss over Destiny with its radiators and
 * eight wings (four pairs, turning together about the truss to the sun).
 */
export function iss(m: Materials, { model, arrays }: Builder) {
  // The pressurised modules along the way, forward to aft.
  tube(model, m.white, 2.2, 7.2, "x", [23.6, 0, 0]); // Harmony
  tube(model, m.white, 2.15, 8.5, "x", [15.7, 0, 0]); // Destiny
  tube(model, m.white, 2.3, 5.5, "x", [8.7, 0, 0]); // Unity
  tube(model, m.white, 2.05, 12.6, "x", [-0.7, 0, 0]); // Zarya
  tube(model, m.white, 1.45, 4, "x", [-9, 0, 0]); // Zvezda, forward
  tube(model, m.white, 2.08, 9, "x", [-15.5, 0, 0]); // Zvezda, aft
  soyuz(m, model, [-20, 0, 0], "x"); // Progress, aft of Zvezda

  // Zarya's and Zvezda's bands of foil.
  tube(model, m.foil, 2.1, 1.2, "x", [-4, 0, 0]);
  tube(model, m.foil, 2.12, 1.4, "x", [-12, 0, 0]);

  // Forward: the docking adapter and a Crew Dragon, nose in.
  cone(model, m.body, 1.1, 0.8, 1.9, "x", [28.2, 0, 0]);
  cone(model, m.white, 0.8, 2, 3, "x", [30.6, 0, 0]);
  tube(model, m.cells, 1.85, 3.7, "x", [33.9, 0, 0]);

  // Columbus starboard of Harmony, Kibo to port with its logistics module
  // on top and its exposed platform at the end.
  tube(model, m.white, 2.25, 6.9, "z", [23.6, 0, 5.7]);
  tube(model, m.white, 2.2, 11.2, "z", [23.6, 0, -7.8]);
  tube(model, m.white, 2.1, 4.2, "y", [23.6, 3.6, -7.5]);
  box(model, m.body, [5, 3.8, 5.6], [23.6, 0, -16.2]);

  // Tranquility to port of Unity, the Cupola under it, Leonardo forward.
  tube(model, m.white, 2.25, 6.7, "z", [8.7, 0, -5.6]);
  cone(model, m.foil, 1, 1.5, 1.5, "y", [8.7, -3, -5.6]);
  tube(model, m.white, 2.2, 6.6, "x", [15.3, 0, -5.6]);

  // Down from the Russian segment: Rassvet with a Soyuz, Nauka with
  // Prichal; Poisk up top.
  tube(model, m.white, 1.17, 6, "y", [0, -5, 0]);
  soyuz(m, model, [0, -8, 0], "y");
  tube(model, m.white, 2.12, 12, "y", [-11, -8.1, 0]);
  ball(model, m.white, 1.65, [-11, -15.7, 0]);
  tube(model, m.white, 1.28, 4, "y", [-9.5, 3.4, 0]);

  // Zvezda's own wings, turning about their mast.
  const zvezda = arrays(-15.5, 0, 0);

  for (const side of [-1, 1]) {
    panel(zvezda, m.cells, 11, 3.3, "z", [0, 0, side * (2.1 + 6)]);
  }

  // The truss, over Destiny: the middle stretch big, the outer ones less so,
  // with the rotary joints between.
  const [tx, ty] = [15.7, 4.6];
  box(model, m.truss, [3.8, 3.4, 46], [tx, ty, 0]);

  for (const side of [-1, 1]) {
    box(model, m.truss, [2.6, 2.6, 31.5], [tx, ty, side * 38.75]);
    tube(model, m.metal, 1.6, 0.8, "z", [tx, ty, side * 26]);

    // The main radiators off S1 and P1, three panels a side, laid aft.
    for (let i = 0; i < 3; i++) {
      panel(
        model,
        m.radiator,
        23,
        3.4,
        "x",
        [tx - 13.5, ty, side * (8 + i * 3.6)],
        0.15
      );
    }

    // And each pair of wings' smaller one, forward.
    panel(model, m.radiator, 13, 3.2, "x", [tx + 8.5, ty, side * 43], 0.12);
  }

  // Four pairs of wings, each 35 m by two blankets, out either side of
  // the truss, and turned to the sun about it.
  for (const z of [-51.5, -33, 33, 51.5]) {
    const g = arrays(tx, ty, z);
    box(g, m.truss, [3, 2.6, 4.5]);

    for (const way of [-1, 1]) {
      const x = way * (2.5 + 17.5);
      panel(g, m.cells, 34, 4.6, "x", [x, 0, -2.9]);
      panel(g, m.cells, 34, 4.6, "x", [x, 0, 2.9]);
      tube(g, m.metal, 0.12, 35, "x", [x, 0, 0]);
      box(g, m.foil, [0.5, 0.5, 10.6], [way * (2.5 + 35), 0, 0]);
    }
  }
}

/**
 * Tiangong's T: Tianhe along the way with its node forward, Wentian and
 * Mengtian across from the node, each with a pair of long wings at its far
 * end; a Tianzhou aft, a Shenzhou under the node.
 */
export function tiangong(m: Materials, { model, arrays }: Builder) {
  // Tianhe: the node, the small cabin, the large one, the resource section.
  ball(model, m.white, 1.45, [9.2, 0, 0]);
  tube(model, m.white, 1.4, 4, "x", [6.5, 0, 0]);
  cone(model, m.white, 2.1, 1.4, 1.2, "x", [3.9, 0, 0]);
  tube(model, m.white, 2.1, 6.8, "x", [-0.1, 0, 0]);
  tube(model, m.foil, 1.9, 3, "x", [-5, 0, 0]);

  // Tianzhou aft, its wings out across.
  tube(model, m.white, 1.68, 10.6, "x", [-12, 0, 0]);

  for (const side of [-1, 1]) {
    panel(model, m.cells, 5.6, 2.3, "z", [-14, 0, side * (1.7 + 2.9)]);
  }

  // Shenzhou under the node.
  soyuz(m, model, [9.2, -1.45, 0], "y");

  // Tianhe's own two wings.
  const tianhe = arrays(-1.5, 0, 0);

  for (const side of [-1, 1]) {
    panel(tianhe, m.cells, 12, 2.9, "z", [0, 0, side * (2.1 + 6.5)]);
  }

  // Wentian and Mengtian across, their wings at the far ends; a radiator on
  // each, and Mengtian's exposed platform under it.
  for (const side of [-1, 1]) {
    tube(model, m.white, 1.4, 5, "z", [9.2, 0, side * (1.45 + 2.5)]);
    tube(model, m.white, 2.1, 12.9, "z", [9.2, 0, side * 12.9]);
    panel(model, m.radiator, 6, 2.2, "z", [9.2, 2.6, side * 12], 0.1);

    const g = arrays(9.2, 0, side * 17.9);
    box(g, m.truss, [1.2, 1.2, 1.5]);

    for (const way of [-1, 1]) {
      const x = way * (1 + 13);
      panel(g, m.cells, 26, 4.4, "x", [x, 0, 0]);
      tube(g, m.metal, 0.1, 26.5, "x", [x, 0.12, 0]);
    }
  }

  box(model, m.dark, [3.5, 1.2, 6], [9.2, -2.6, 13]);
}
