import { FOLDED, TreeBirds } from "./flits";
import {
  type Flock,
  hashed,
  type Habit,
  PERCH,
  type Plan,
  restingAt,
} from "./habits";
import type { PerchGrid } from "./perches";

// A flock's birds, flown each frame after where its plan says it's headed
// (./habits.ts). In the air each bird flies its own way: it makes for a
// point some way on along the flock's path, keeps off the few flockmates
// nearest it, turns the way they're going and stays in with them, and
// strays a little of its own accord; it can only turn so tightly, so a
// flock that overruns where it's headed wheels round. No bird has a place
// in the flock to keep: the flock's shape is what its birds make of it.
// (Reynolds' boids, with the nearest few flockmates rather than all within
// a distance, as starlings were found to: Ballerini et al., 2008.) Coming
// down, each glides to its own spot and sits. Cheap, not exact: the
// nearest few are kept from frame to frame and bettered a little each
// frame, not searched for. Birds that work the trees (small songbirds,
// finches) are flown another way: ./flits.ts.

/** The flockmates nearest it that each bird minds. */
const NEIGHBOURS = 6;

/** How hard a bird coming down turns for its spot, per second. */
const STEER = 1.6;

/** The flock makes for a point this far on along its path, s of flying. */
const LEAD = 5;

/**
 * A bird's own cruising speed is within this of its kind's; and behind
 * or ahead of where the flock's headed, it flies this much slower or
 * faster than that at most.
 */
const PACE = 0.08;
const SLOWEST = 0.72;
const FASTEST = 1.32;

/** How much its neighbours' way counts, to the flock's path's 1. */
const ALIGN = 1.2;

/** Nearer a neighbour than its kind's spacing, it veers off this hard. */
const KEEP_OFF = 1.6;

/** Further than this many spacings from its neighbours' middle, it closes. */
const COMFY = 1.4;

/** How far off its way a bird strays of its own accord, of its speed. */
const WANDER = 0.45;

/** How fast it turns for the way it wants, per second per radian off. */
const TURN = 2;

/**
 * The hardest a bird of a metre's wingspan turns, m/s² across its way:
 * smaller birds turn harder, as the root of their span. A guess: gulls
 * wheel in circles some tens of metres across.
 */
const AGILITY = 4.5;

/** How fast it takes up the speed it wants, per second. */
const QUICKEN = 1.2;

/** It rises and falls within its height by this much of the kind's band. */
const SWELL = 0.22;

/**
 * A flock first seen is flown this long unseen before, s, in steps this
 * long: so it's as it would be had it been flying all along. About as
 * long as its birds take to draw in from where they're put.
 */
export const WARM = 10;
const WARM_STEP = 0.2;

/** A bird is down this near its spot, m. */
const LANDED = 1.5;

/** A bird looks this far ahead for what it has to climb over, s. */
const LOOK_AHEAD = 2;

/** Settled birds take off this far apart, s: not all at once. */
const STAGGER = 0.08;

/** Up to how hard a bird banks into a turn, radians. */
const MOST_BANK = 0.9;

/** Positions kept behind each bird for its trail, this often, s. */
export const TRAIL_POINTS = 15;
export const TRAIL_EVERY = 0.2;

/** What a bird's nearest flockmates come to: see FlockSim.look. */
const around = { n: 0, vx: 0, vz: 0, x: 0, z: 0, offX: 0, offY: 0, offZ: 0 };

/** How far each of them is from it, m, squared. */
const reach = new Float32Array(NEIGHBOURS);

/** The world below a point, m: ground or sea. */
export type Surface = (x: number, z: number) => number;

