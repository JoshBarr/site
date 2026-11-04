import { beforeEach, describe, expect, it, vi } from "vitest";
import { keepToKerb } from "../../src/components/scene/buses/run";
import { Roads } from "../../src/components/scene/traffic/roads";
import { RoadUser, Traffic } from "../../src/components/scene/traffic/sim";
import { TileIndex } from "../../src/components/scene/terrain/manifest";

const ORIGIN: [number, number] = [1740000, 5430000];

const index = new TileIndex({
  crs: "EPSG:2193",
  origin: ORIGIN,
  rootSize: 1,
  tileCells: 1,
  apron: 0,
  encoding: { offset: 0, scale: 1 },
  levels: [{ level: 0, resolution: 1, range: [0, 1, 0, 1], tiles: [] }],
});

/** A town street 2 km long running east, a lane each way, at 50. */
function street() {
  const points: number[] = [];

  for (let x = 0; x <= 2000; x += 50) points.push(ORIGIN[0] + x, ORIGIN[1], 0);

  return new Roads(
    {
      flags: { tunnel: 1, bridge: 2, twoWay: 4 },
      junction: { joins: 1, leaves: 2 },
      links: [],
      legs: [],
      carriageways: {
        EAST: {
          road: "SH1",
          points,
          spans: [[0, 1, 2, 4, 50]],
          junctions: [],
          links: [],
          legs: [],
        },
      },
    },
    index
  );
}

/** Busy: a weekday morning peak. */
const PEAK = new Date("2026-11-03T19:30:00Z");

const LENGTH = 12.5;
const GAP = 2;

/** A bus heading east in the kerb lane (left of the line, so north, -z). */
function bus(x: number, speed = 0, held = 0): RoadUser {
  return {
    id: "bus",
    x,
    y: 0.25,
    z: -1.6,
    dx: 1,
    dz: 0,
    length: LENGTH,
    width: 2.5,
    speed,
    held,
  };
}

/**
 * Mulberry32 from `seed`: the same cars every run. Traffic's filled at
 * random, and about one fill in a hundred puts no car beside the bus to be
 * held up, which failed deploys.
 */
function seeded(seed: number) {
  let a = seed;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(seeded(1));
});

function traffic() {
  const sim = new Traffic(street(), index, 2000);
  sim.setConditions(null, 25, PEAK);

  return sim;
}

describe("traffic sharing the road with buses", () => {
  it("finds the carriageway a bus is going along, and not the other way", () => {
    const roads = street();
    const at = { carriageway: -1, s: 0, lateral: 0, i: 0 };

    expect(roads.find(510, 0.25, -1.6, 1, 0, at)).toBe(true);
    expect(at.s).toBeCloseTo(510);
    expect(at.lateral).toBeCloseTo(-1.6);
    expect(roads.find(510, 0.25, -1.6, -1, 0, at)).toBe(false);
    // Well off the road, or on a bridge over it.
    expect(roads.find(510, 0.25, -30, 1, 0, at)).toBe(false);
    expect(roads.find(510, 12, -1.6, 1, 0, at)).toBe(false);
  });

  it("says how far over the kerb lane's middle is, on the road", () => {
    const roads = street();

    // Half a metre left of the line; the lane's middle is 1.6 m left.
    expect(roads.toKerb(510, 0.25, -0.5, 1, 0)).toBeCloseTo(-1.1);
    expect(roads.toKerb(510, 0.25, -40, 1, 0)).toBeNaN();
  });

  it("moves a bus's run into the kerb lane on the road, easing over", () => {
    // From 200 m short of the street's start, half a metre left of its line.
    const xs = Array.from({ length: 161 }, (_, i) => -200 + i * 5);

    const { points } = keepToKerb(
      { points: xs.map((x) => [x, 0.25, -0.5]), s: xs.map((x) => x + 200) },
      street()
    );

    const at = (x: number) => points[xs.indexOf(x)][2];

    expect(at(-200)).toBeCloseTo(-0.5);
    expect(at(400)).toBeCloseTo(-1.6);
    // Over once it's on, no faster than a metre in 15.
    expect(at(-5)).toBeCloseTo(-0.5);
    expect(at(10)).toBeCloseTo(-0.5 - 15 / 15);
  });

  it("holds a bus back behind the car ahead of it", () => {
    const sim = traffic();
    const [flow] = sim.flows;
    const car = flow.cars.find((c) => c.lane === 0 && c.s > 400 && c.s < 1600)!;
    // The bus's front 1 m short of the car's back.
    const middle = car.s - car.length - 1 - LENGTH / 2;

    expect(sim.share(bus(middle), GAP)).toBeCloseTo(GAP - 1);
  });

  it("keeps cars out of a moving bus, holding it up a while", () => {
    const sim = traffic();
    const [flow] = sim.flows;
    const dt = 1 / 60;
    let middle = 300;
    let hold = 0;
    let front = -Infinity;
    let worst = 0;
    let most = 0;

    for (let frame = 0; frame < 60 * 30; frame++) {
      sim.step(dt);

      // Once traffic's had a step to deal with where the bus was.
      for (const car of flow.cars) {
        if (car.lane !== 0 || car.leaving) continue;

        const into =
          Math.min(car.s, front) - Math.max(car.s - car.length, front - LENGTH);

        worst = Math.max(worst, into);
      }

      // As the buses layer does: on at its run's pace, less the hold.
      hold = Math.max(hold - 3 * dt, 0);
      middle += 12 * dt;
      hold += sim.share(bus(middle - hold, 12, hold), GAP);
      front = middle - hold + LENGTH / 2;
      most = Math.max(most, hold);
    }

    // Never more than a step's travel into it before it's dealt with.
    expect(worst).toBeLessThan(0.5);
    // Traffic made way, but not all at once.
    expect(front).toBeGreaterThan(300 + 12 * 30 * 0.5);
    expect(most).toBeGreaterThan(GAP * 2);
  });

  it("queues traffic behind a bus that's stopped", () => {
    const sim = traffic();
    const [flow] = sim.flows;
    const middle = 1200;

    for (let frame = 0; frame < 60 * 40; frame++) {
      sim.share(bus(middle), GAP);
      sim.step(1 / 60);
    }

    const back = middle - LENGTH / 2;

    const behind = flow.cars
      .filter((c) => c.lane === 0 && !c.leaving && c.s < back + 1)
      .sort((a, b) => b.s - a.s);

    expect(back - behind[0].s).toBeGreaterThan(0);
    expect(back - behind[0].s).toBeLessThan(5);
    expect(behind[0].v).toBeLessThan(0.5);
  });
});

describe("traffic when the scene's clock jumps", () => {
  /** The small hours, the night after PEAK's morning. */
  const NIGHT = new Date("2026-11-03T15:00:00Z");

  it("fills the roads afresh for the new time, not settling slowly", () => {
    const sim = new Traffic(street(), index, 2000);
    sim.setConditions(null, null, PEAK);
    const busy = sim.count;

    sim.setConditions(null, null, NIGHT);
    expect(sim.count).toBe(busy);

    sim.refill();
    sim.setConditions(null, null, NIGHT);
    expect(busy).toBeGreaterThan(40);
    expect(sim.count).toBeLessThan(busy / 10);
  });
});

describe("traffic on a public holiday", () => {
  it("is as quiet as a weekend's at the morning peak", () => {
    const working = new Traffic(street(), index, 2000);
    working.setConditions(null, null, PEAK);

    const holiday = new Traffic(street(), index, 2000);
    holiday.setConditions(null, null, PEAK, new Set(["2026-11-04"]));

    expect(holiday.count).toBeLessThan(working.count / 2);
  });
});
