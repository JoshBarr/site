import type { TrafficSpeeds } from "../../../lib/traffic";
import type { TileIndex } from "../terrain/manifest";
import type { Carriageway, Roads } from "./roads";
import {
  BIN,
  Bins,
  createBins,
  fillDensity,
  fillSpeeds,
  HEADWAY,
  MIN_GAP,
  Override,
} from "./speeds";

// Traffic on the highways, lane by lane. NZTA gives speeds, not vehicles,
// so these are made up to match: each driver follows the one ahead (the
// intelligent driver model) toward the speed NZTA has for that stretch,
// and between junctions vehicles join from side roads and ramps where
// there are too few for how busy it should be, and leave where there are
// too many. Queues form and clear on their own.

/** Intelligent driver model: comfortable acceleration and braking, m/s². */
const ACCELERATION = 1.1;
const BRAKING = 2;

/** How hard anyone brakes at most, m/s². */
const EMERGENCY = 8;

/** Steps longer than this are split, s; a frame longer still is cut short. */
const STEP = 1 / 20;
const MAX_FRAME = 0.25;

/** Drivers aim for the speed this far ahead, m, and a couple of seconds on. */
const LOOKAHEAD = 40;
const LOOKAHEAD_TIME = 2;

/** Lanes are left this far before they end, m. */
const MERGE_AHEAD = 80;

/** Sideways, changing lanes, m/s. */
const LANE_CHANGE = 1.6;

/** Each driver thinks about changing lanes about this often, s. */
const CHANGE_EVERY = 12;

/**
 * Of the traffic in a lane that turns off at a junction, how much takes
 * it: the rest moves over first. Where SH2 leaves SH1, it's SH2's share.
 */
const TAKES_TURN = 0.3;

/** Joining and leaving: fading in or out over, s, sliding in from, m left. */
const FADE = 1.2;
const SLIDE = 3;

/** How often joining and leaving is decided, s. */
const CONTROL = 0.5;

/** A lane count changing this near a junction is the junction's, m. */
const AT_JUNCTION = 40;

/** Junctions closer together than this count as one, m. */
const MIN_ZONE = 120;

/** Off by more than this many vehicles, a stretch gains or loses one. */
const TOLERANCE = 0.75;

/** Speeds settle to new readings over this, s. */
const SETTLE = 20;

export interface Car {
  /** Distance along, m: the front bumper. */
  s: number;
  /** m/s. */
  v: number;
  lane: number;
  /** Across from the road's line, m, easing to its lane's middle. */
  lateral: number;
  /** Extra across, m: in from the left joining, out to it leaving. */
  slide: number;
  length: number;
  width: number;
  height: number;
  /** Paint, 0..1. */
  tone: number;
  truck: boolean;
  /** Times the stretch's speed this driver goes. */
  keen: number;
  /** Lights come on once the scene's `lights` passes this. */
  switchOn: number;
  /** 0..1: in, or out leaving. */
  fade: number;
  /** Turns off here, m along, fading out. */
  exitAt: number;
  leaving: boolean;
  /** 0..1, for the brake lights. */
  brake: number;
  /**
   * Front to front with the one ahead in its lane, m, over the lanes there:
   * how far apart lights come along the road, lanes merged as they do from
   * afar.
   */
  spacing: number;
  /** Segment it was on, for finding the next. */
  hint: number;
  /** The lane turning off ahead it's decided about, m along, and whether it's taking it. */
  plan: number;
  takes: boolean;
  /** Off this flow at the end of the step: gone, or onto another. */
  off: boolean;
}

/**
 * Where a carriageway gains or loses lanes. Lanes count from the kerb, so
 * at a junction they come and go on the left (a lane that's an off-ramp,
 * or an on-ramp that carries on as one); elsewhere, on the right.
 */
interface LaneChange {
  s: number;
  /** Lanes gained, or lost if negative. */
  delta: number;
  left: boolean;
  /** Lanes after. */
  lanes: number;
}

