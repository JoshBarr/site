import { describe, expect, it } from "vitest";
import {
  FlockSim,
  TRAIL_POINTS,
  WARM,
} from "../../src/components/scene/birds/boids";
import {
  daylight,
  type Flock,
  hashed,
  flocksOf,
  HABITS,
  isAbout,
  patchAt,
  type Plan,
  planAt,
  restingAt,
} from "../../src/components/scene/birds/habits";
import { flockName, plural } from "../../src/components/scene/birds/names";
import {
  decodeTrees,
  PerchGrid,
  TREE_STRIDE,
} from "../../src/components/scene/birds/perches";
import { crownTop, shaderHash } from "../../src/components/scene/trees/crown";
import { TreeIndex } from "../../src/components/scene/trees/manifest";
import { roofAbove, roofsOf } from "../../src/components/scene/birds/roofs";
import type { BuildingsManifest } from "../../src/components/scene/buildings/manifest";
import type { BirdsResponse } from "../../src/pages/api/birds";

// The scene's birds: which flocks the summary makes, when they're up and
// where they go, and how their birds fly.

const DAY = 86_400_000;
const NOON = Date.parse("2026-11-23T23:00:00Z");
const HIGH_SUN = 60;
const NIGHT = -20;

const site = (
  kind: BirdsResponse["sites"][number]["kind"],
  size: number,
  weight = 2
): BirdsResponse["sites"][number] => ({
  kind,
  species: ["kelgul"],
  position: [1747100, 5421304],
  radius: 200,
  size,
  peak: size,
  weight,
  seen: 4,
  last: NOON,
});

const SUMMARY: Pick<BirdsResponse, "sites" | "species"> = {
  sites: [site("gull", 110), site("shearwater", 400), site("ground", 5)],
  species: {
    kelgul: { name: "Kelp Gull", sci: "Larus dominicanus", kind: "gull" },
  },
};

/** World x, z: east, and south. */
const toWorld = (e: number, n: number): [number, number] => [
  e - 1747000,
  -(n - 5421000),
];

const [GULLS, SHEARWATERS] = flocksOf(SUMMARY, toWorld);

const fresh = (): Plan => ({ flying: false, since: 0, x: 0, z: 0, heading: 0 });

/** The sea, everywhere. */
const SEA = () => 0;

/**
 * A tree at x, z whose crown, `radius` m, tops out at `top`: as a PerchGrid
 * keeps it, its top lobe over its trunk and most of the crown across.
 */
const tree = (x: number, top: number, z: number, radius: number) => [
  x,
  top,
  z,
  radius,
  0,
  0,
  radius * 0.6,
  0.5,
];

/**
 * Trees on ground at 50 m: every 12 m across a square `side` m wide about
 * x, z, 10 m tall, crowns 3 m across.
 */
function grove(x: number, z: number, side = 240) {
  const trees: number[] = [];

  for (let dx = -side / 2; dx <= side / 2; dx += 12) {
    for (let dz = -side / 2; dz <= side / 2; dz += 12) {
      trees.push(...tree(x + dx, 60, z + dz, 1.5));
    }
  }

  return new PerchGrid(new Float32Array(trees));
}

/**
 * Whether a bird at `at` is sitting on one of `grid`'s crowns: on the top
 * of its top lobe, not over it or down in it.
 */
function onACrown(grid: PerchGrid, at: ArrayLike<number>) {
  const near = grid.nearest(at[0], at[2], 24);
  const i = near < 0 ? grid.closest(at[0], at[2]) : near;
  const { x, top, z, lobe } = grid.tree(i);

  return (
    Math.hypot(at[0] - x, at[2] - z) <= lobe * 0.7 &&
    at[1] > top - lobe * 0.3 &&
    at[1] < top + lobe * 0.15 + 0.05
  );
}

describe("the flocks the summary makes", () => {
  it("are one a site of a kind that flies, as many as usually are, up to the kind's most", () => {
    expect(flocksOf(SUMMARY, toWorld)).toEqual([
      expect.objectContaining({
        kind: "gull",
        name: "Kelp Gull",
        label: "Karoro",
        birds: 110,
        x: 100,
        z: -304,
      }),
      expect.objectContaining({
        kind: "shearwater",
        birds: HABITS.shearwater?.most,
      }),
    ]);
  });

  it("are named in te reo Māori, where the birds have a name in it", () => {
    expect(flockName("Tui")).toBe("Tūī");
    expect(flockName("New Zealand Kaka")).toBe("Kākā");
    expect(flockName("New Zealand Pigeon")).toBe("Kererū");
    expect(flockName("Silver Gull")).toBe("Tarāpunga");
    expect(flockName("House Sparrow")).toBe("House Sparrows");
  });

  it("are otherwise named in the plural", () => {
    expect(plural("Kelp Gull")).toBe("Kelp Gulls");
    expect(plural("Common Chaffinch")).toBe("Common Chaffinches");
    expect(plural("Grey Gerygone")).toBe("Grey Gerygones");
    expect(plural("New Zealand Kaka")).toBe("New Zealand Kakas");
    expect(plural("Australasian Darter")).toBe("Australasian Darters");
  });

  it("are about every day when seen most visits, and some days when seldom", () => {
    const rare = flocksOf(
      { ...SUMMARY, sites: [site("gull", 5, 0.1)] },
      toWorld
    )[0];

    const days = Array.from({ length: 200 }, (_, d) => NOON + d * DAY);

    expect(days.every((t) => isAbout(GULLS, t))).toBe(true);

    const about = days.filter((t) => isAbout(rare, t)).length;

    expect(about).toBeGreaterThan(10);
    expect(about).toBeLessThan(60);
  });
});