export class FlockSim {
  readonly n: number;
  /** Per bird: x, y, z. */
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  /**
   * Per bird: its own place about the flock's goal, x, y (up), z. Where
   * it comes down, and how high it flies; in the air it keeps no place.
   */
  private readonly offset: Float32Array;
  /**
   * Per bird, its own: cruising speed, of its kind's; how fast it strays
   * one way and the other, two rates, radians a second; and how fast it
   * rises and falls.
   */
  private readonly own: Float32Array;
  /** Per bird: the flockmates nearest it, as last found; -1, none. */
  private readonly near: Int16Array;
  /** How far across the flock's birds start out, and settle, m. */
  private readonly spread: number;
  /** The hardest its birds turn, m/s² across their way. */
  private readonly agility: number;
  /** For picking flockmates to look at: the same each run. */
  private dice: number;
  /** Per bird: down where it rests, and the height it sits at. */
  readonly settled: Uint8Array;
  private readonly seat: Float32Array;
  /** Per bird: wing angle (radians up), bank, heading, flap phase. */
  readonly wing: Float32Array;
  readonly bank: Float32Array;
  readonly heading: Float32Array;
  readonly phase: Float32Array;
  /** Where the flock's middle is, as last stepped: x, y, z. */
  readonly middle = { x: 0, y: 0, z: 0 };
  /** Across the flock, m. */
  extent = 0;
  /**
   * Per bird, where it's been: TRAIL_POINTS positions, x, y, z, in a ring
   * whose newest is at `newest`, each taken at `taken` (s). NaN until the
   * first step: then they're all where it is.
   */
  readonly trail: Float32Array;
  readonly taken = new Float64Array(TRAIL_POINTS).fill(Number.NaN);
  newest = 0;
  /** The birds of a kind that works the trees, flown their own way. */
  private readonly treeBirds?: TreeBirds;
  /** When it was last stepped, s; NaN if never. */
  stepped = Number.NaN;
  /** Being flown up to now, unseen: see arrive. Not to be drawn yet. */
  arriving = false;

  /**
   * `perches`: for a kind that hops, the trees about its site, which it
   * must have some of. `seconds`, the scene's time: where such a kind's
   * birds are depends on it.
   */
  constructor(
    readonly flock: Flock,
    plan: Plan,
    surface: Surface,
    perches?: PerchGrid,
    seconds = 0
  ) {
    if (flock.habit.hops && !perches?.count) {
      throw new Error(`${flock.id}: hoppers need trees`);
    }

    const { birds: n, habit, seed } = flock;
    this.n = n;
    this.position = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.offset = new Float32Array(n * 3);
    this.own = new Float32Array(n * 4);
    this.near = new Int16Array(n * NEIGHBOURS).fill(-1);
    this.agility = AGILITY / Math.sqrt(habit.span);
    this.dice = seed | 1;
    this.settled = new Uint8Array(n);
    this.seat = new Float32Array(n);
    this.wing = new Float32Array(n);
    this.bank = new Float32Array(n);
    this.heading = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.trail = new Float32Array(n * TRAIL_POINTS * 3);

    if (flock.habit.hops && perches) {
      this.treeBirds = new TreeBirds(flock, perches, this);
    }

    // A loose disc as wide as the flock needs for its spacing.
    const spread = habit.spacing * Math.sqrt(n) * 0.8;
    const [low, high] = habit.height;
    this.spread = spread;

    for (let i = 0; i < n; i++) {
      const angle = hashed(seed, 100 + i) * Math.PI * 2;
      const r = Math.sqrt(hashed(seed, 5000 + i)) * spread;
      this.offset[i * 3] = Math.sin(angle) * r;
      this.offset[i * 3 + 1] = low + hashed(seed, 9000 + i) * (high - low);
      this.offset[i * 3 + 2] = Math.cos(angle) * r;
      this.phase[i] = hashed(seed, 13000 + i) * Math.PI * 2;
      this.own[i * 4] = 1 + (hashed(seed, 17000 + i) * 2 - 1) * PACE;
      // Straying one way then the other every few seconds, each its own.
      this.own[i * 4 + 1] = 1.2 + hashed(seed, 21000 + i) * 1.2;
      this.own[i * 4 + 2] = 0.35 + hashed(seed, 25000 + i) * 0.5;
      this.own[i * 4 + 3] = 0.7 + hashed(seed, 29000 + i) * 0.9;
    }

    this.place(plan, surface, seconds);
  }

  /**
   * Puts every bird where the plan says, as if it had been all along; the
   * birds of a kind that hops, in the trees they'd be at at `seconds`.
   */
  place(plan: Plan, surface: Surface, seconds = 0) {
    if (this.treeBirds) this.treeBirds.perchAll(seconds);
    else this.formUp(plan, surface);

    // No trails across a jump: each starts afresh where its bird is now.
    for (let i = 0; i < this.n; i++) {
      for (let k = 0; k < TRAIL_POINTS; k++) {
        this.trail.set(
          this.position.subarray(i * 3, i * 3 + 3),
          (i * TRAIL_POINTS + k) * 3
        );
      }
    }

    this.taken.fill(Number.NaN);
    this.measure();
  }