interface Zone {
  s0: number;
  s1: number;
  /** Traffic can join at its start, and leave at its end. */
  joins: boolean;
  leaves: boolean;
  count: number;
}

/** A car's spacing with no one ahead, m: finite, for the GPU. */
const NO_ONE_AHEAD = 1e4;

const random = (a: number, b: number) => a + Math.random() * (b - a);

/** Greys cars come in: white and silver mostly, then darker. */
const PAINT = [0.86, 0.86, 0.8, 0.66, 0.62, 0.5, 0.4, 0.22, 0.16, 0.08];

function makeCar(town: boolean): Car {
  const truck = Math.random() < (town ? 0.03 : 0.07);

  return {
    s: 0,
    v: 0,
    lane: 0,
    lateral: 0,
    slide: 0,
    length: truck ? random(9, 16) : random(4.2, 5.1),
    width: truck ? 2.5 : random(1.75, 1.9),
    height: truck ? random(3.4, 4.1) : random(1.45, 1.75),
    tone: truck
      ? random(0.7, 0.9)
      : PAINT[Math.floor(Math.random() * PAINT.length)],
    truck,
    // A platoon goes at its slowest driver's pace, so most are keener.
    keen: truck ? random(0.9, 0.98) : random(0.97, 1.1),
    switchOn: random(0, 0.7),
    fade: 1,
    exitAt: Infinity,
    leaving: false,
    brake: 0,
    spacing: NO_ONE_AHEAD,
    hint: -1,
    plan: NaN,
    takes: false,
    off: false,
  };
}

/** One carriageway's traffic. */
class Flow {
  readonly road: Carriageway;
  readonly bins: Bins;
  /** Front first. */
  cars: Car[] = [];
  /** Speed now, and what it's settling to, m/s by bin. */
  readonly speed: Float32Array;
  readonly target: Float32Array;
  /** Vehicles a metre in each lane, by bin. */
  readonly density: Float32Array;
  /** Times `speed` drivers want to go, by bin: more in a queue. */
  readonly eager: Float32Array;
  readonly zones: Zone[];
  readonly changes: LaneChange[] = [];
  /**
   * Where traffic turns off onto other carriageways, and how much: in the
   * lanes that leave there, or (`byLane` false) a share of the left two.
   */
  readonly diverges: {
    s: number;
    into: Flow;
    share: number;
    byLane: boolean;
  }[] = [];
  /** The carriageway this one runs into at its end. */
  into?: { flow: Flow; s: number };
  /** Whether traffic starts on it from another, not from nowhere. */
  fed = false;
  /** Per lane: how far behind the last car the next starts, m. */
  private readonly spacing: number[];

  constructor(road: Carriageway, roads: Roads, index: TileIndex) {
    this.road = road;
    this.bins = createBins(road, index);
    this.speed = new Float32Array(this.bins.count);
    this.target = new Float32Array(this.bins.count);
    this.density = new Float32Array(this.bins.count);
    this.eager = new Float32Array(this.bins.count).fill(1);
    this.spacing = Array.from({ length: road.maxLanes }, () => 0);

    const { joins, leaves } = roads.junction;
    const marks = [{ s: 0, kind: joins }, ...road.junctions];
    const zones: Zone[] = [];
    marks.forEach((mark, k) => {
      const end = marks[k + 1] ?? { s: road.length, kind: leaves };
      const last = zones[zones.length - 1];

      if (last && mark.s - last.s0 < MIN_ZONE) {
        last.s1 = end.s;
        last.leaves = (end.kind & leaves) !== 0;
      } else {
        zones.push({
          s0: mark.s,
          s1: end.s,
          joins: (mark.kind & joins) !== 0,
          leaves: (end.kind & leaves) !== 0,
          count: 0,
        });
      }
    });
    this.zones = zones;

    for (let i = 1; i < road.count - 1; i++) {
      const delta = road.lanes[i] - road.lanes[i - 1];

      if (!delta) continue;
      const s = road.s[i];
      const kind = delta < 0 ? leaves : joins;

      const left = road.junctions.some(
        (j) => Math.abs(j.s - s) < AT_JUNCTION && (j.kind & kind) !== 0
      );

      this.changes.push({ s, delta, left, lanes: road.lanes[i] });
    }
  }