describe("what a flock's doing", () => {
  it("is settled at night", () => {
    for (let h = 0; h < 48; h++) {
      expect(planAt(GULLS, NOON + h * 1_800_000, NIGHT).flying).toBe(false);
    }
  });

  it("is up for about its kind's share of the day, in spells", () => {
    const habit = HABITS.gull!;
    const spells = 2000;
    let up = 0;

    for (let b = 0; b < spells; b++) {
      up += Number(
        planAt(GULLS, NOON + b * habit.bout * 1000, HIGH_SUN).flying
      );
    }

    expect(up / spells).toBeCloseTo(habit.airborne, 1);
  });

  it("is the same each time it's asked", () => {
    expect(planAt(GULLS, NOON + 12_345, HIGH_SUN)).toEqual(
      planAt(GULLS, NOON + 12_345, HIGH_SUN)
    );
  });

  it("settles at its own spot near the site, the same every time", () => {
    const a = restingAt(GULLS, fresh());
    const b = restingAt(GULLS, fresh());

    expect(a).toEqual(b);
    expect(Math.hypot(a.x - GULLS.x, a.z - GULLS.z)).toBeLessThanOrEqual(100);
  });

  it("flies a loop about its site at about its cruising speed", () => {
    const up = findFlying(GULLS);
    const habit = HABITS.gull!;
    const a = planAt(GULLS, up, HIGH_SUN, fresh());
    const b = planAt(GULLS, up + 1000, HIGH_SUN, fresh());
    const speed = Math.hypot(b.x - a.x, b.z - a.z);

    expect(speed).toBeGreaterThan(habit.speed * 0.2);
    expect(speed).toBeLessThan(habit.speed * 1.5);
    expect(Math.hypot(a.x - GULLS.x, a.z - GULLS.z)).toBeLessThanOrEqual(
      habit.roam * 1.01
    );
  });

  it("is a dusk murmuration, for starlings", () => {
    const [starlings] = flocksOf(
      { ...SUMMARY, sites: [site("starling", 40)] },
      toWorld
    );

    expect(planAt(starlings, NOON, 0).flying).toBe(true);
    expect(daylight(0)).toBe(0.5);
  });
});

/** A time the flock's up, at noon or after. */
function findFlying(flock: Flock) {
  for (let t = NOON; ; t += 60_000) {
    if (planAt(flock, t, HIGH_SUN).flying) return t;
  }
}

