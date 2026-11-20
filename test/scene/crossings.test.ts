import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createDeckGeometry,
  createMastGeometry,
  deckHalf,
} from "../../src/components/scene/trains/crossingGeometry";
import {
  ARMS_AFTER,
  ARMS_FALL,
  ARMS_RISE,
  arrival,
  type CrossingsFile,
  flashing,
  lowered,
  NEVER,
  passesOf,
  placeCrossings,
  Signal,
  Watch,
} from "../../src/components/scene/trains/crossingWatch";
import {
  type NetworkFile,
  RAIL_TOP,
  RailNetwork,
} from "../../src/components/scene/trains/network";
import {
  follow,
  type Routes,
  type Run,
} from "../../src/components/scene/trains/run";
import { verticalScale } from "../../src/components/scene/terrain/Terrain";
import type { Train } from "../../src/lib/trains";
import { originIndex } from "../fixtures/terrain";

// Level crossings: the lights and barriers worked from the trains as
// they're drawn. Here: a double track running 3 km north from the origin
// (the down line at easting 0, the up line 4 m east), crossed square at
// northing 1500 by a two-lane road with half barriers, and at 2500 by a
// farm track with nothing but its deck. World x is east and z south.

const line = (e: number) =>
  Array.from({ length: 16 }, (_, k) => [e, k * 200, 10]).flat();

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, k) => from + k);

const tracks: NetworkFile = {
  flags: { tunnel: 1, bridge: 2, model: 4 },
  nodes: [...line(0), ...line(4)],
  ways: [
    [0, ...range(0, 16)],
    [0, ...range(16, 16)],
  ],
  platforms: [],
};

const file: CrossingsFile = {
  crossings: [
    {
      name: "Station Road",
      kind: "road",
      at: [2, 1500, 10],
      road: 90,
      track: 0,
      half: 4,
      spread: 2,
      count: 2,
      tracks: [
        [0, 1500],
        [1, 1500],
      ],
      lights: true,
      bells: true,
      barrier: "half",
      arm: 4.9,
      guessed: [],
      // East of the line on the road's south side, west on its north: the
      // left for those driving up from each.
      masts: [
        [7.9, 1495.1, 10.2, 90],
        [-3.9, 1504.9, 9.8, -90],
      ],
    },
    {
      name: "",
      kind: "road",
      at: [0, 2500, 10],
      road: 90,
      track: 0,
      half: 1.75,
      spread: 0,
      count: 1,
      tracks: [[0, 2500]],
      lights: false,
      bells: false,
      barrier: "no",
      arm: 0,
      guessed: ["light", "bell", "barrier"],
      masts: [
        [3.9, 2497.4, 10, 90],
        [-3.9, 2502.6, 10, -90],
      ],
    },
  ],
};

const index = originIndex();
const network = new RailNetwork(tracks, index);
const crossings = placeCrossings(file, index);
const [road, farm] = crossings;
const scale = verticalScale.value;

const EPOCH = 1_700_000_000_000;
const routes: Routes = (_key, find) => find();

/** A Kāpiti train heard at each of `fixes`: e, n, seconds after EPOCH. */
function train(fixes: [number, number, number][], id = "4123"): Train {
  const trail = fixes.map(([e, n, s]): [number, number, number] => [
    e,
    n,
    EPOCH + s * 1000,
  ]);

  const [e, n, time] = trail[trail.length - 1];

  return {
    id,
    line: "KPL",
    direction: 0,
    position: [e, n],
    bearing: 0,
    time,
    trail,
  };
}

function running(fixes: [number, number, number][], id?: string): Run {
  const run = follow(train(fixes, id), network, index, EPOCH, routes, false);

  if (!run) throw new Error("the train's off the tracks");

  return run;
}

/** Northbound on the down line at 20 m/s: at northing 20 t, for a minute. */
const northbound = (id?: string) =>
  running(
    [
      [0, 400, 20],
      [0, 1000, 50],
      [0, 1600, 80],
    ],
    id
  );