  /** The index of the first lane change after `s`. */
  changeAfter(s: number) {
    const changes = this.changes;
    let lo = 0;
    let hi = changes.length;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;

      if (changes[mid].s <= s) lo = mid + 1;
      else hi = mid;
    }

    return lo;
  }

  /** A lane turning off ahead of `s` within `reach` that `lane` is in. */
  turnAhead(s: number, lane: number, reach: number) {
    for (let k = this.changeAfter(s); k < this.changes.length; k++) {
      const change = this.changes[k];

      if (change.s > s + reach) break;

      if (change.left && change.delta < 0 && lane < -change.delta) {
        return change;
      }
    }

    return null;
  }

  /** How likely traffic in a lane turning off at `change` takes it. */
  takesAt(change: LaneChange) {
    const d = this.diverges.find(
      (d) => d.byLane && Math.abs(d.s - change.s) < AT_JUNCTION
    );

    if (!d) return TAKES_TURN;

    return Math.min(
      (d.share * (change.lanes - change.delta)) / -change.delta,
      1
    );
  }

  /** Past any lanes added on the left just ahead of `s`, for joining there. */
  pastAdded(s: number) {
    for (let k = this.changeAfter(s); k < this.changes.length; k++) {
      const change = this.changes[k];

      if (change.s > s + AT_JUNCTION * 1.5) break;

      if (change.left && change.delta > 0) s = change.s + 0.5;
    }

    return s;
  }

  private bin(s: number) {
    return Math.min(Math.max(Math.floor(s / BIN), 0), this.bins.count - 1);
  }

  speedAt(s: number) {
    return this.speed[this.bin(s)];
  }

  /** How fast drivers want to go at `s`, m/s. */
  wantedAt(s: number) {
    const b = this.bin(s);

    return this.speed[b] * this.eager[b];
  }

  lanesAt(s: number) {
    return this.bins.lanes[this.bin(s)];
  }

  isTown(s: number) {
    return this.bins.town[this.bin(s)] === 1;
  }

  /**
   * Where `lane` next ends on the right, from `s` up to `reach` on; else
   * Infinity. (Lanes ending on the left turn off.)
   */
  laneEnd(s: number, lane: number, reach: number) {
    for (let k = this.changeAfter(s); k < this.changes.length; k++) {
      const change = this.changes[k];

      if (change.s > s + reach) break;

      if (!change.left && change.lanes <= lane) return change.s;
    }

    return Infinity;
  }

  /** Vehicles there should be from s0 to s1, all lanes. */
  expected(s0: number, s1: number) {
    let sum = 0;

    for (let b = this.bin(s0); b <= this.bin(s1); b++) {
      const overlap = Math.min(s1, (b + 1) * BIN) - Math.max(s0, b * BIN);

      if (overlap > 0) sum += this.density[b] * this.bins.lanes[b] * overlap;
    }

    return sum;
  }

  /** The index of the first car at or behind `s`. */
  indexAt(s: number) {
    const cars = this.cars;
    let lo = 0;
    let hi = cars.length;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;

      if (cars[mid].s > s) lo = mid + 1;
      else hi = mid;
    }

    return lo;
  }

  /** The nearest cars ahead of and behind `s` in `lane`, but `skip`. */
  neighbours(s: number, lane: number, skip?: Car) {
    const cars = this.cars;
    const at = this.indexAt(s);
    let ahead: Car | null = null;
    let behind: Car | null = null;

    for (let i = at - 1; i >= 0 && i >= at - 60; i--) {
      if (cars[i].lane === lane && cars[i] !== skip) {
        ahead = cars[i];
        break;
      }
    }

    for (let i = at; i < cars.length && i < at + 60; i++) {
      if (cars[i].lane === lane && cars[i] !== skip) {
        behind = cars[i];
        break;
      }
    }

    return { ahead, behind };
  }

  /**
   * Whether `car` has room in `lane` where it is, at its speed: with gaps
   * cut to `slack` of what's comfortable, for a lane that's ending.
   */
  fits(car: Car, lane: number, skip?: Car, slack = 1) {
    const { ahead, behind } = this.neighbours(car.s, lane, skip);
    const gapAhead = ahead ? ahead.s - ahead.length - car.s : Infinity;
    const gapBehind = behind ? car.s - car.length - behind.s : Infinity;

    return (
      gapAhead > (MIN_GAP + car.v * 0.6) * slack &&
      gapBehind > (MIN_GAP + (behind?.v ?? 0) * 0.6) * slack
    );
  }

  /** Puts a car in, in order. */
  insert(car: Car) {
    const cars = this.cars;
    let i = cars.length;
    cars.push(car);

    while (i > 0 && cars[i - 1].s < car.s) {
      cars[i] = cars[i - 1];
      i--;
    }

    cars[i] = car;
  }

  /** A new car starting at `s` in `lane`. */
  private start(s: number, lane: number) {
    const car = makeCar(this.isTown(s));
    car.s = s;
    car.lane = lane;
    car.v = this.speedAt(s) * car.keen;
    car.lateral = this.road.laneCentre(this.road.locate(s), lane);

    return car;
  }

  /**
   * Fills the road as busy as it should be at the speeds it has, with up
   * to `budget` cars. Returns how many.
   */
  fill(budget: number) {
    const cars: Car[] = [];

    for (let lane = 0; lane < this.road.maxLanes; lane++) {
      let s = this.road.length - random(0, 30);

      while (s > 0 && cars.length < budget) {
        if (this.lanesAt(s) <= lane) {
          s -= BIN;
          continue;
        }

        const car = this.start(s, lane);
        cars.push(car);
        const k = this.density[this.bin(s)];
        const spacing = Math.max(1 / Math.max(k, 1e-4), car.length + MIN_GAP);
        s -= spacing * random(0.7, 1.3);
      }
    }

    this.cars = cars.sort((a, b) => b.s - a.s);

    return cars.length;
  }

  /** A new car joining at `s` from the left, if there's room for one. */
  join(at: number) {
    const s = this.pastAdded(at);
    const lanes = this.lanesAt(s);
    const car = this.start(s, 0);

    for (let lane = 0; lane < lanes; lane++) {
      car.lane = lane;

      if (!this.fits(car, lane)) continue;
      const { ahead } = this.neighbours(s, lane);

      if (ahead) car.v = Math.min(car.v, ahead.v + 1);
      car.lateral = this.road.laneCentre(this.road.locate(s), lane);
      car.slide = -SLIDE;
      car.fade = 0;
      this.insert(car);

      return true;
    }

    return false;
  }

  /** New traffic onto the start of the road, lane by lane, as busy as it should be. */
  feed(rearmost: (Car | null)[]) {
    for (let lane = 0; lane < this.lanesAt(0); lane++) {
      const last = rearmost[lane];

      if (!this.spacing[lane]) {
        const k = this.density[0];
        this.spacing[lane] =
          Math.max(1 / Math.max(k, 1e-4), 7) * random(0.6, 1.4);
      }

      const room = last ? last.s - last.length : Infinity;

      if (room > this.spacing[lane]) {
        const car = this.start(0, lane);

        if (last) car.v = Math.min(car.v, last.v + 2);
        car.fade = 0;
        this.cars.push(car);
        this.spacing[lane] = 0;
      }
    }
  }
}

