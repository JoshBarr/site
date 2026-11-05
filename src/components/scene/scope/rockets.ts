import type { Builder } from "./craft";
import { ball, cone, tube } from "./shapes";
import type { Materials } from "./surface";

// Spent upper stages, over half the visual group: each a cylinder with a
// domed top and its adapter ring, foam bands, a thrust structure and its
// engine bell (and verniers, on the Soviet and Chinese ones). Sizes from
// published figures for each stage, rounded; the details are typical, not
// particular.

export interface Stage {
  length: number;
  diameter: number;
  /** The main bell's exit, m across, and how many bells. */
  nozzle: number;
  engines?: number;
  /** Small steering engines round the main one. */
  verniers?: number;
}

/** By name: which stage each rocket body is. */
const STAGES: [RegExp, Stage][] = [
  // Zenit-2's second stage.
  [/^SL-16/, { length: 10.4, diameter: 3.9, nozzle: 1.9, verniers: 4 }],
  // Tsyklon-3's third, short and squat.
  [/^SL-14/, { length: 2.7, diameter: 2.7, nozzle: 1 }],
  // Kosmos-3M's second.
  [/^SL-8/, { length: 6.5, diameter: 2.4, nozzle: 1.3, verniers: 4 }],
  // Vostok's Blok E.
  [/^SL-3/, { length: 3.1, diameter: 2.6, nozzle: 0.9 }],
  // Proton's Blok DM.
  [/^SL-12/, { length: 6.3, diameter: 3.7, nozzle: 1.2 }],
  // Soyuz and Molniya's Blok I.
  [/^SL-(4|6)/, { length: 6.7, diameter: 2.66, nozzle: 1, verniers: 4 }],
  [/^CZ-4/, { length: 5, diameter: 2.9, nozzle: 0.9, verniers: 2 }],
  [/^CZ-2C/, { length: 7.8, diameter: 3.35, nozzle: 1.6, verniers: 4 }],
  [/^CZ-2D/, { length: 10.9, diameter: 3.35, nozzle: 1.6, verniers: 4 }],
  [/^CZ-8/, { length: 12.4, diameter: 3, nozzle: 1.2, engines: 2 }],
  [/^H-2A/, { length: 9.2, diameter: 4, nozzle: 1.8 }],
  // Ariane 4's H10 third stage, and Ariane 5's upper.
  [/^ARIANE 4/, { length: 11.05, diameter: 2.6, nozzle: 1 }],
  [/^ARIANE 5/, { length: 4.7, diameter: 5.4, nozzle: 1 }],
  [/^DELTA 1/, { length: 6.4, diameter: 1.4, nozzle: 0.8 }],
  [/^DELTA 2/, { length: 6, diameter: 2.4, nozzle: 1 }],
  // Centaur.
  [/^ATLAS/, { length: 9.6, diameter: 3.05, nozzle: 1, engines: 2 }],
  // Agena.
  [/^THOR/, { length: 6.3, diameter: 1.5, nozzle: 0.9 }],
  [/^TITAN/, { length: 9, diameter: 4.3, nozzle: 1, engines: 2 }],
  [/^GSLV/, { length: 8.7, diameter: 2.8, nozzle: 1.2 }],
];

const TYPICAL: Stage = { length: 8, diameter: 2.8, nozzle: 1.2 };

export function stageFor(name: string): [string, Stage] {
  const found = STAGES.find(([pattern]) => pattern.test(name));

  return found ? [found[0].source, found[1]] : ["typical", TYPICAL];
}

/** How far across `stage` is, end to end, m. */
export const stageSpan = ({ length, diameter, nozzle }: Stage) =>
  Math.max(length + nozzle * 1.2, diameter);

/** A stage along x, its top forward, its engine aft. */
export function rocket(stage: Stage) {
  const { length: l, diameter, nozzle, engines = 1, verniers = 0 } = stage;
  const r = diameter / 2;

  return (m: Materials, { model }: Builder) => {
    // The tanks, banded; the domed top and the adapter ring on it.
    const top = l * 0.42;
    const tail = -l * 0.32;
    tube(model, m.body, r, top - tail, "x", [(top + tail) / 2, 0, 0]);
    tube(model, m.dark, r * 1.01, l * 0.1, "x", [top - l * 0.18, 0, 0]);
    tube(model, m.dark, r * 1.01, l * 0.06, "x", [tail + l * 0.12, 0, 0]);
    ball(model, m.body, r, [top, 0, 0]).scale.x = 0.35;
    cone(model, m.metal, r * 0.62, r * 0.48, 0.4, "x", [
      top + r * 0.35 + 0.1,
      0,
      0,
    ]);

    // The thrust structure, narrowing aft, and the bells under it.
    const skirt = l * 0.1;
    cone(model, m.foil, r * 0.6, r, skirt, "x", [tail - skirt / 2, 0, 0]);
    const aft = tail - skirt;
    const bell = (nozzle / engines) * 1.3;

    for (let i = 0; i < engines; i++) {
      const z = engines === 1 ? 0 : (i - (engines - 1) / 2) * r * 0.9;
      const exit = nozzle / Math.sqrt(engines) / 2;
      cone(
        model,
        m.metal,
        exit,
        exit * 0.3,
        bell,
        "x",
        [aft - bell / 2, 0, z],
        true
      );
    }

    for (let i = 0; i < verniers; i++) {
      const a = (i / verniers) * Math.PI * 2 + Math.PI / 4;
      const small = r * 0.12;
      cone(
        model,
        m.metal,
        small,
        small * 0.4,
        small * 3,
        "x",
        [aft - small * 1.5, Math.cos(a) * r * 0.75, Math.sin(a) * r * 0.75],
        true
      );
    }
  };
}
