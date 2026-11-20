import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  operatingPoint,
  shouldRun,
  SWT_2_3_82,
  windForOutput,
} from "../../src/components/scene/landmarks/turbineModels";
import {
  feeding,
  levelsOf,
  SUBSTATIONS,
} from "../../src/components/scene/power/feed";
import { carried, tried } from "../../src/components/scene/power/flow";
import {
  type Span,
  SPANS,
  type Structure,
  STRUCTURES,
} from "../../src/components/scene/power/grid";
import type { GridFlow } from "../../src/lib/gridFlow";
import { ago, NOW } from "../clock";

// What the grid's carrying, as the scene shows it: the HVDC link's pulses
// by its transfer, each line lit by its substations' load, and the wind
// farms' turbines turning by what they're sending out.

const flow = (parts: Partial<GridFlow> = {}): GridFlow => ({
  hvdc: null,
  northIsland: null,
  sites: null,
  ...parts,
});

/** A substation's level, by its code. */
const levelOf = (levels: number[], code: string) =>
  levels[SUBSTATIONS.findIndex((site) => site.code === code)];

describe("what the grid's carrying, as it's shown", () => {
  it("is nothing known until it's heard from", () => {
    expect(carried(null, NOW)).toEqual({
      link: null,
      levels: SUBSTATIONS.map(() => 1),
      farms: { westWind: null, millCreek: null },
    });
  });

  describe("the HVDC link", () => {
    it("heads north with a positive transfer, by how much of 1200 MW", () => {
      const sending = flow({ hvdc: { time: ago(1800), mw: 900 } });

      expect(carried(sending, NOW).link).toEqual({
        heading: 1,
        transfer: 0.75,
      });
    });

    it("heads south with a negative one", () => {
      const sending = flow({ hvdc: { time: ago(1800), mw: -300 } });

      expect(carried(sending, NOW).link).toEqual({
        heading: -1,
        transfer: 0.25,
      });
    });

    it("sends no more than it can", () => {
      const sending = flow({ hvdc: { time: ago(1800), mw: 1300 } });

      expect(carried(sending, NOW).link?.transfer).toBe(1);
    });

    it("isn't known once its transfer's two hours old", () => {
      const sending = flow({ hvdc: { time: ago(2 * 3600), mw: 900 } });

      expect(carried(sending, NOW).link).toBeNull();
    });

    it("is as ?hvdc says, whatever's known", () => {
      const sending = flow({ hvdc: { time: ago(1800), mw: 900 } });

      expect(carried(sending, NOW, tried("?hvdc=-600")).link).toEqual({
        heading: -1,
        transfer: 0.5,
      });

      expect(carried(null, NOW, tried("?hvdc=0")).link).toEqual({
        heading: 1,
        transfer: 0,
      });
    });
  });

  describe("each substation", () => {
    it("works as hard as the North Island does, with no load of its own known", () => {
      // Half way from a summer's night to a winter's peak.
      const loaded = flow({ northIsland: { time: ago(300), mw: 3200 } });

      expect(carried(loaded, NOW).levels).toEqual(SUBSTATIONS.map(() => 0.5));
    });

    it("works by its own load over its most, where that's known", () => {
      const { levels } = carried(
        flow({
          northIsland: { time: ago(300), mw: 3200 },
          sites: {
            time: ago(300),
            load: { CPK: 95, HAY: 60, WWD: 0 },
            generation: { WWD: 71.3 },
          },
        }),
        NOW
      );

      expect(levelOf(levels, "CPK")).toBe(0.5);
      // Over its most: brighter, but not without limit.
      expect(levelOf(levels, "HAY")).toBe(1.2);
      // The wind farm's by what it sends.
      expect(levelOf(levels, "WWD")).toBe(0.5);
      // Not dispatched: the island's.
      expect(levelOf(levels, "TKR")).toBe(0.5);
    });

    it("goes back to its most once everything known is stale", () => {
      const old = flow({
        northIsland: { time: ago(46 * 60), mw: 3200 },
        sites: { time: ago(46 * 60), load: { CPK: 95 }, generation: {} },
      });

      expect(carried(old, NOW).levels).toEqual(SUBSTATIONS.map(() => 1));
    });

    it("is as ?load says", () => {
      const loaded = flow({
        sites: { time: ago(300), load: { CPK: 95 }, generation: {} },
      });

      expect(carried(loaded, NOW, tried("?load=30")).levels).toEqual(
        SUBSTATIONS.map(() => 0.3)
      );
    });
  });

  describe("the wind farms", () => {
    const sites = {
      time: ago(300),
      load: { WIL: 31.5 },
      generation: { WWD: 71.3, WIL: 14.95 },
    };

    it("send what they're generating of what they can", () => {
      expect(carried(flow({ sites }), NOW).farms).toEqual({
        westWind: 0.5,
        millCreek: 0.25,
      });
    });

    it("aren't known without the substations' readings, or with old ones", () => {
      const unknown = { westWind: null, millCreek: null };

      expect(
        carried(flow({ northIsland: { time: ago(300), mw: 3200 } }), NOW).farms
      ).toEqual(unknown);

      expect(
        carried(flow({ sites: { ...sites, time: ago(46 * 60) } }), NOW).farms
      ).toEqual(unknown);
    });

    it("are as ?farms says", () => {
      expect(carried(null, NOW, tried("?farms=80")).farms).toEqual({
        westWind: 0.8,
        millCreek: 0.8,
      });
    });
  });

  it("takes nothing from a URL that says nothing of it", () => {
    expect(tried("?cloud=20&hvdc=")).toEqual({});
    expect(tried("?hvdc=lots")).toEqual({});
  });
});