/** Traffic on every carriageway, stepped each frame. */
export class Traffic {
  readonly flows: Flow[];
  private readonly maxCars: number;
  private sinceControl = 0;
  private filled = false;

  constructor(roads: Roads, index: TileIndex, maxCars: number) {
    this.maxCars = maxCars;
    this.flows = roads.carriageways.map((c) => new Flow(c, roads, index));
    const byName = new Map(this.flows.map((f) => [f.road.name, f]));

    for (const flow of this.flows) {
      const { into, from } = flow.road;

      if (into) flow.into = { flow: byName.get(into.name)!, s: into.s };

      if (from) {
        const parent = byName.get(from.name)!;
        parent.diverges.push({
          s: from.s,
          into: flow,
          share: 0.5,
          byLane: parent.changes.some(
            (c) => c.left && c.delta < 0 && Math.abs(c.s - from.s) < AT_JUNCTION
          ),
        });
        flow.fed = true;
      }
    }
  }

  get count() {
    return this.flows.reduce((n, f) => n + f.cars.length, 0);
  }

  /**
   * New speeds, from NZTA or forced, at the scene's time of day. The first
   * fills the roads; after that, traffic settles to them.
   */
  setConditions(speeds: TrafficSpeeds | null, override: Override, date: Date) {
    for (const flow of this.flows) {
      fillSpeeds(flow.road, flow.bins, speeds, override, flow.target);

      if (!this.filled) flow.speed.set(flow.target);
      fillDensity(flow.bins, flow.target, date, flow.density, flow.eager);
    }

    // Where SH2 leaves SH1, as many turn off as SH2 should carry.
    for (const flow of this.flows) {
      for (const d of flow.diverges) {
        const s = Math.max(d.s - 2 * BIN, 0);
        const before = flow.expected(s, s + BIN) * flow.speedAt(s);
        const after = d.into.expected(0, BIN) * d.into.speedAt(0);
        d.share = Math.min(
          Math.max(after / Math.max(before, 1e-6), 0.15),
          0.85
        );
      }
    }

    if (!this.filled) {
      this.filled = true;
      let budget = this.maxCars;

      for (const flow of this.flows) budget -= flow.fill(budget);
    }
  }