  /**
   * Starts the flock toward where `planOf` says it is at `time`, s, as it
   * would be had it been flown all along: put where it was `seconds`
   * before (on the water or the ground, if it's not been up that long),
   * to be flown on from there by catchUp, unseen, so that when it's
   * shown each bird's about its own business and has its trail behind
   * it. Less `seconds` is quicker, and looks it close up. Birds that work
   * the trees, and a flock that's down, are put straight where they are.
   * `planOf` may hand back the same plan each time, written over.
   */
  arrive(
    planOf: (time: number) => Plan,
    surface: Surface,
    time: number,
    seconds = WARM
  ) {
    const now = planOf(time);
    const { flying, since } = now;

    if (this.treeBirds || !flying) {
      this.place(now, surface, time);
      this.stepped = time;
      this.arriving = false;

      return;
    }

    const back = Math.min(since, seconds);

    this.place(
      since <= seconds
        ? restingAt(this.flock, { ...now })
        : planOf(time - back),
      surface
    );

    this.stepped = time - back;
    this.arriving = true;
  }

  /**
   * Flies a flock that's arriving on toward `time`, s, by `steps` steps at
   * most: a few a frame, so no frame's held up by it. True once it's
   * there, and to be shown.
   */
  catchUp(
    planOf: (time: number) => Plan,
    surface: Surface,
    time: number,
    steps: number,
    bare: Surface = surface
  ) {
    for (let s = 0; s < steps && this.arriving; s++) {
      const last = time - this.stepped <= WARM_STEP * 1.5;
      const t = last ? time : this.stepped + WARM_STEP;

      this.step(Math.max(t - this.stepped, 0), planOf(t), surface, t, bare);
      this.arriving = !last;
    }

    return !this.arriving;
  }

  /**
   * Flockers about the goal: up, each going its own way a little, or
   * settled in its place.
   */
  private formUp(plan: Plan, surface: Surface) {
    const { habit, seed } = this.flock;

    for (let i = 0; i < this.n; i++) {
      const x = plan.x + this.offset[i * 3];
      const z = plan.z + this.offset[i * 3 + 2];
      const below = restingHeight(habit, surface(x, z));

      this.position[i * 3] = x;
      this.position[i * 3 + 2] = z;
      this.heading[i] = plan.heading;

      if (plan.flying) {
        const way = plan.heading + (hashed(seed, 33000 + i) - 0.5) * 0.7;
        const pace = habit.speed * this.own[i * 4];

        this.position[i * 3 + 1] = surface(x, z) + this.offset[i * 3 + 1];
        this.velocity.set(
          [Math.sin(way) * pace, 0, Math.cos(way) * pace],
          i * 3
        );
        this.heading[i] = way;
        this.settled[i] = 0;
      } else {
        this.position[i * 3 + 1] = below;
        this.seat[i] = below;
        this.velocity.fill(0, i * 3, i * 3 + 3);
        this.settled[i] = 1;
        this.wing[i] = FOLDED;
      }
    }
  }

