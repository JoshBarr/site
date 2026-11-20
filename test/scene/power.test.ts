import { describe, expect, it } from "vitest";
import {
  CABLES,
  type Span,
  SPANS,
  type Structure,
  STRUCTURES,
} from "../../src/components/scene/power/grid";
import { layOut, WIRE_STRIDE } from "../../src/components/scene/power/network";
import {
  drawnHeight,
  gantryHeight,
  kindOf,
  SPECS,
} from "../../src/components/scene/power/towers";

// Towers turned to their lines and the wires strung between them. Here the
// world is the map: x east, z south, so a line of towers running north goes
// toward -z; the ground's flat and at 0 unless a test says otherwise.

const place = (
  easting: number,
  northing: number,
  ground: number
): [number, number, number] => [easting, ground, -northing];

/** A span with flat ground under it. */
const span = (a: number, b: number): Span => [a, b, 0.5, -10];

interface Wire {
  from: [number, number, number];
  to: [number, number, number];
  sag: number;
  gauge: number;
}

/** The wires strung, less the noise of their 32-bit floats. */
function wiresOf(structures: Structure[], spans: Span[], scale = 1): Wire[] {
  const { wires } = layOut(structures, spans, place, scale);

  return Array.from({ length: wires.length / WIRE_STRIDE }, (_, i) => {
    const [ax, ay, az, bx, by, bz, sag, gauge] = Array.from(
      wires.subarray(i * WIRE_STRIDE, (i + 1) * WIRE_STRIDE),
      (value) => Math.round(value * 1e4) / 1e4 + 0
    );

    return { from: [ax, ay, az], to: [bx, by, bz], sag, gauge };
  });
}

const DOUBLE = SPECS.double110;
const EARTH_GAUGE = 0.055;

/** Three 110 kV double-circuit towers, 30 m tall, 300 m apart, running north. */
const LINE: Structure[] = [
  [0, 0, 0, 30, "D", 110],
  [0, 300, 0, 30, "D", 110],
  [0, 600, 0, 30, "D", 110],
];

describe("which shape a structure takes", () => {
  it("goes by Transpower's type and the line's voltage", () => {
    expect(kindOf("D", 110)).toBe("double110");
    expect(kindOf("D", 33)).toBe("double110");
    expect(kindOf("D", 220)).toBe("double220");
    expect(kindOf("T", 110)).toBe("double110");
    expect(kindOf("D", 350)).toBe("hvdc");
    expect(kindOf("S", 220)).toBe("single220");
    expect(kindOf("S", 110)).toBe("single110");
    expect(kindOf("DP", 110)).toBe("poleDouble");
    expect(kindOf("SP", 33)).toBe("poleSingle");
    expect(kindOf("PI", 110)).toBe("piPole");
    expect(kindOf("X", 220)).toBe("gantry");
  });

  it("keeps a body under a tower the lidar found shorter than its head", () => {
    expect(drawnHeight(DOUBLE, 30)).toBe(30);
    expect(drawnHeight(DOUBLE, 12)).toBe(DOUBLE.head + DOUBLE.minBody);
  });
});

describe("towers on a line", () => {
  it("face along it", () => {
    const { towers } = layOut(LINE, [span(0, 1), span(1, 2)], place, 1);

    for (const tower of towers) {
      // Its z runs north or south: along -z or +z of the world.
      expect(Math.abs(Math.sin(tower.yaw))).toBeCloseTo(0);
      expect(tower.kind).toBe("double110");
      expect(tower.height).toBe(30);
    }
  });

  it("square up to the angle the line turns through", () => {
    // North to the middle tower, then east.
    const bend: Structure[] = [
      [0, 0, 0, 30, "D", 110],
      [0, 300, 0, 30, "D", 110],
      [300, 300, 0, 30, "D", 110],
    ];

    const { towers } = layOut(bend, [span(0, 1), span(1, 2)], place, 1);

    // Halfway between north and east, either way round.
    expect(Math.abs(Math.tan(towers[1].yaw))).toBeCloseTo(1);
  });

  it("stand on the ground as it's drawn", () => {
    const hill: Structure[] = [[0, 0, 100, 30, "D", 110]];

    expect(layOut(hill, [], place, 1.15).towers[0].position).toEqual([
      0, 100, -0,
    ]);
  });
});