  step(frame: number) {
    if (!this.filled) return;
    const dt = Math.min(frame, MAX_FRAME);
    const steps = Math.ceil(dt / STEP);

    for (let k = 0; k < steps; k++) this.advance(dt / steps);
    this.sinceControl += dt;

    if (this.sinceControl >= CONTROL) {
      this.sinceControl = 0;
      let room = this.maxCars - this.count;

      for (const flow of this.flows) room -= this.control(flow, room);
    }
  }

  private advance(dt: number) {
    const settle = Math.min(dt / SETTLE, 1);

    for (const { speed, target } of this.flows) {
      for (let b = 0; b < speed.length; b++) {
        speed[b] += (target[b] - speed[b]) * settle;
      }
    }

    const moving: [Flow, Car][] = [];

    for (const flow of this.flows) this.drive(flow, dt, moving);

    for (const [flow, car] of moving) {
      car.off = false;
      flow.insert(car);
    }
  }

  /**
   * Every car on `flow` follows the one ahead in its lane, for `dt`. Cars
   * onto other carriageways go into `moving`.
   */
  private drive(flow: Flow, dt: number, moving: [Flow, Car][]) {
    const { road } = flow;
    const cars = flow.cars;

    // Keep front-first order: cars only pass each other in other lanes.
    for (let i = 1; i < cars.length; i++) {
      const car = cars[i];
      let j = i;

      while (j > 0 && cars[j - 1].s < car.s) {
        cars[j] = cars[j - 1];
        j--;
      }

      cars[j] = car;
    }

    /** The car last moved in each lane: ahead of the next one there. */
    const leaders: (Car | null)[] = Array.from(
      { length: road.maxLanes },
      () => null
    );

    let dropped = false;

    for (const car of cars) {
      const lanesHere =
        road.lanes[car.hint < 0 ? road.locate(car.s) : car.hint];

      if (car.lane >= lanesHere) car.lane = Math.max(lanesHere - 1, 0);
      const end = flow.laneEnd(car.s, car.lane, MERGE_AHEAD);
      const turn = flow.turnAhead(car.s, car.lane, MERGE_AHEAD);

      if (turn && turn.s !== car.plan) {
        car.plan = turn.s;
        car.takes = Math.random() < flow.takesAt(turn);
      }

      if (end < Infinity && car.lane > 0) {
        // Its lane's ending: over when there's room, taking less as it
        // runs out, as drivers zip in.
        const slack = Math.min(Math.max((end - car.s) / MERGE_AHEAD, 0.15), 1);

        if (flow.fits(car, car.lane - 1, car, slack)) car.lane--;
      } else if (turn && !car.takes) {
        // Its lane turns off, and it isn't: over to the right.
        const slack = Math.min(
          Math.max((turn.s - car.s) / MERGE_AHEAD, 0.15),
          1
        );

        if (flow.fits(car, car.lane + 1, car, slack)) car.lane++;
      } else if (Math.random() < dt / CHANGE_EVERY) {
        this.considerChange(flow, car, leaders);
      }

      const leader = leaders[car.lane];
      const ahead = car.s + LOOKAHEAD + car.v * LOOKAHEAD_TIME;

      const v0 = Math.max(
        Math.min(flow.wantedAt(car.s), flow.wantedAt(ahead)) * car.keen,
        0.5
      );

      let gap = leader ? leader.s - leader.length - car.s : Infinity;

      car.spacing = leader
        ? (leader.s - car.s) / Math.max(lanesHere, 1)
        : NO_ONE_AHEAD;

      // Still in a lane that's ending, with no room to leave it: stop short.
      const stop = flow.laneEnd(car.s, car.lane, MERGE_AHEAD);

      if (stop < Infinity) gap = Math.min(gap, stop - 3 - car.s);
      const dv = leader ? car.v - leader.v : 0;

      const wanted =
        MIN_GAP +
        Math.max(
          0,
          car.v * HEADWAY +
            (car.v * dv) / (2 * Math.sqrt(ACCELERATION * BRAKING))
        );

      let a =
        gap > 0.1
          ? ACCELERATION * (1 - (car.v / v0) ** 4 - (wanted / gap) ** 2)
          : -EMERGENCY;

      a = Math.min(Math.max(a, -EMERGENCY), ACCELERATION);
      car.v = Math.max(car.v + a * dt, 0);
      const before = car.s;
      car.s += car.v * dt;
      const braking = a < -0.6 || car.v < 1.5 ? 1 : 0;
      car.brake += (braking - car.brake) * Math.min(dt * 4, 1);

      // Toward its lane's middle; in from, or out to, the left.
      car.hint = road.locate(car.s, car.hint);
      const centre = road.laneCentre(car.hint, car.lane);
      const sideways = LANE_CHANGE * dt;
      car.lateral += Math.min(
        Math.max(centre - car.lateral, -sideways),
        sideways
      );
      const slide = (SLIDE / FADE) * dt;

      if (car.leaving) {
        car.slide = Math.max(car.slide - slide, -SLIDE);
        car.fade -= dt / FADE;
      } else {
        car.slide = Math.min(car.slide + slide, 0);
        car.fade = Math.min(car.fade + dt / FADE, 1);

        if (car.s >= car.exitAt) car.leaving = true;
      }

      if (car.leaving && car.fade <= 0) {
        car.off = dropped = true;
        continue;
      }

      // Past a change in lanes: renumbered, or off with the lane.
      for (let k = flow.changeAfter(before); k < flow.changes.length; k++) {
        const change = flow.changes[k];

        if (change.s > car.s) break;

        if (!change.left) {
          // Still in a lane that's ended on the right: in, regardless.
          if (car.lane >= change.lanes) car.lane = change.lanes - 1;
        } else if (
          change.delta > 0 ||
          car.lane >= -change.delta ||
          !(car.plan === change.s && car.takes)
        ) {
          // Those not turning off, renumbered (squeezing in if need be).
          car.lane = Math.max(car.lane + change.delta, 0);
        } else if (!car.leaving) {
          // Its lane turns off here: onto the road it goes to, if any.
          const d = flow.diverges.find(
            (d) => d.byLane && Math.abs(d.s - change.s) < AT_JUNCTION
          );

          if (d) {
            car.off = dropped = true;
            car.s = Math.max(car.s - d.s, 0);
            this.moveOnto(d.into, car, moving, car.lane);
            break;
          }

          car.leaving = true;
          car.exitAt = change.s;
        }
      }

      if (car.off) continue;

      if (car.s >= road.length) {
        car.off = dropped = true;

        // On into the road it merges with, in the kerb lane.
        if (flow.into && !car.leaving) {
          const next = flow.into.flow;
          car.s = next.pastAdded(flow.into.s + car.s - road.length);
          this.moveOnto(next, car, moving, 0);
        }

        continue;
      }

      // Turning off onto another carriageway, from the left lanes.
      for (const d of flow.diverges) {
        if (d.byLane || before >= d.s || car.s < d.s || car.lane > 1) continue;

        if (car.leaving) continue;

        if (Math.random() < d.share / Math.min(lanesHere, 2)) {
          car.off = dropped = true;
          car.s -= d.s;
          this.moveOnto(d.into, car, moving);
        }
      }

      // Leaving, it's out of the way already.
      if (!car.off && !car.leaving) leaders[car.lane] = car;
    }

    if (dropped) flow.cars = cars.filter((car) => !car.off);

    if (!flow.fed) flow.feed(leaders);
  }