describe("a flock's birds", () => {
  it("fly about their goal, never into the sea", () => {
    const up = findFlying(GULLS);
    const plan = planAt(GULLS, up, HIGH_SUN, fresh());
    const sim = new FlockSim(GULLS, plan, SEA);

    for (let f = 1; f <= 600; f++) {
      const t = up + f * 50;
      planAt(GULLS, t, HIGH_SUN, plan);
      sim.step(0.05, plan, SEA, t / 1000);
    }

    expect(sim.down()).toBe(0);

    for (let i = 0; i < sim.n; i++) {
      expect(sim.position[i * 3 + 1]).toBeGreaterThanOrEqual(0.3);
    }

    expect(
      Math.hypot(sim.middle.x - plan.x, sim.middle.z - plan.z)
    ).toBeLessThan(150);
  });

  it("take off one after another, and land and sit at their spots", () => {
    const sim = new FlockSim(GULLS, restingAt(GULLS, fresh()), SEA);
    const up = { ...restingAt(GULLS, fresh()), flying: true, since: 1 };

    expect(sim.down()).toBe(sim.n);

    sim.step(0.05, up, SEA, 0);

    // A second up: a dozen or so, at 0.08 s apart.
    expect(sim.down()).toBeLessThan(sim.n - 5);
    expect(sim.down()).toBeGreaterThan(sim.n / 2);

    const down = restingAt(GULLS, fresh());

    for (let f = 0; f < 2400; f++) sim.step(0.05, down, SEA, f * 0.05);

    expect(sim.down()).toBe(sim.n);
  });

  it("fold their wings when down, and beat them in the air", () => {
    const resting = new FlockSim(
      SHEARWATERS,
      restingAt(SHEARWATERS, fresh()),
      SEA
    );

    expect(resting.wing[0]).toBeLessThan(-1);
    expect(resting.hand[0]).toBe(0);

    const up = findFlying(SHEARWATERS);
    const plan = planAt(SHEARWATERS, up, HIGH_SUN, fresh());
    const flying = new FlockSim(SHEARWATERS, plan, SEA);
    const angles = new Set<number>();
    const bends = new Set<number>();

    for (let f = 0; f < 40; f++) {
      flying.step(0.02, plan, SEA, f * 0.02);
      angles.add(Math.round(flying.wing[0] * 10));
      bends.add(Math.round(flying.hand[0] * 10));
    }

    expect(angles.size).toBeGreaterThan(3);
    // The hand bent from the arm as it goes, not held straight out.
    expect(bends.size).toBeGreaterThan(3);
    expect(Math.min(...bends)).toBeLessThan(-3);
  });

  it("each fly their own way in the air, in with the flock but keeping no place in it", () => {
    const up = findFlying(SHEARWATERS);
    const plan = planAt(SHEARWATERS, up, HIGH_SUN, fresh());
    const sim = new FlockSim(SHEARWATERS, plan, SEA);
    const habit = HABITS.shearwater!;

    const fly = (from: number, seconds: number) => {
      for (let f = 1; f <= seconds * 20; f++) {
        const t = up + from * 1000 + f * 50;
        planAt(SHEARWATERS, t, HIGH_SUN, plan);
        sim.step(0.05, plan, SEA, t / 1000);
      }
    };

    fly(0, 30);

    // Headings a few degrees either side of the flock's, speeds a little
    // either side of the kind's: not all the same, not all over the place.
    const mean = sim.mean();
    const way = Math.atan2(mean.x, mean.z);
    const off: number[] = [];
    const speeds: number[] = [];

    for (let i = 0; i < sim.n; i++) {
      const [x, , z] = sim.velocity.subarray(i * 3, i * 3 + 3);
      let turn = Math.atan2(x, z) - way;
      turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
      off.push((turn * 180) / Math.PI);
      speeds.push(Math.hypot(x, z));
    }

    const spread = (of: number[]) => {
      const middle = of.reduce((a, b) => a + b, 0) / of.length;

      return Math.sqrt(
        of.reduce((a, b) => a + (b - middle) ** 2, 0) / of.length
      );
    };

    expect(spread(off)).toBeGreaterThan(2);
    expect(spread(off)).toBeLessThan(25);
    expect(spread(speeds)).toBeGreaterThan(0.2);
    expect(Math.min(...speeds)).toBeGreaterThan(habit.speed * 0.6);
    expect(Math.max(...speeds)).toBeLessThan(habit.speed * 1.5);

    // Together: as wide as so many take up at their spacing, not strung
    // out, nor all on top of each other.
    const room = habit.spacing * Math.sqrt(sim.n);

    expect(sim.extent).toBeGreaterThan(room * 0.4);
    expect(sim.extent).toBeLessThan(room * 3);

    // And no bird stays where it was in the flock: ten seconds on, each
    // has moved about its middle.
    const places = (): number[][] =>
      Array.from({ length: sim.n }, (_, i) => [
        sim.position[i * 3] - sim.middle.x,
        sim.position[i * 3 + 2] - sim.middle.z,
      ]);

    const before = places();
    fly(30, 10);

    const moved = places().map((at, i) =>
      Math.hypot(at[0] - before[i][0], at[1] - before[i][1])
    );

    expect(moved.filter((m) => m > habit.spacing).length).toBeGreaterThan(
      sim.n * 0.7
    );
  });

  it("turn no harder than their kind can: gulls wheel, they don't spin", () => {
    const up = findFlying(GULLS);
    const plan = planAt(GULLS, up, HIGH_SUN, fresh());
    const sim = new FlockSim(GULLS, plan, SEA);
    const habit = HABITS.gull!;
    let tightest = Infinity;

    for (let f = 1; f <= 1200; f++) {
      const t = up + f * 50;
      const before = Float32Array.from(sim.heading);
      planAt(GULLS, t, HIGH_SUN, plan);
      sim.step(0.05, plan, SEA, t / 1000);

      for (let i = 0; i < sim.n; i++) {
        let turn = sim.heading[i] - before[i];
        turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;

        const speed = Math.hypot(sim.velocity[i * 3], sim.velocity[i * 3 + 2]);
        const rate = Math.abs(turn) / 0.05;

        if (rate > 1e-6) tightest = Math.min(tightest, speed / rate);
      }
    }

    // A circle some metres across at least, at a gull's slowest.
    expect(tightest).toBeGreaterThan(habit.span * 4);
    expect(tightest).toBeLessThan(60);
  });

  it("are, first seen, as they'd be had they been flying all along", () => {
    let up = findFlying(SHEARWATERS) + 60_000;
    const plan = fresh();
    const planOf = (t: number) => planAt(SHEARWATERS, t * 1000, HIGH_SUN, plan);
    const sim = new FlockSim(SHEARWATERS, planOf(up / 1000), SEA);

    expect(planOf(up / 1000).since).toBeGreaterThan(WARM);

    sim.arrive(planOf, SEA, up / 1000);

    // Not there yet, nor to be shown: flown up to now a few steps at a
    // time, however long that takes, and time going on meanwhile.
    expect(sim.arriving).toBe(true);
    expect(sim.catchUp(planOf, SEA, up / 1000, 5)).toBe(false);
    expect(sim.stepped).toBeCloseTo(up / 1000 - WARM + 1, 5);

    up += 100;

    expect(sim.catchUp(planOf, SEA, up / 1000, 1000)).toBe(true);
    expect(sim.arriving).toBe(false);
    expect(sim.stepped).toBe(up / 1000);
    expect(sim.down()).toBe(0);

    // Each on its own way, and its trail already behind it: three seconds
    // of flying, tens of metres, and not the same line as the next bird's.
    const ways = new Set<number>();

    for (let i = 0; i < sim.n; i++) {
      ways.add(Math.round((sim.heading[i] * 180) / Math.PI));

      const oldest = (i * TRAIL_POINTS + ((sim.newest + 1) % TRAIL_POINTS)) * 3;

      expect(
        Math.hypot(
          sim.position[i * 3] - sim.trail[oldest],
          sim.position[i * 3 + 2] - sim.trail[oldest + 2]
        )
      ).toBeGreaterThan(15);
    }

    expect(ways.size).toBeGreaterThan(8);

    // Near where the flock's headed, as if it had followed it there.
    planOf(up / 1000);

    expect(
      Math.hypot(sim.middle.x - plan.x, sim.middle.z - plan.z)
    ).toBeLessThan(150);
  });

  it("are put straight where they are, a flock that's down", () => {
    const down = restingAt(GULLS, fresh());
    const sim = new FlockSim(GULLS, { ...down, x: down.x + 500 }, SEA);

    sim.arrive(() => down, SEA, 1000);

    expect(sim.arriving).toBe(false);
    expect(sim.stepped).toBe(1000);
    expect(sim.down()).toBe(sim.n);
    expect(
      Math.hypot(sim.middle.x - down.x, sim.middle.z - down.z)
    ).toBeLessThan(100);
  });

  it("are still taking off, first seen moments after the flock's up", () => {
    // Up four seconds: at 0.08 s apart, fifty of them, the first well away.
    const up = { ...restingAt(GULLS, fresh()), flying: true, since: 4 };
    const sim = new FlockSim(GULLS, up, SEA);

    const planOf = (t: number) => ({ ...up, since: 4 - (1000 - t) });

    sim.arrive(planOf, SEA, 1000);

    expect(sim.down()).toBe(sim.n);
    expect(sim.catchUp(planOf, SEA, 1000, 1000)).toBe(true);

    expect(sim.down()).toBeGreaterThan(sim.n * 0.4);
    expect(sim.down()).toBeLessThan(sim.n * 0.7);

    const heights = Array.from(
      { length: sim.n },
      (_, i) => sim.position[i * 3 + 1]
    );

    expect(Math.max(...heights)).toBeGreaterThan(3);
  });

  it("leave trails where they've been, started afresh after a jump", () => {
    const up = findFlying(GULLS);
    const plan = planAt(GULLS, up, HIGH_SUN, fresh());
    const sim = new FlockSim(GULLS, plan, SEA);

    for (let f = 1; f <= 60; f++) sim.step(0.05, plan, SEA, f * 0.05);

    // Three seconds on: the oldest point's a second behind, metres back.
    const oldest = (sim.newest + 1) % TRAIL_POINTS;

    const behind = Math.hypot(
      sim.position[0] - sim.trail[oldest * 3],
      sim.position[2] - sim.trail[oldest * 3 + 2]
    );

    expect(behind).toBeGreaterThan(3);

    // Put a kilometre away: no line back to where it was.
    sim.place({ ...plan, x: plan.x + 1000 }, SEA);

    for (let k = 0; k < TRAIL_POINTS; k++) {
      expect(sim.trail[k * 3]).toBe(sim.position[0]);
    }
  });
});