  /**
   * Flies the birds on `dt` seconds toward `plan`'s goal over `surface`:
   * `time`, s, the scene's, for their wingbeats. `bare`, the ground or
   * sea without the buildings on it: hoppers' trees stand among them.
   */
  step(
    dt: number,
    plan: Plan,
    surface: Surface,
    time: number,
    bare: Surface = surface
  ) {
    this.stepped = time;

    if (this.treeBirds) {
      this.treeBirds.step(dt, plan.flying, surface, bare, time);
      this.measure();
      this.remember(time);

      return;
    }

    const { habit, seed } = this.flock;
    const { n, position: p, velocity: v } = this;
    const speed = habit.speed;
    const [low, high] = habit.height;

    // Where the flock's making for: some way on along its path, so its
    // birds are all coming up behind it, not milling about it.
    const lead = speed * LEAD + this.spread * 0.5;
    const aheadX = plan.x + Math.sin(plan.heading) * lead;
    const aheadZ = plan.z + Math.cos(plan.heading) * lead;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;

      if (this.settled[i]) {
        // Off again, one after another, each its own way a little.
        if (plan.flying && plan.since > i * STAGGER) {
          const way = this.heading[i] + (hashed(seed, 33000 + i) - 0.5) * 1.2;

          this.settled[i] = 0;
          this.heading[i] = way;
          v[i3] = Math.sin(way) * speed * 0.5;
          v[i3 + 1] = speed * 0.3;
          v[i3 + 2] = Math.cos(way) * speed * 0.5;
        } else {
          // Bobbing, on the water.
          p[i3 + 1] =
            this.seat[i] +
            (habit.rests === "water"
              ? Math.sin(time * 1.3 + this.phase[i]) * 0.08
              : 0);
          this.wing[i] = FOLDED;
          this.bank[i] = 0;
          continue;
        }
      }

      // What's under it, and what it's coming to: it climbs before a hill,
      // or a tower, rather than into it.
      const under = Math.max(
        surface(p[i3], p[i3 + 2]),
        surface(p[i3] + v[i3] * LOOK_AHEAD, p[i3 + 2] + v[i3 + 2] * LOOK_AHEAD)
      );

      this.look(i);

      if (plan.flying) {
        const i4 = i * 4;
        const cruise = speed * this.own[i4];
        const flat = Math.hypot(v[i3], v[i3 + 2]);
        const was = flat > 0.3 ? Math.atan2(v[i3], v[i3 + 2]) : this.heading[i];
        const fx = Math.sin(was);
        const fz = Math.cos(was);

        // The way it wants to go, as a velocity: on after the flock,
        // faster the further behind it is.
        const tx = aheadX - p[i3];
        const tz = aheadZ - p[i3 + 2];
        const far = Math.hypot(tx, tz) || 1;

        const want =
          cruise *
          Math.min(Math.max(far / lead, SLOWEST + 0.03), FASTEST - 0.02);

        let wx = (tx / far) * want;
        let wz = (tz / far) * want;
        let weight = 1;

        if (around.n > 0) {
          // Its neighbours' way; in with them; and off the nearest.
          wx += (around.vx / around.n) * ALIGN;
          wz += (around.vz / around.n) * ALIGN;
          weight += ALIGN;

          const cx = around.x / around.n - p[i3];
          const cz = around.z / around.n - p[i3 + 2];
          const out = Math.hypot(cx, cz) || 1;
          const loose = out / habit.spacing - COMFY;

          if (loose > 0) {
            const pull = Math.min(loose * 0.3, 0.6) * cruise;
            wx += (cx / out) * pull;
            wz += (cz / out) * pull;
          }

          wx += around.offX * cruise * KEEP_OFF;
          wz += around.offZ * cruise * KEEP_OFF;
        }

        // A little of its own mind: off to one side, then the other.
        const stray =
          (0.6 * Math.sin(time * this.own[i4 + 1] + this.phase[i]) +
            0.4 * Math.sin(time * this.own[i4 + 2] + this.phase[i] * 2.7)) *
          cruise *
          WANDER;

        wx += fz * stray;
        wz -= fx * stray;

        // It turns for that way, as hard as its kind can at most, and
        // takes up the speed of it that's the way it's facing.
        let off = Math.atan2(wx, wz) - was;
        off -= Math.round(off / (Math.PI * 2)) * Math.PI * 2;
        const hardest = this.agility / Math.max(flat, 1);
        const turn = Math.min(Math.max(off * TURN, -hardest), hardest);
        const heading = was + turn * dt;

        const onward = Math.min(
          Math.max((wx * fx + wz * fz) / weight, cruise * SLOWEST),
          cruise * FASTEST
        );

        const pace = flat + (onward - flat) * Math.min(dt * QUICKEN, 1);

        // Its own height over what's under it, rising and falling a little.
        const gy =
          under +
          this.offset[i3 + 1] +
          Math.sin(time * this.own[i4 + 3] + this.phase[i]) *
            (high - low) *
            SWELL +
          around.offY * habit.spacing;

        v[i3] = Math.sin(heading) * pace;
        v[i3 + 1] += ((gy - p[i3 + 1]) * 1.2 - v[i3 + 1] * 1.8) * dt;
        v[i3 + 2] = Math.cos(heading) * pace;
        this.heading[i] = heading;

        this.bank[i] +=
          (Math.min(
            Math.max(Math.atan((turn * pace) / 9.8), -MOST_BANK),
            MOST_BANK
          ) -
            this.bank[i]) *
          Math.min(dt * 4, 1);
      } else if (this.comeDown(i, dt, plan, surface, under)) {
        continue;
      }

      v[i3 + 1] = Math.min(Math.max(v[i3 + 1], -speed * 0.5), speed * 0.4);

      p[i3] += v[i3] * dt;
      p[i3 + 1] += v[i3 + 1] * dt;
      p[i3 + 2] += v[i3 + 2] * dt;

      // Never into the ground or the sea while flying.
      const floor = under + 0.3;

      if (p[i3 + 1] < floor) {
        p[i3 + 1] = floor;
        v[i3 + 1] = Math.max(v[i3 + 1], 0);
      }

      this.wing[i] = wingAt(habit, seed, i, time, this.phase[i], v[i3 + 1]);
    }