  /** Onto another carriageway, in `lane` or the nearest it has. */
  private moveOnto(flow: Flow, car: Car, moving: [Flow, Car][], lane = 0) {
    car.hint = flow.road.locate(car.s);
    car.lane = Math.min(lane, flow.road.lanes[car.hint] - 1);
    car.lateral = flow.road.laneCentre(car.hint, car.lane);
    moving.push([flow, car]);
  }

  /** Into the faster lane beside, or back to the left when there's room. */
  private considerChange(flow: Flow, car: Car, leaders: (Car | null)[]) {
    const lanes = flow.lanesAt(car.s);

    const gapIn = (lane: number) => {
      const leader = leaders[lane];

      return leader ? leader.s - leader.length - car.s : Infinity;
    };

    const own = gapIn(car.lane);
    let best = car.lane;
    let bestGain = 20;

    for (const lane of [car.lane - 1, car.lane + 1]) {
      if (lane < 0 || lane >= lanes) continue;

      // Keep left unless passing.
      const gain =
        Math.min(gapIn(lane), 500) -
        Math.min(own, 500) +
        (lane < car.lane ? 15 : -15);

      if (gain > bestGain) {
        best = lane;
        bestGain = gain;
      }
    }

    if (best !== car.lane && flow.fits(car, best, car)) car.lane = best;
  }