/** About, all day: for the birds that work the trees. */
const ABOUT: Plan = { ...fresh(), flying: true };

/** Ground 50 m up, everywhere: under grove()'s trees. */
const FLAT = () => 50;

const flockOf = (kind: "songbird" | "finch", birds: number) =>
  flocksOf({ ...SUMMARY, sites: [site(kind, birds)] }, toWorld)[0];

interface Flight {
  bird: number;
  /** Seconds, the scene's. */
  began: number;
  ended: number;
  /** x, y, z and wing angle, each step from the perch it left to the one it reached. */
  path: number[][];
  /** Perch to perch, m. */
  length: number;
}

/**
 * `sim` flown on `seconds` from `from` in 0.05 s steps over `ground`: the
 * flights its birds made, start to finish. `each`, asked after every step.
 */
function watch(
  sim: FlockSim,
  from: number,
  seconds: number,
  ground: (x: number, z: number) => number = FLAT,
  each: (time: number) => void = () => {},
  surface = ground
) {
  const dt = 0.05;
  const flights: Flight[] = [];
  const flying: (Flight | undefined)[] = [];

  const at = (i: number) => [
    sim.position[i * 3],
    sim.position[i * 3 + 1],
    sim.position[i * 3 + 2],
    sim.wing[i],
  ];

  for (let f = 1; f * dt <= seconds; f++) {
    const time = from + f * dt;
    const before = Array.from({ length: sim.n }, (_, i) => at(i));
    const sat = Array.from(sim.settled);
    sim.step(dt, ABOUT, surface, time, ground);

    for (let i = 0; i < sim.n; i++) {
      let flight = flying[i];

      if (sat[i] && !sim.settled[i]) {
        flight = {
          bird: i,
          began: time,
          ended: time,
          path: [before[i]],
          length: 0,
        };
        flying[i] = flight;
      }

      if (!flight) continue;

      flight.path.push(at(i));

      if (!sim.settled[i]) continue;

      const [start] = flight.path;
      const end = at(i);
      flight.ended = time;
      flight.length = Math.hypot(end[0] - start[0], end[2] - start[2]);
      flights.push(flight);
      flying[i] = undefined;
    }

    each(time);
  }

  return flights;
}