    this.measure();
    this.remember(time);
  }

  /**
   * The flockmates nearest bird `i`, into `around`: which way to veer off
   * those too near, the way they're going, and where their middle is. The
   * nearest it knew of last frame, bettered by looking at two more: one
   * at random, and one a neighbour knows of (a neighbour's neighbours are
   * mostly its own).
   */
  private look(i: number) {
    const { n, position: p, velocity: v, near, settled } = this;
    const { spacing } = this.flock.habit;
    const i3 = i * 3;
    const at = i * NEIGHBOURS;

    around.n = 0;
    around.vx = around.vz = around.x = around.z = 0;
    around.offX = around.offY = around.offZ = 0;

    if (n < 2) return;

    for (let k = 0; k < NEIGHBOURS; k++) {
      const j = near[at + k];

      if (j >= 0 && settled[j]) near[at + k] = -1;
      reach[k] = near[at + k] < 0 ? Infinity : this.apart(i3, near[at + k]);
    }

    this.dice = (Math.imul(this.dice, 1664525) + 1013904223) >>> 0;
    const dice = this.dice;
    const known = near[at + ((dice >>> 8) % NEIGHBOURS)];

    for (let c = 0; c < 2; c++) {
      const other =
        c === 0
          ? (dice >>> 16) % n
          : known < 0
            ? -1
            : near[known * NEIGHBOURS + ((dice >>> 4) % NEIGHBOURS)];

      if (other < 0 || other === i || settled[other]) continue;

      let furthest = 0;
      let has = false;

      for (let k = 0; k < NEIGHBOURS; k++) {
        if (near[at + k] === other) has = true;

        if (reach[k] > reach[furthest]) furthest = k;
      }

      if (has) continue;
      const d = this.apart(i3, other);

      if (d < reach[furthest]) {
        near[at + furthest] = other;
        reach[furthest] = d;
      }
    }

    for (let k = 0; k < NEIGHBOURS; k++) {
      const j = near[at + k];

      if (j < 0) continue;
      const j3 = j * 3;
      const d = Math.sqrt(reach[k]) || 0.01;

      if (d < spacing) {
        const push = (spacing - d) / spacing / d;
        around.offX += (p[i3] - p[j3]) * push;
        around.offY += (p[i3 + 1] - p[j3 + 1]) * push;
        around.offZ += (p[i3 + 2] - p[j3 + 2]) * push;
      }

      around.vx += v[j3];
      around.vz += v[j3 + 2];
      around.x += p[j3];
      around.z += p[j3 + 2];
      around.n++;
    }
  }

  /** From the bird at `i3` in the positions to bird `j`, m, squared. */
  private apart(i3: number, j: number) {
    const p = this.position;
    const x = p[i3] - p[j * 3];
    const y = p[i3 + 1] - p[j * 3 + 1];
    const z = p[i3 + 2] - p[j * 3 + 2];

    return x * x + y * y + z * z;
  }

  /**
   * Bird `i` flown `dt` on down toward its own spot where the flock's
   * settling, slowing as it comes in. True once it's down.
   */
  private comeDown(
    i: number,
    dt: number,
    plan: Plan,
    surface: Surface,
    under: number
  ) {
    const { habit } = this.flock;
    const { position: p, velocity: v } = this;
    const i3 = i * 3;
    const speed = habit.speed;
    // Slowing to land, from about three seconds out.
    const arrive = speed * 3;
    const gx = plan.x + this.offset[i3];
    const gz = plan.z + this.offset[i3 + 2];
    const gy = Math.max(restingHeight(habit, surface(gx, gz)), under);
    const dx = gx - p[i3];
    const dy = gy - p[i3 + 1];
    const dz = gz - p[i3 + 2];
    const distance = Math.hypot(dx, dy, dz) || 1;

    if (distance < LANDED) {
      this.settled[i] = 1;
      this.seat[i] = gy;
      p[i3] = gx;
      p[i3 + 1] = gy;
      p[i3 + 2] = gz;
      v.fill(0, i3, i3 + 3);

      return true;
    }

    const want = speed * Math.min(1, distance / arrive);

    v[i3] +=
      (((dx / distance) * want - v[i3]) * STEER + around.offX * speed * 2) * dt;

    v[i3 + 1] +=
      (((dy / distance) * want - v[i3 + 1]) * STEER + around.offY * speed) * dt;

    v[i3 + 2] +=
      (((dz / distance) * want - v[i3 + 2]) * STEER + around.offZ * speed * 2) *
      dt;

    // Still some way off, it doesn't hover; nor go much faster than it
    // cruises.
    const flat = Math.hypot(v[i3], v[i3 + 2]);
    const least = distance > arrive ? speed * 0.6 : 0;
    const limited = Math.min(Math.max(flat, least), speed * 1.5);

    if (flat > 0.01 && limited !== flat) {
      v[i3] *= limited / flat;
      v[i3 + 2] *= limited / flat;
    }

    // Facing the way it's flying; banked into the turn.
    const before = this.heading[i];

    if (flat > 0.3) this.heading[i] = Math.atan2(v[i3], v[i3 + 2]);
    let turn = this.heading[i] - before;
    turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
    const lean = Math.atan(((dt > 0 ? turn / dt : 0) * flat) / 9.8);

    this.bank[i] +=
      (Math.min(Math.max(lean, -MOST_BANK), MOST_BANK) - this.bank[i]) *
      Math.min(dt * 4, 1);

    return false;
  }

  /** Every TRAIL_EVERY, where each bird is, for its trail. */
  private remember(time: number) {
    const fresh = Number.isNaN(this.taken[this.newest]);

    if (!fresh && time - this.taken[this.newest] < TRAIL_EVERY) return;

    const slots = fresh ? TRAIL_POINTS : 1;

    for (let s = 0; s < slots; s++) {
      this.newest = (this.newest + 1) % TRAIL_POINTS;
      this.taken[this.newest] = time;

      for (let i = 0; i < this.n; i++) {
        this.trail.set(
          this.position.subarray(i * 3, i * 3 + 3),
          (i * TRAIL_POINTS + this.newest) * 3
        );
      }
    }
  }

  /** The flock's middle and its size, from where its birds are. */
  private measure() {
    let x = 0;
    let y = 0;
    let z = 0;

    for (let i = 0; i < this.n; i++) {
      x += this.position[i * 3];
      y += this.position[i * 3 + 1];
      z += this.position[i * 3 + 2];
    }

    this.middle.x = x / this.n;
    this.middle.y = y / this.n;
    this.middle.z = z / this.n;

    let far = 0;

    for (let i = 0; i < this.n; i++) {
      far = Math.max(
        far,
        Math.hypot(
          this.position[i * 3] - this.middle.x,
          this.position[i * 3 + 2] - this.middle.z
        )
      );
    }

    this.extent = far * 2;
  }

  /** Over the flock, m/s: its middle's way and speed. */
  mean() {
    let x = 0;
    let y = 0;
    let z = 0;

    for (let i = 0; i < this.n; i++) {
      x += this.velocity[i * 3];
      y += this.velocity[i * 3 + 1];
      z += this.velocity[i * 3 + 2];
    }

    return { x: x / this.n, y: y / this.n, z: z / this.n };
  }

  /** How many of its birds are down. */
  down() {
    let down = 0;

    for (let i = 0; i < this.n; i++) down += this.settled[i];

    return down;
  }
}

/** Where a bird of `habit` sits, over ground or sea at `surface`. */
function restingHeight(habit: Habit, surface: number) {
  return habit.rests === "perch" ? surface + PERCH : surface;
}

/**
 * A bird's wing angle at `time`, s: beating, or held out in a glide for a
 * spell; beating harder climbing, gliding more going down.
 */
function wingAt(
  habit: Habit,
  seed: number,
  i: number,
  time: number,
  phase: number,
  climb: number
) {
  // Spells of a second or so, each bird its own.
  const spell = Math.floor(time / 1.2 + phase);
  const glide = habit.glide + (climb < -0.5 ? 0.3 : climb > 0.5 ? -0.3 : 0);

  if (hashed(seed + spell, i) < glide) return 0.12;

  return Math.sin(time * habit.beat * Math.PI * 2 + phase) * 0.85 + 0.1;
}