  /**
   * Joining where a stretch has too few for how busy it should be, and
   * leaving where it has too many: up to `room` new cars. Returns how many.
   */
  private control(flow: Flow, room: number) {
    const { zones, cars } = flow;

    for (const zone of zones) zone.count = 0;
    let z = zones.length - 1;

    for (const car of cars) {
      while (z > 0 && car.s < zones[z].s0) z--;

      if (!car.leaving && car.exitAt === Infinity) zones[z].count++;
    }

    let joined = 0;

    for (const zone of zones) {
      const expected = flow.expected(zone.s0, zone.s1);

      if (zone.count < expected - TOLERANCE && zone.joins) {
        if (joined < room && flow.join(Math.min(zone.s0 + 5, zone.s1))) {
          joined++;
        }
      } else if (zone.count > expected + TOLERANCE && zone.leaves) {
        // The car furthest along, kerb lane first, turns off at the end.
        let pick: Car | null = null;

        for (let i = flow.indexAt(zone.s1); i < cars.length; i++) {
          const car = cars[i];

          if (car.s < zone.s0) break;

          if (car.leaving || car.exitAt !== Infinity) continue;

          if (!pick || car.lane < pick.lane) pick = car;

          if (pick.lane === 0) break;
        }

        if (pick) pick.exitAt = Math.max(zone.s1, pick.s + 10);
      }
    }

    return joined;
  }
}