describe("the birds that work the trees", () => {
  const songbird = HABITS.songbird!;
  const finch = HABITS.finch!;

  it("stay with a few trees a while, then others not far off, the same each time asked", () => {
    const tui = flockOf("songbird", 6);
    const stay = songbird.hops!.stay;
    const stays = [patchAt(tui, 1000)];

    for (let t = 1000; stays.length < 200; t += 1) {
      const now = patchAt(tui, t);
      const last = stays[stays.length - 1];

      if (now.index === last.index) {
        expect(now).toEqual(last);
        continue;
      }

      // The next, begun when the last ended.
      expect(now.index).toBe(last.index + 1);
      expect(now.since).toBeGreaterThan(t - 1);
      expect(now.since).toBeLessThanOrEqual(t);
      stays.push(now);
    }

    let moved = 0;

    for (let k = 1; k < stays.length; k++) {
      const { x, z, since } = stays[k];
      const lasted = since - stays[k - 1].since;
      expect(Math.hypot(x - tui.x, z - tui.z)).toBeLessThanOrEqual(
        songbird.roam
      );

      // The first began before the watch did.
      if (k > 1) {
        expect(lasted).toBeGreaterThan(stay * 0.39);
        expect(lasted).toBeLessThan(stay * 1.61);
      }

      moved += Math.hypot(x - stays[k - 1].x, z - stays[k - 1].z);
    }

    // Mostly a short flight on, not across its range each time.
    expect(moved / (stays.length - 1)).toBeLessThan(songbird.roam * 0.5);
    expect(moved / (stays.length - 1)).toBeGreaterThan(songbird.hops!.far);

    // Each bird of a kind that goes alone has its own.
    expect(patchAt(tui, 1000, 0)).not.toEqual(patchAt(tui, 1000, 1));
  });

  it("start in the trees they're staying with", () => {
    const sparrows = flockOf("finch", 12);
    const trees = grove(sparrows.x, sparrows.z, 720);
    const sim = new FlockSim(sparrows, ABOUT, FLAT, trees, 5000);
    const { x, z } = patchAt(sparrows, 5000);

    expect(sim.down()).toBe(sim.n);

    for (let i = 0; i < sim.n; i++) {
      const at = sim.position.subarray(i * 3, i * 3 + 3);

      expect(onACrown(trees, at)).toBe(true);
      // Within its few trees of the tree nearest the spot: 12 m apart.
      expect(Math.hypot(at[0] - x, at[2] - z)).toBeLessThan(
        finch.hops!.patch + 12
      );
    }
  });

  it("flit a short way between trees, then fly some distance to others", () => {
    const tui = flockOf("songbird", 6);
    const hops = songbird.hops!;
    const trees = grove(tui.x, tui.z, 720);
    const sim = new FlockSim(tui, ABOUT, FLAT, trees, 1000);
    const start = Array.from(sim.position);
    let sitting = 0;
    let flying = 0;

    const flights = watch(sim, 1000, 600, FLAT, () => {
      for (let i = 0; i < sim.n; i++) {
        const at = sim.position.subarray(i * 3, i * 3 + 3);

        // Sitting, it's in a tree; and never far from where it's counted.
        if (sim.settled[i]) expect(onACrown(trees, at)).toBe(true);

        expect(Math.hypot(at[0] - tui.x, at[2] - tui.z)).toBeLessThanOrEqual(
          songbird.roam + hops.patch + hops.far
        );
      }

      sitting += sim.down();
      flying += sim.n - sim.down();
    });

    const flits = flights.filter((f) => f.length <= hops.far);
    const far = flights.filter((f) => f.length > hops.far * 2);

    // Ten minutes: every bird's been somewhere, mostly by flits, and a
    // few times each further; more of the time sitting than not.
    for (let i = 0; i < sim.n; i++) {
      expect(flights.some((f) => f.bird === i)).toBe(true);

      expect(
        Math.hypot(
          sim.position[i * 3] - start[i * 3],
          sim.position[i * 3 + 2] - start[i * 3 + 2]
        )
      ).toBeGreaterThan(0);
    }

    expect(far.length).toBeGreaterThan(sim.n);
    expect(flits.length).toBeGreaterThan(far.length * 3);
    expect(sitting).toBeGreaterThan(flying);
  });

  it("fly there: off the perch, up to speed, and slowing onto the next", () => {
    const tui = flockOf("songbird", 6);
    const trees = grove(tui.x, tui.z, 720);
    const sim = new FlockSim(tui, ABOUT, FLAT, trees, 1000);
    const flights = watch(sim, 1000, 300);

    expect(flights.length).toBeGreaterThan(20);

    for (const { path, length, began, ended } of flights) {
      const speeds = path
        .slice(1)
        .map(
          (at, k) =>
            Math.hypot(
              at[0] - path[k][0],
              at[1] - path[k][1],
              at[2] - path[k][2]
            ) / 0.05
        );

      // No faster than a bird flies, and no jumps; onto the perch slowly.
      expect(Math.max(...speeds)).toBeLessThan(songbird.speed * 1.6);
      expect(speeds[speeds.length - 1]).toBeLessThan(8);

      if (speeds.length > 3) {
        expect(speeds[speeds.length - 2]).toBeLessThan(4.5);
      }

      // A long way's flown at about its speed.
      if (length > 80) {
        const speed = length / (ended - began);

        expect(speed).toBeGreaterThan(songbird.speed * 0.6);
        expect(speed).toBeLessThan(songbird.speed * 1.3);
      }
    }
  });

  it("come in under the perch and swoop up onto it", () => {
    const tui = flockOf("songbird", 1);

    // Two trees 30 m apart, as tall as each other.
    const trees = new PerchGrid(
      new Float32Array([
        ...tree(tui.x - 15, 60, tui.z, 1),
        ...tree(tui.x + 15, 60, tui.z, 1),
      ])
    );

    const sim = new FlockSim(tui, ABOUT, FLAT, trees, 1000);
    const across = watch(sim, 1000, 600).filter((f) => f.length > 20);

    expect(across.length).toBeGreaterThan(3);

    for (const { path } of across) {
      const perch = path[path.length - 1][1];
      const lowest = Math.min(...path.map((at) => at[1]));
      const late = path[path.length - 4];

      // Under the straight way between them, and rising at the end.
      expect(lowest).toBeLessThan(perch - 0.5);
      expect(lowest).toBeGreaterThan(perch - 6);
      expect(late[1]).toBeLessThan(perch);
    }
  });

  it("beat their wings in bursts on a long flight, shut between, rising and falling", () => {
    const sparrows = flockOf("finch", 4);
    const trees = grove(sparrows.x, sparrows.z, 720);
    const sim = new FlockSim(sparrows, ABOUT, FLAT, trees, 1000);
    const long = watch(sim, 1000, 900).filter((f) => f.length > 80);

    expect(long.length).toBeGreaterThan(3);

    for (const { path } of long) {
      const shut = path.filter((at) => at[3] < -1.2).length / path.length;
      let turns = 0;

      for (let k = 2; k < path.length; k++) {
        const was = path[k - 1][1] - path[k - 2][1];
        const is = path[k][1] - path[k - 1][1];

        if (was > 0 !== is > 0) turns++;
      }

      // About a third of the way with them shut; up and down many times.
      expect(shut).toBeGreaterThan(0.15);
      expect(shut).toBeLessThan(0.45);
      expect(turns).toBeGreaterThan(8);
    }

    // A short flit's beaten all the way.
    const flit = watch(sim, 1900, 120).find(
      (f) => f.length > 5 && f.length < 12
    );

    expect(flit?.path.slice(1, -1).some((at) => at[3] < -1.2)).toBe(false);
  });

  it("glide between bursts, for the bigger ones, wings out", () => {
    const tui = flockOf("songbird", 4);
    const trees = grove(tui.x, tui.z, 720);
    const sim = new FlockSim(tui, ABOUT, FLAT, trees, 1000);
    const long = watch(sim, 1000, 900).filter((f) => f.length > 80);

    expect(long.length).toBeGreaterThan(3);

    for (const { path } of long) {
      const flown = path.slice(1, -1);

      expect(flown.some((at) => at[3] < -1.2)).toBe(false);
      expect(flown.some((at) => Math.abs(at[3] - 0.12) < 0.01)).toBe(true);
    }
  });

  it("leave one after another, for finches, and fly to the next trees together", () => {
    const sparrows = flockOf("finch", 12);
    const hops = finch.hops!;
    const trees = grove(sparrows.x, sparrows.z, 720);
    const next = patchAt(sparrows, 1000 + hops.stay * 2);
    const sim = new FlockSim(sparrows, ABOUT, FLAT, trees, next.since - 20);
    const strung: number[] = [];

    // From before they leave till well after they've come.
    const flights = watch(sim, next.since - 20, 80, FLAT, () => {
      const up = Array.from({ length: sim.n }, (_, i) => i).filter(
        (i) => !sim.settled[i]
      );

      if (up.length < sim.n * 0.75) return;

      const middle = [0, 2].map(
        (axis) =>
          up.reduce((sum, i) => sum + sim.position[i * 3 + axis], 0) / up.length
      );

      strung.push(
        Math.max(
          ...up.map((i) =>
            Math.hypot(
              sim.position[i * 3] - middle[0],
              sim.position[i * 3 + 2] - middle[1]
            )
          )
        )
      );
    });

    const leaving = Array.from({ length: sim.n }, (_, i) =>
      flights.find((f) => f.bird === i && f.began >= next.since)
    );

    const times = leaving.map((f) => f?.began ?? Infinity);

    // Each has left, within a few seconds of the first; not all at once.
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(
      hops.follow! * 3 + hops.pause[1]
    );
    expect(new Set(times).size).toBeGreaterThan(sim.n / 2);
    expect(Math.min(...times)).toBeLessThan(next.since + hops.follow! * 2);

    // Most of them in the air at once, and near each other.
    expect(strung.length).toBeGreaterThan(0);
    expect(Math.max(...strung)).toBeLessThan(60);

    // Down again in the trees they went for.
    for (let i = 0; i < sim.n; i++) {
      expect(
        Math.hypot(
          sim.position[i * 3] - next.x,
          sim.position[i * 3 + 2] - next.z
        )
      ).toBeLessThan(hops.patch + hops.far + 12);
    }
  });

  it("go over a hill between their trees, and the roofs if they're not towers", () => {
    const tui = flockOf("songbird", 3);

    // Trees in two clumps 240 m apart, a 40 m ridge between them with
    // houses along it: 8 m, and a 90 m tower's worth further on.
    const clumps: number[] = [];

    for (const side of [-120, 120]) {
      for (let k = 0; k < 9; k++) {
        clumps.push(
          ...tree(
            tui.x + side + (k % 3) * 10,
            62,
            tui.z + Math.floor(k / 3) * 10,
            1.5
          )
        );
      }
    }

    const trees = new PerchGrid(new Float32Array(clumps));

    const hill = (x: number) =>
      50 + 40 * Math.max(0, 1 - Math.abs(x - tui.x) / 60);

    const roofed = (x: number) =>
      hill(x) + (Math.abs(x - tui.x) < 30 ? (x > tui.x ? 90 : 8) + 1 : 0);

    const sim = new FlockSim(tui, ABOUT, roofed, trees, 1000);
    let overHouses = Infinity;
    let overTower = Infinity;

    const over = watch(
      sim,
      1000,
      1200,
      hill,
      () => {
        for (let i = 0; i < sim.n; i++) {
          const [x, y] = sim.position.subarray(i * 3, i * 3 + 3);

          expect(y).toBeGreaterThanOrEqual(hill(x) + 0.39);

          if (x > tui.x - 20 && x < tui.x - 5) {
            overHouses = Math.min(overHouses, y - hill(x));
          }

          if (x > tui.x + 5 && x < tui.x + 20) {
            overTower = Math.min(overTower, y - hill(x));
          }
        }
      },
      roofed
    ).filter((f) => f.length > 200);

    // Over the ridge a few times: clear of the houses, not up the tower.
    expect(over.length).toBeGreaterThan(1);
    expect(overHouses).toBeGreaterThan(8);
    expect(overTower).toBeLessThan(40);
  });

  it("finish their flights and sit, once they're not about", () => {
    const tui = flockOf("songbird", 6);
    const sim = new FlockSim(tui, ABOUT, FLAT, grove(tui.x, tui.z, 720), 1000);

    watch(sim, 1000, 30);

    const done = { ...ABOUT, flying: false };

    for (let f = 1; f <= 1200; f++) {
      sim.step(0.05, done, FLAT, 1030 + f * 0.05, FLAT);
    }

    expect(sim.down()).toBe(sim.n);

    const there = Array.from(sim.position);

    for (let f = 1; f <= 200; f++) {
      sim.step(0.05, done, FLAT, 1090 + f * 0.05, FLAT);
    }

    expect(Array.from(sim.position)).toEqual(there);
  });

  it("fly the same in long steps as short, and always come down", () => {
    const sparrows = flockOf("finch", 12);
    const trees = grove(sparrows.x, sparrows.z, 720);
    const sim = new FlockSim(sparrows, ABOUT, FLAT, trees, 1000);
    const up = new Float32Array(sim.n);

    for (let f = 1; f <= 3000; f++) {
      const before = Array.from(sim.position);
      sim.step(0.2, ABOUT, FLAT, 1000 + f * 0.2, FLAT);

      for (let i = 0; i < sim.n; i++) {
        up[i] = sim.settled[i] ? 0 : up[i] + 0.2;

        // A long flight's half a minute; none goes on and on.
        expect(up[i]).toBeLessThan(90);

        const moved = Math.hypot(
          sim.position[i * 3] - before[i * 3],
          sim.position[i * 3 + 1] - before[i * 3 + 1],
          sim.position[i * 3 + 2] - before[i * 3 + 2]
        );

        expect(moved / 0.2).toBeLessThan(finch.speed * 1.6);
      }
    }
  });
});