describe("the wires of a span", () => {
  it("are a circuit down each side and an earth wire over the top", () => {
    const wires = wiresOf(LINE, [span(0, 1), span(1, 2)]);

    // Two spans of six conductors and an earth wire.
    expect(wires).toHaveLength(14);

    const first = wires.slice(0, 7);
    const conductors = first.filter((wire) => wire.gauge === DOUBLE.gauge);
    const earth = first.filter((wire) => wire.gauge === EARTH_GAUGE);
    expect(conductors).toHaveLength(6);
    expect(earth).toHaveLength(1);

    // From the first tower to the second.
    for (const wire of first) {
      expect(wire.from[2]).toBeCloseTo(0);
      expect(wire.to[2]).toBeCloseTo(-300);
    }

    // The earth wire peak to peak, the conductors under the arms' tips.
    expect(earth[0].from).toEqual([0, 30, 0]);

    expect(
      conductors.map((wire) => [wire.from[0], wire.from[1]]).sort()
    ).toEqual(
      DOUBLE.arms
        .map((arm) => [arm.x, 30 - arm.below - DOUBLE.insulator])
        .sort()
    );
  });

  it("stay on their own side from tower to tower", () => {
    for (const wire of wiresOf(LINE, [span(0, 1), span(1, 2)])) {
      expect(wire.to[0]).toBeCloseTo(wire.from[0]);
      expect(wire.to[1]).toBeCloseTo(wire.from[1]);
    }
  });

  it("stay on their own side whichever way the span is listed", () => {
    for (const wire of wiresOf(LINE, [span(1, 0), span(2, 1)])) {
      expect(wire.to[0]).toBeCloseTo(wire.from[0]);
    }
  });

  it("sag with the square of the span, the earth wire less", () => {
    const [conductor] = wiresOf(LINE, [span(0, 1)]);
    const earth = wiresOf(LINE, [span(0, 1)]).at(-1);

    expect(conductor.sag).toBeCloseTo(300 * 300 * 7e-5);
    expect(earth?.sag).toBeCloseTo(300 * 300 * 7e-5 * 0.75);
  });

  it("are strung tighter across a long span", () => {
    const far: Structure[] = [
      [0, 0, 0, 30, "D", 110],
      [0, 1200, 0, 30, "D", 110],
    ];

    // Across a valley 200 m deep.
    expect(wiresOf(far, [[0, 1, 0.5, -200]])[0].sag).toBeCloseTo(1200 * 0.04);
  });

  it("sag no lower than clears the ground", () => {
    // The ground rises 6 m over the line between the towers' feet, at
    // mid-span: under the lowest conductors, 18.3 m up.
    const [wire] = wiresOf(LINE, [[0, 1, 0.5, 6]]);
    const lowest = 30 - 10.2 - DOUBLE.insulator;

    expect(wire.sag).toBeCloseTo(lowest - 6 - 6.5);
    expect(wire.sag).toBeLessThan(300 * 300 * 7e-5);
  });

  it("allow for the ground being drawn higher than it is", () => {
    const flat = wiresOf(LINE, [[0, 1, 0.5, 6]])[0].sag;
    const scaled = wiresOf(LINE, [[0, 1, 0.5, 6]], 1.5)[0].sag;

    expect(scaled).toBeCloseTo(flat - 3);
  });

  it("still hang a little where the ground is too near", () => {
    expect(wiresOf(LINE, [[0, 1, 0.5, 40]])[0].sag).toBeCloseTo(300 * 0.006);
  });
});