describe("level crossings", () => {
  describe("the built file", () => {
    it("has each crossing on its tracks, masts either side of the line", async () => {
      const read = async (name: string) =>
        JSON.parse(await readFile(`public/rail/${name}.json`, "utf8"));

      const built: CrossingsFile = await read("crossings");
      const rail: NetworkFile = await read("network");

      expect(built.crossings.length).toBeGreaterThan(10);

      /** The place `along` m down a way of the network. */
      const placeOn = (way: number, along: number) => {
        const [, ...points] = rail.ways[way];
        let left = along;

        for (let k = 1; k < points.length; k++) {
          const [ae, an] = [0, 1].map((i) => rail.nodes[points[k - 1] * 3 + i]);
          const [be, bn] = [0, 1].map((i) => rail.nodes[points[k] * 3 + i]);
          const length = Math.hypot(be - ae, bn - an);

          if (left <= length + 0.1) {
            const t = left / (length || 1);

            return [ae + (be - ae) * t, an + (bn - an) * t];
          }

          left -= length;
        }

        throw new Error(`way ${way} is shorter than ${along} m`);
      };

      for (const crossing of built.crossings) {
        const [e, n] = crossing.at;
        const name = crossing.name || `${e}, ${n}`;
        const bearing = (crossing.road * Math.PI) / 180;
        const along = [Math.sin(bearing), Math.cos(bearing)];

        expect(crossing.tracks.length, name).toBeGreaterThan(0);
        expect(crossing.count, name).toBeGreaterThan(0);

        // Each of its tracks runs through it, within the road's width.
        for (const [way, metres] of crossing.tracks) {
          const [te, tn] = placeOn(way, metres);

          expect(Math.hypot(te - e, tn - n), name).toBeLessThan(
            crossing.spread + crossing.half + 3
          );
        }

        // A mast each side of the line, clear of the tracks and off the
        // road, facing back up it.
        expect(crossing.masts, name).toHaveLength(2);

        const sides = crossing.masts.map(([me, mn, , facing]) => {
          const forward = (me - e) * along[0] + (mn - n) * along[1];
          const aside = (me - e) * along[1] - (mn - n) * along[0];
          const faces = Math.cos(((facing - crossing.road) * Math.PI) / 180);

          expect(Math.abs(forward), name).toBeGreaterThan(crossing.spread + 2);
          expect(Math.abs(aside), name).toBeGreaterThan(crossing.half);
          expect(faces * Math.sign(forward), name).toBeCloseTo(1, 3);

          return [Math.sign(forward), Math.sign(aside)];
        });

        expect(sides[0][0], name).toBe(-sides[1][0]);
        expect(sides[0][1], name).toBe(-sides[1][1]);

        // Arms only where there are lights and OSM says barriers.
        expect(crossing.arm > 0, name).toBe(
          crossing.lights && crossing.barrier !== "no"
        );

        // A path's worth drawing only for its lights.
        if (crossing.kind === "path") expect(crossing.lights, name).toBe(true);
      }

      // The Johnsonville Line's, in the city, as OpenStreetMap has them.
      const simla = built.crossings.find((c) => c.name === "Simla Crescent");

      expect(simla).toMatchObject({
        kind: "road",
        count: 1,
        lights: true,
        bells: true,
        barrier: "half",
        guessed: [],
      });
    });
  });

  describe("in the world", () => {
    it("stands where the file says, scaled as the terrain is", () => {
      expect(road).toMatchObject({
        name: "Station Road",
        path: false,
        lights: true,
        x: 2,
        y: 10 * scale,
        z: -1500,
        half: 4,
        spread: 2,
        square: 1,
      });
      expect(road.road[0]).toBeCloseTo(1, 6);
      expect(road.road[1]).toBeCloseTo(0, 6);
      expect(road.ends).toEqual([10.2 * scale, 9.8 * scale]);
    });

    it("puts each mast on the left of those driving up, facing them", () => {
      const [east, west] = road.masts;

      expect(east).toMatchObject({ x: 7.9, y: 10.2 * scale, z: -1495.1 });
      expect(east.arm).toBe(4.9);

      // Facing east, at those driving west, who keep left: south of the
      // middle. Its own x (the arm's way) is north, out over their lane.
      expect(east.facing[0]).toBeCloseTo(1, 6);
      expect(east.facing[1]).toBeCloseTo(0, 6);

      const reach = [east.facing[1], -east.facing[0]];

      expect(east.z + reach[1] * east.arm).toBeCloseTo(-1500, 6);

      expect(west.facing[0]).toBeCloseTo(-1, 6);
      expect(west.z).toBe(-1504.9);
    });

    it("has no masts where there are no lights", () => {
      expect(farm.lights).toBe(false);
      expect(farm.masts).toEqual([]);
    });

    it("warns longer the more tracks there are", () => {
      const warning = (count: number) =>
        placeCrossings(
          { crossings: [{ ...file.crossings[0], count }] },
          index
        )[0].warning;

      expect(warning(1)).toBe(22);
      expect(warning(2)).toBe(25);
      expect(warning(3)).toBe(27);
    });
  });

  describe("on a train's way", () => {
    it("is found where the track goes over it, the far one too", () => {
      const run = northbound();
      const passes = passesOf(run, crossings);

      // Its first fix, 0 along, is at northing 400; track's laid on ahead.
      expect(passes).toEqual([
        { crossing: 0, s: expect.closeTo(1100, 0) },
        { crossing: 1, s: expect.closeTo(2100, 0) },
      ]);
    });

    it("isn't on the way of a train that stops short", () => {
      // Southbound from short of it: the track behind it, for its cars to
      // stand on, doesn't reach back that far.
      const run = running([
        [4, 1300, 10],
        [4, 700, 40],
      ]);

      expect(passesOf(run, crossings)).toEqual([]);
    });
  });

  describe("a train's arrival", () => {
    const run = northbound();
    const at = 1100;

    it("is as its fixes say, to the edge nearest it", () => {
      // The front is half the train ahead of the fix, and the crossing's
      // edge 5 m short of its middle: 20 m/s closes the rest.
      const gap = at - road.span - run.length / 2;

      expect(arrival(run, at, road.span, 20, 20)).toBeCloseTo(gap / 20, 3);
      expect(arrival(run, at, road.span, 40, 40)).toBeCloseTo(
        (gap - 400) / 20,
        3
      );
    });

    it("is none while the train's on it, and never once it's clear", () => {
      const front = (s: number) => 20 + (s - run.length / 2) / 20;

      expect(
        arrival(run, at, road.span, front(at - road.span + 0.01), 80)
      ).toBe(0);
      expect(arrival(run, at, road.span, front(at + run.length), 80)).toBe(0);
      expect(arrival(run, 100, road.span, 60, 80)).toBe(Infinity);
    });

    it("is guessed past the last fix, from the pace it was going", () => {
      // The farm track's, 900 m past the last fix: 45 s at 20 m/s.
      const far = 2100 - farm.span - run.length / 2;

      expect(arrival(run, 2100, farm.span, 80, 80)).toBeCloseTo(
        (far - 1200) / 20,
        3
      );
      // Too far off to say.
      expect(arrival(run, 2400, farm.span, 80, 80)).toBe(Infinity);
    });

    it("can't be guessed for a train that's stopped, or gone quiet", () => {
      const stopped = running([
        [0, 1000, 20],
        [0, 1400, 50],
        [0, 1400, 80],
      ]);

      const [pass] = passesOf(stopped, crossings);

      expect(pass.crossing).toBe(0);
      expect(arrival(stopped, pass.s, road.span, 80, 80)).toBe(Infinity);

      // Waiting at its last fix for the next, more than half a minute.
      expect(arrival(run, 2100, farm.span, 80, 100)).toBeLessThan(Infinity);
      expect(arrival(run, 2100, farm.span, 80, 115)).toBe(Infinity);
    });
  });

  describe("the sequence", () => {
    it("flashes, then lowers the arms, and raises them once clear", () => {
      const signal = new Signal();

      signal.step(100, false);
      expect(signal).toMatchObject({ on: NEVER, off: NEVER });
      expect(flashing(signal.on, signal.off, 100)).toBe(false);
      expect(lowered(signal.on, signal.off, 100)).toBe(0);

      signal.step(100, true, 25);
      expect(signal).toMatchObject({ on: 100, off: NEVER, going: true });
      expect(flashing(signal.on, signal.off, 100)).toBe(true);
      expect(lowered(signal.on, signal.off, 100 + ARMS_AFTER)).toBe(0);
      expect(
        lowered(signal.on, signal.off, 100 + ARMS_AFTER + ARMS_FALL / 2)
      ).toBeCloseTo(0.5, 6);
      expect(lowered(signal.on, signal.off, 100 + 25)).toBe(1);

      signal.step(140, false);
      expect(signal).toMatchObject({ on: 100, off: 140, going: false });
      expect(lowered(signal.on, signal.off, 140 + ARMS_RISE / 2)).toBeCloseTo(
        0.5,
        6
      );
      // Flashing until the arms are up.
      expect(flashing(signal.on, signal.off, 140 + ARMS_RISE - 0.1)).toBe(true);
      expect(flashing(signal.on, signal.off, 140 + ARMS_RISE)).toBe(false);

      signal.step(140 + ARMS_RISE, false);
      expect(signal).toMatchObject({ on: NEVER, off: NEVER });
    });

    it("goes down again from where the arms had got to", () => {
      const signal = new Signal();

      signal.step(0, true, 25);
      signal.step(40, false);

      const now = 40 + ARMS_RISE * 0.25;
      const before = lowered(signal.on, signal.off, now);

      expect(before).toBeCloseTo(0.75, 6);
      signal.step(now, true, 25);

      expect(signal.going).toBe(true);
      expect(lowered(signal.on, signal.off, now)).toBeCloseTo(before, 6);
      expect(flashing(signal.on, signal.off, now)).toBe(true);
    });

    it("skips the wait when the train's nearly there", () => {
      const signal = new Signal();

      signal.step(50, true, 6);

      // The arms start down at once.
      expect(signal.on).toBe(50 - ARMS_AFTER);
      expect(lowered(signal.on, signal.off, 50 + ARMS_FALL)).toBe(1);
    });
  });

  describe("watching the trains", () => {
    /** Frames a tenth of a second apart, trains drawn at the frame's time. */
    function play(watch: Watch, runs: Run[], from: number, to: number) {
      const log: { time: number; flashing: boolean; down: number }[] = [];

      for (let time = from; time <= to + 1e-6; time += 0.1) {
        watch.begin();

        for (const run of runs) watch.see(run, time, time);
        watch.settle(time);

        const { on, off } = watch.signals[0];

        log.push({
          time,
          flashing: flashing(on, off, time),
          down: lowered(on, off, time),
        });
      }

      return log;
    }

    const first = <T>(log: T[], test: (entry: T) => boolean) => {
      const entry = log.find(test);

      if (!entry) throw new Error("it never happened");

      return entry;
    };

    it("starts in time for the train, and clears behind it", () => {
      const watch = new Watch(crossings);
      const run = northbound();
      // To a minute and a half: it's at its last fix, past the crossing.
      const log = play(watch, [run], 20, 90);

      // The front's at the crossing's edge 1500 - 5 m north: the fix, half
      // a train behind it, is there at 20 m/s.
      const arrives = (1500 - road.span - run.length / 2) / 20;
      const clears = (1500 + road.span + run.length / 2) / 20;
      const starts = first(log, (entry) => entry.flashing).time;

      expect(arrives - starts).toBeCloseTo(road.warning, 0);

      // The arms are down well before it's there, and stay down under it.
      const down = first(log, (entry) => entry.down === 1).time;

      expect(down - starts).toBeCloseTo(ARMS_AFTER + ARMS_FALL, 0);
      expect(down).toBeLessThan(arrives - 5);

      for (const entry of log) {
        if (entry.time > arrives && entry.time < clears) {
          expect(entry.down, `${entry.time}`).toBe(1);
        }
      }

      // Up again within a few seconds of its tail, and the lights out.
      const rising = first(
        log,
        (entry) => entry.time > down && entry.down < 1
      ).time;

      expect(rising - clears).toBeGreaterThan(0);
      expect(rising - clears).toBeLessThan(1);

      const out = first(
        log,
        (entry) => entry.time > rising && !entry.flashing
      ).time;

      expect(out - rising).toBeCloseTo(ARMS_RISE, 0);
      expect(watch.signals[0]).toMatchObject({ on: NEVER, off: NEVER });

      // The farm track's has no lights to flash.
      expect(watch.signals[1]).toMatchObject({ on: NEVER, off: NEVER });
    });

    it("stays down for a second train the other way", () => {
      const watch = new Watch(crossings);
      const north = northbound("4001");

      // Southbound on the up line, over the crossing 15 s after the first.
      const south = running(
        [
          [4, 2900, 20],
          [4, 2300, 50],
          [4, 1700, 80],
          [4, 1100, 110],
        ],
        "4002"
      );

      const log = play(watch, [north, south], 20, 110);
      const starts = first(log, (entry) => entry.flashing).time;
      const down = first(log, (entry) => entry.down === 1).time;

      // Down once, and not up again until the second's gone by too.
      const secondClears =
        20 + (2900 - 1500 + road.span + south.length / 2) / 20;

      for (const entry of log) {
        if (entry.time > down && entry.time < secondClears) {
          expect(entry.down, `${entry.time}`).toBe(1);
        }
      }

      expect(starts).toBeLessThan(down);
      expect(log.at(-1)).toMatchObject({ flashing: false, down: 0 });
    });

    it("leaves them alone when nothing's coming", () => {
      const watch = new Watch(crossings);

      const away = running([
        [4, 1400, 20],
        [4, 800, 50],
      ]);

      const log = play(watch, [away], 20, 50);

      expect(log.every((entry) => !entry.flashing && entry.down === 0)).toBe(
        true
      );
    });

    it("holds every one with lights down when told to", () => {
      const watch = new Watch(crossings, true);
      const log = play(watch, [], 0, 1);

      expect(log.every((entry) => entry.flashing && entry.down === 1)).toBe(
        true
      );
      expect(watch.signals[1]).toMatchObject({ on: NEVER, off: NEVER });

      // Setting the clock doesn't let them up.
      watch.reset();
      expect(watch.signals[0].on).toBeLessThan(0);
    });

    it("forgets what was flashing when the clock's set", () => {
      const watch = new Watch(crossings);

      play(watch, [northbound()], 20, 60);
      expect(watch.signals[0].going).toBe(true);

      watch.reset();
      expect(watch.signals[0]).toMatchObject({ on: NEVER, off: NEVER });
    });
  });

  describe("what's drawn", () => {
    it("is a mast whose arm alone swings", () => {
      const geometry = createMastGeometry();
      const position = geometry.getAttribute("position");
      const swing = geometry.getAttribute("swing");
      const part = geometry.getAttribute("part");

      expect(swing.count).toBe(position.count);
      expect(part.count).toBe(position.count);
      expect(geometry.getAttribute("normal").count).toBe(position.count);

      let tip = 0;
      let top = 0;

      for (let i = 0; i < position.count; i++) {
        if (swing.getX(i)) {
          // From the pivot: thin, and reaching only as `swing` says.
          expect(Math.abs(position.getY(i))).toBeLessThan(0.2);
          expect(position.getX(i)).toBeLessThanOrEqual(0);
          tip = Math.max(tip, swing.getY(i));
        } else {
          expect(swing.getY(i)).toBe(0);
          top = Math.max(top, position.getY(i));
        }
      }

      expect(tip).toBe(1);
      expect(top).toBeGreaterThan(4);
      expect(top).toBeLessThan(6);
    });

    it("is a deck over the rails, ramped down to the road each way", () => {
      const geometry = createDeckGeometry(crossings);
      const position = geometry.getAttribute("position");
      const top = road.y + RAIL_TOP;
      const flat = deckHalf(road);

      // Square to the track: past the ballast of both.
      expect(flat).toBeCloseTo(road.spread + 2.3, 6);

      let highest = -Infinity;
      let east = -Infinity;
      let west = Infinity;

      for (let i = 0; i < position.count; i++) {
        // The road's deck only: the farm track's is a kilometre north.
        if (position.getZ(i) > -2000) {
          highest = Math.max(highest, position.getY(i));
          east = Math.max(east, position.getX(i));
          west = Math.min(west, position.getX(i));
          expect(Math.abs(position.getZ(i) + 1500)).toBeLessThanOrEqual(4.001);
        }
      }

      expect(highest).toBeGreaterThan(top);
      expect(highest).toBeLessThan(top + 0.1);
      expect(east).toBeCloseTo(road.x + flat + 6, 3);
      expect(west).toBeCloseTo(road.x - flat - 6, 3);
    });
  });
});