describe("how high birds keep over the buildings", () => {
  /** Four 512 m tiles across: a 100 m tower in one, houses in another. */
  const MANIFEST: BuildingsManifest = {
    attribution: "",
    origin: [0, 0],
    encoding: { rel: { min: 0, range: 1 }, ground: { min: 0, range: 1 } },
    rootSize: 2048,
    levels: [
      {
        level: 2,
        error: 0,
        tiles: [
          [1, 1, 0, 0, 0, 0, 0, 0, 100],
          [3, 3, 0, 0, 0, 0, 0, 0, 9],
        ],
      },
    ],
  };

  const roofs = roofsOf(MANIFEST);

  /** World x, z in tile `x`, `z`, `fx` and `fz` across it. */
  const inTile = (
    x: number,
    z: number,
    fx = 0.5,
    fz = 0.5
  ): [number, number] => [-1024 + (x + fx) * 512, -1024 + (z + fz) * 512];

  it("is over the tallest anywhere in a tile, to its edges", () => {
    for (const f of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      expect(
        roofAbove(roofs, ...inTile(1, 1, f, 1 - f))
      ).toBeGreaterThanOrEqual(100);
    }

    expect(
      roofAbove(roofs, ...inTile(3, 3, 0.99, 0.99))
    ).toBeGreaterThanOrEqual(9);
  });

  it("climbs before the towers, and is nothing well away from buildings", () => {
    // A tile on from the tower: on the way up to it.
    expect(roofAbove(roofs, ...inTile(2, 2, 0.9, 0.9))).toBeGreaterThan(9);
    expect(roofAbove(roofs, ...inTile(0, 3))).toBe(0);
  });

  it("climb over what's under them and ahead, not into it", () => {
    const up = findFlying(GULLS);
    const plan = planAt(GULLS, up, HIGH_SUN, fresh());
    // A 60 m block of roofs east of x = 0, wherever the flock is.
    const roofs = (x: number) => (x > plan.x ? 60 : 0);
    const sim = new FlockSim(GULLS, plan, SEA);

    for (let f = 1; f <= 400; f++) {
      const t = up + f * 50;
      planAt(GULLS, t, HIGH_SUN, plan);
      sim.step(0.05, plan, roofs, t / 1000);

      for (let i = 0; i < sim.n; i++) {
        expect(sim.position[i * 3 + 1]).toBeGreaterThanOrEqual(
          roofs(sim.position[i * 3])
        );
      }
    }
  });
});