describe("where kinds of tower meet", () => {
  it("strings one circuit from a double tower to a single", () => {
    const mixed: Structure[] = [
      [0, 0, 0, 30, "D", 110],
      [0, 300, 0, 24, "S", 110],
    ];

    const wires = wiresOf(mixed, [span(0, 1)]);

    // Three conductors and the earth wire.
    expect(wires).toHaveLength(4);

    // All from the one side of the double tower.
    const sides = new Set(
      wires.slice(0, 3).map((wire) => Math.sign(wire.from[0]))
    );

    expect(sides.size).toBe(1);
  });

  it("strings the HVDC link as a pole either side and an earth wire", () => {
    const link: Structure[] = [
      [0, 0, 0, 34, "D", 350],
      [0, 400, 0, 34, "D", 350],
    ];

    const wires = wiresOf(link, [span(0, 1)]);

    expect(wires).toHaveLength(3);
    expect(
      wires
        .slice(0, 2)
        .map((wire) => wire.from[0])
        .sort()
    ).toEqual([-8.5, 8.5]);
    expect(wires[0].gauge).toBe(SPECS.hvdc.gauge);
  });

  it("lands every conductor side by side on a gantry, and no earth wire", () => {
    const landing: Structure[] = [
      [0, 0, 0, 30, "D", 110],
      [0, 100, 0, 0, "X", 110],
    ];

    const { towers } = layOut(landing, [span(0, 1)], place, 1);
    const wires = wiresOf(landing, [span(0, 1)]);

    expect(towers[1].kind).toBe("gantry");
    expect(towers[1].height).toBe(gantryHeight(110));
    expect(wires).toHaveLength(6);

    const along = wires.map((wire) => wire.to[0]).sort((a, b) => a - b);

    // On the beam, apart, and within its reach.
    for (const wire of wires) {
      expect(wire.to[1]).toBeCloseTo(gantryHeight(110) - 0.5);
      expect(wire.to[2]).toBeCloseTo(-100);
    }

    for (let i = 1; i < along.length; i++) {
      expect(along[i] - along[i - 1]).toBeGreaterThan(2);
    }

    expect(Math.max(...along.map(Math.abs))).toBeLessThan(8.6);

    // A circuit from the tower's left lands on the gantry's left.
    for (const wire of wires) {
      expect(Math.sign(wire.to[0])).toBe(Math.sign(wire.from[0]));
    }
  });

  it("deals a tower's circuits out between two gantries", () => {
    const fan: Structure[] = [
      [0, 0, 0, 30, "D", 110],
      [0, 300, 0, 30, "D", 110],
      [-40, 400, 0, 0, "X", 110],
      [40, 400, 0, 0, "X", 110],
    ];

    const wires = wiresOf(fan, [span(0, 1), span(1, 2), span(1, 3)]);
    const west = wires.filter((wire) => wire.to[0] < -20);
    const east = wires.filter((wire) => wire.to[0] > 20);

    expect(west).toHaveLength(3);
    expect(east).toHaveLength(3);
    // Each gantry takes the circuit on its own side of the tower.
    expect(west.every((wire) => wire.from[0] < 0)).toBe(true);
    expect(east.every((wire) => wire.from[0] > 0)).toBe(true);
  });
});

describe("Transpower's grid around Wellington", () => {
  const network = layOut(STRUCTURES, SPANS, place, 1.15);

  it("stands every structure and strings every span", () => {
    expect(network.towers).toHaveLength(STRUCTURES.length);
    expect(network.wires.length % WIRE_STRIDE).toBe(0);
    expect(network.wires.every(Number.isFinite)).toBe(true);

    // The data's joined up: no span left without a wire.
    const strung = wiresOf(STRUCTURES, SPANS, 1.15).length;
    expect(strung).toBeGreaterThan(SPANS.length * 3);
  });

  it("has every span between two different structures that exist", () => {
    for (const [a, b, at] of SPANS) {
      expect(a).not.toBe(b);
      expect(STRUCTURES[a]).toBeDefined();
      expect(STRUCTURES[b]).toBeDefined();
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(1);
    }
  });

  it("has a measured height for all but the terminations", () => {
    for (const [, , ground, height, type] of STRUCTURES) {
      expect(ground).toBeGreaterThanOrEqual(0);

      if (type === "X") {
        expect(height).toBe(0);
      } else {
        expect(height).toBeGreaterThan(8);
        expect(height).toBeLessThan(75);
      }
    }
  });

  it("brings three cables ashore at Oteranga Bay from the west", () => {
    expect(CABLES).toHaveLength(3);

    for (const cable of CABLES) {
      const [shore] = cable;
      const out = cable[cable.length - 1];

      expect(shore[0]).toBeGreaterThan(1736000);
      expect(shore[2]).toBeGreaterThan(-5);
      expect(out[0]).toBeLessThan(shore[0] - 15000);
      expect(out[2]).toBeLessThan(-50);
    }
  });
});