describe("whose load a line's lit by", () => {
  // Two substations 10 km apart, with a line of towers between their
  // gantries, a spur off its middle, and a line off on its own.
  const at = (easting: number, northing = 0, type = "D"): Structure => [
    easting,
    northing,
    0,
    30,
    // SAFETY: only ever a structure's type.
    type as Structure[4],
    110,
  ];

  const structures: Structure[] = [
    at(0, 0, "X"),
    at(2500),
    at(5000),
    at(7500),
    at(10_000, 0, "X"),
    at(5000, 3000),
    at(50_000),
    at(50_300),
  ];

  const spans: Span[] = [
    [0, 1, 0.5, 0],
    [1, 2, 0.5, 0],
    [2, 3, 0.5, 0],
    [3, 4, 0.5, 0],
    [2, 5, 0.5, 0],
    [6, 7, 0.5, 0],
  ];

  const west = { easting: 0, northing: 0 };
  const east = { easting: 10_000, northing: 0 };
  const fed = feeding(structures, spans, [west, east]);
  const levels = levelsOf(fed, [0.2, 1]);

  it("is its own substation's, at its gantry", () => {
    expect(levels[0]).toBeCloseTo(0.2, 2);
    expect(levels[4]).toBeCloseTo(1, 2);
  });

  it("is more the nearer's on the way, and both alike midway", () => {
    expect(levels[1]).toBeGreaterThan(0.2);
    expect(levels[1]).toBeLessThan(0.3);
    expect(levels[2]).toBeCloseTo(0.6);
    expect(levels[3]).toBeGreaterThan(0.9);
  });

  it("is both alike up a spur off the middle", () => {
    expect(levels[5]).toBeCloseTo(0.6);
  });

  it("is every substation's alike on a line strung to none", () => {
    expect(levels[6]).toBeCloseTo(0.6);
    expect(levels[7]).toBeCloseTo(0.6);
  });

  it("adds up to all of each structure", () => {
    for (let i = 0; i < structures.length; i++) {
      expect(fed.shares[i * 2] + fed.shares[i * 2 + 1]).toBeCloseTo(1);
    }
  });

  describe("on the grid as built", () => {
    const grid = feeding(STRUCTURES, SPANS, SUBSTATIONS);

    /** The structure nearest an NZTM point, of those `wanted`. */
    const nearest = (
      [easting, northing]: [number, number],
      wanted: (structure: Structure) => boolean
    ) =>
      STRUCTURES.reduce(
        (best, structure, i) =>
          wanted(structure) &&
          Math.hypot(structure[0] - easting, structure[1] - northing) <
            Math.hypot(
              STRUCTURES[best][0] - easting,
              STRUCTURES[best][1] - northing
            )
            ? i
            : best,
        STRUCTURES.findIndex(wanted)
      );

    it("gives every substation gantries of its own", () => {
      SUBSTATIONS.forEach(({ easting, northing }, site) => {
        // Haywards' nearest is the link's own, which is no substation's.
        const gantry = nearest(
          [easting, northing],
          ([, , , , type, kv]) => type === "X" && kv < 350
        );

        expect(grid.shares[gantry * grid.sites + site]).toBeGreaterThan(0.9);
      });
    });

    it("sets the HVDC link apart: every 350 kV structure, and no other", () => {
      STRUCTURES.forEach(([, , , , , kv], i) => {
        expect(grid.link[i]).toBe(kv >= 350 ? 1 : 0);
      });

      expect(grid.link.reduce((sum, on) => sum + on, 0)).toBe(100);
    });

    it("lights West Wind's line by what the farm's sending", () => {
      const idle = SUBSTATIONS.map(({ sends }) => (sends ? 0 : 1));
      const lit = levelsOf(grid, idle);
      const westWind = SUBSTATIONS.find(({ sends }) => sends);

      const gantry = nearest(
        [westWind?.easting ?? 0, westWind?.northing ?? 0],
        ([, , , , type]) => type === "X"
      );

      expect(lit[gantry]).toBeLessThan(0.1);
    });
  });
});