describe("the trees the hoppers perch in", () => {
  it("are needed: no trees, no hoppers", () => {
    const [tui] = flocksOf(
      { ...SUMMARY, sites: [site("songbird", 6)] },
      toWorld
    );

    expect(
      () => new FlockSim(tui, fresh(), SEA, new PerchGrid(new Float32Array(0)))
    ).toThrow("hoppers need trees");
  });

  it("are read from the trees' tiles as the trees layer draws them", () => {
    const index = new TreeIndex({
      attribution: "",
      origin: [0, 0],
      rootSize: 4096,
      level: 2,
      bands: [1],
      encoding: {
        ground: { offset: 1000, scale: 32 },
        heightStep: 0.25,
        radiusStep: 0.1,
      },
      tiles: [[1, 2, 2, 0, 0, 0]],
    });

    const [tile] = index.tiles;

    // Two trees: one in the middle of the tile, 12 m tall, 4 m across, on
    // ground 20 m up; one in its corner, far off.
    const data = new Uint16Array([
      32768,
      32768,
      (20 + 1000) * 32,
      (48 << 8) | 20,
      0,
      0,
      1000 * 32,
      (40 << 8) | 30,
    ]);

    const middle = [tile.minX + 512, tile.minZ + 512];

    const trees = decodeTrees(
      index,
      tile,
      data,
      middle[0],
      middle[1],
      100,
      1.15
    );

    expect(trees).toHaveLength(TREE_STRIDE);
    expect(trees[0]).toBeCloseTo(middle[0], 0);
    expect(trees[2]).toBeCloseTo(middle[1], 0);
    expect(trees[3]).toBeCloseTo(2, 5);

    // 20 m of ground, scaled, and a 12 m tree on it: its crown, as it's
    // drawn, tops out a little under that.
    expect(trees[1]).toBeLessThan(20 * 1.15 + 12);
    expect(trees[1]).toBeGreaterThan(20 * 1.15 + 11);

    const top = crownTop(32768, 32768, 12, 2);

    expect(trees.slice(4)).toEqual([top.x, top.z, top.size, top.seed]);
    expect(trees[1]).toBeCloseTo(20 * 1.15 + top.up + 0.82 * top.size, 5);
  });

  it("have crowns shaped as the trees layer's shader shapes them", () => {
    // Its hash, worked the long way: PCG on the seed cut to a whole number.
    const pcg = (seed: number) => {
      const big = (n: number) => BigInt(n);
      const wrap = (n: bigint) => n & big(0xffff_ffff);

      const state = wrap(
        big(Math.trunc(seed)) * big(747796405) + big(2891336453)
      );

      const word = wrap(
        ((state >> ((state >> big(28)) + big(4))) ^ state) * big(277803737)
      );

      return Math.fround(Number((word >> big(22)) ^ word)) / 2 ** 32;
    };

    for (const seed of [0, 1, 7.9, 32768, 65535, 999_999.4, 1_065_535]) {
      expect(shaderHash(seed)).toBe(pcg(seed));
    }

    // A broad tree's a dome: its top lobe big, near the trunk, most of the
    // way up. A tall thin one's a cone: a small lobe at its tip.
    for (let q = 0; q < 200; q++) {
      const dome = crownTop(q * 311, q * 173, 8, 5);

      expect(dome).toEqual(crownTop(q * 311, q * 173, 8, 5));
      expect(dome.size).toBeGreaterThanOrEqual(0.55 * 5 - 1e-6);
      expect(dome.size).toBeLessThanOrEqual(0.68 * 5 + 1e-6);
      expect(Math.hypot(dome.x, dome.z)).toBeLessThanOrEqual(0.2 * 5 + 1e-6);
      expect(dome.up).toBeGreaterThan(8 * 0.6);
      expect(dome.up).toBeLessThan(8 * 0.75);

      const cone = crownTop(q * 311, q * 173, 20, 2);

      expect(cone.size).toBeLessThan(0.6 * 2);
      expect(cone.up).toBeGreaterThan(20 * 0.9);
      expect(cone.up).toBeLessThan(20);
    }
  });

  it("seat birds on the top of the crown's top lobe, each its own place", () => {
    const [x, top, z, radius] = [100, 60, -40, 3];
    const trees = new PerchGrid(new Float32Array(tree(x, top, z, radius)));
    const { lobe } = trees.tree(0);
    const seats = new Set<string>();
    const at = new Float32Array(3);

    for (let k = 0; k < 300; k++) {
      trees.seat(0, hashed(1, k), hashed(2, k), hashed(3, k), at);

      // On the faces round its highest point: lumpy, so a little over or
      // under the lobe's own height, and never off its shoulders.
      expect(Math.hypot(at[0] - x, at[2] - z)).toBeLessThan(lobe * 0.7);
      expect(at[1]).toBeGreaterThan(top - lobe * 0.3);
      expect(at[1]).toBeLessThan(top + lobe * 0.15 + 0.05);
      seats.add(Array.from(at, (v) => v.toFixed(2)).join());
    }

    expect(seats.size).toBeGreaterThan(250);
  });

  it("are found nearest where a bird means to go, not the one it's in", () => {
    const trees = grove(0, 0, 48);

    const at = trees.nearest(13, -1, 30);
    expect(trees.tree(at)).toMatchObject({ x: 12, z: 0 });

    const other = trees.nearest(0.5, 0.5, 30, { x: 0, z: 0 });
    expect(trees.tree(other)).not.toMatchObject({ x: 0, z: 0 });

    expect(trees.nearest(500, 500, 30)).toBe(-1);
    expect(trees.tree(trees.closest(500, 500))).toMatchObject({ x: 24, z: 24 });
  });
});