describe("the link's pulses", () => {
  let grid: typeof import("../../src/components/scene/power/energise");

  beforeEach(async () => {
    vi.resetModules();
    grid = await import("../../src/components/scene/power/energise");
  });

  it("stand still until it's known what the link's sending", () => {
    grid.stepGrid(10);

    expect(grid.link.known.value).toBe(0);
    expect(grid.link.travel.value).toBe(0);
  });

  it("run toward Haywards sending north, and away sending south", () => {
    grid.setLink({ heading: 1, transfer: 0.75 });
    expect(grid.link.known.value).toBe(1);
    expect(grid.link.heading.value).toBe(1);

    grid.setLink({ heading: -1, transfer: 0.25 });
    expect(grid.link.heading.value).toBe(-1);
    expect(grid.link.transfer.value).toBe(0.25);
  });

  it("pass every 1.5 s at its most, and slower in proportion", () => {
    grid.setLink({ heading: 1, transfer: 1 });
    grid.stepGrid(0.75);
    expect(grid.link.travel.value).toBeCloseTo(0.5);

    // A whole pulse on is where it was.
    grid.stepGrid(1.5);
    expect(grid.link.travel.value).toBeCloseTo(0.5);

    grid.setLink({ heading: 1, transfer: 0.5 });
    grid.stepGrid(0.75);
    expect(grid.link.travel.value).toBeCloseTo(0.75);
  });

  it("stop where they are when it's sending nothing, or isn't known", () => {
    grid.setLink({ heading: 1, transfer: 1 });
    grid.stepGrid(0.3);
    grid.setLink({ heading: 1, transfer: 0 });
    grid.stepGrid(5);
    expect(grid.link.travel.value).toBeCloseTo(0.2);

    grid.setLink(null);
    grid.stepGrid(5);
    expect(grid.link.known.value).toBe(0);
    expect(grid.link.travel.value).toBeCloseTo(0.2);
  });

  it("run on whether or not the grid's lit", () => {
    grid.setLink({ heading: 1, transfer: 1 });
    grid.stepGrid(0.3);

    expect(grid.gridLit()).toBe(false);
    expect(grid.light.level.value).toBe(0);
    expect(grid.link.travel.value).toBeCloseTo(0.2);
  });
});

describe("a turbine sending a share of its power", () => {
  const model = SWT_2_3_82;

  /** Its steady rotor speed sending `share`, in an estimated 9 m/s. */
  const rpmSending = (share: number) => {
    const wind = windForOutput(model, share, 9);

    return operatingPoint(model, wind, shouldRun(model, wind, false)).rpm;
  };

  it("is parked sending nothing, however hard it's taken to be blowing", () => {
    const wind = windForOutput(model, 0, 20);

    expect(shouldRun(model, wind, true)).toBe(false);
    expect(operatingPoint(model, wind, false).rpm).toBeLessThan(1);
  });

  it("turns at its slowest generating a little, though the wind's taken to be calm", () => {
    const wind = windForOutput(model, 0.02, 1);

    expect(shouldRun(model, wind, false)).toBe(true);
    expect(operatingPoint(model, wind, true).rpm).toBeGreaterThanOrEqual(
      model.minRpm
    );

    expect(operatingPoint(model, wind, true).rpm).toBeLessThan(10);
  });

  it("turns faster the more it sends, up to its fastest", () => {
    const speeds = [0.02, 0.1, 0.25, 0.5, 0.75, 1].map(rpmSending);

    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]).toBeGreaterThanOrEqual(speeds[i - 1]);
    }

    expect(speeds[0]).toBeGreaterThanOrEqual(model.minRpm);
    expect(speeds.at(-1)).toBe(model.maxRpm);
  });

  it("is in the wind that'd give that power: the cube of it, cut-in to rated", () => {
    expect(windForOutput(model, 0.5, 9)).toBeCloseTo(
      Math.cbrt((model.cutIn ** 3 + model.rated ** 3) / 2)
    );
  });

  it("at full power, is in the wind there's taken to be: over rated, short of a storm", () => {
    expect(windForOutput(model, 1, 9)).toBe(model.rated);
    expect(windForOutput(model, 1, 18)).toBe(18);
    expect(windForOutput(model, 1, 40)).toBe(model.cutOut - 5);
    expect(shouldRun(model, windForOutput(model, 1, 40), false)).toBe(true);
  });
});
