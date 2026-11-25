import { FOLDED, TreeBirds } from "./flits";
import { type Flock, hashed, type Habit, PERCH, type Plan } from "./habits";
import type { PerchGrid } from "./perches";

// A flock's birds, flown each frame toward where its plan says it's headed
// (./habits.ts): each steers for its own place about the flock's goal,
// keeps off a few flockmates picked at random and matches their heading;
// settling, each glides down to its spot and sits. Cheap, not exact:
// a few neighbours a bird a frame, not all of them. Birds that work the
// trees (small songbirds, finches) are flown another way: ./flits.ts.

/** Flockmates each bird looks at a frame. */
const NEIGHBOURS = 4;

/** How hard a bird turns toward where it wants to go, per second. */
const STEER = 1.6;

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

/** The world below a point, m: ground or sea. */
export type Surface = (x: number, z: number) => number;

export class FlockSim {
  readonly n: number;
  /** Per bird: x, y, z. */
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  /** Per bird: its own place about the flock's goal, x, y (up), z. */
  private readonly offset: Float32Array;
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
  private frame = 0;
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

    for (let i = 0; i < n; i++) {
      const angle = hashed(seed, 100 + i) * Math.PI * 2;
      const r = Math.sqrt(hashed(seed, 5000 + i)) * spread;
      this.offset[i * 3] = Math.sin(angle) * r;
      this.offset[i * 3 + 1] = low + hashed(seed, 9000 + i) * (high - low);
      this.offset[i * 3 + 2] = Math.cos(angle) * r;
      this.phase[i] = hashed(seed, 13000 + i) * Math.PI * 2;
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

  /** Flockers in their places about the goal: up, or settled. */
  private formUp(plan: Plan, surface: Surface) {
    const { habit } = this.flock;
    const vx = Math.sin(plan.heading) * habit.speed;
    const vz = Math.cos(plan.heading) * habit.speed;

    for (let i = 0; i < this.n; i++) {
      const x = plan.x + this.offset[i * 3];
      const z = plan.z + this.offset[i * 3 + 2];
      const below = restingHeight(habit, surface(x, z));

      this.position[i * 3] = x;
      this.position[i * 3 + 2] = z;
      this.heading[i] = plan.heading;

      if (plan.flying) {
        this.position[i * 3 + 1] = surface(x, z) + this.offset[i * 3 + 1];
        this.velocity.set([vx, 0, vz], i * 3);
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
    const frame = this.frame++;
    const speed = habit.speed;
    // Slowing to land, from about three seconds out.
    const arrive = speed * 3;

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;

      if (this.settled[i]) {
        // Off again, one after another.
        if (plan.flying && plan.since > i * STAGGER) {
          this.settled[i] = 0;
          v[i3] = Math.sin(this.heading[i]) * speed * 0.5;
          v[i3 + 1] = speed * 0.3;
          v[i3 + 2] = Math.cos(this.heading[i]) * speed * 0.5;
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

      // Where this bird's headed: its place about the goal.
      const gx = plan.x + this.offset[i3];
      const gz = plan.z + this.offset[i3 + 2];

      // What's under it, and what it's coming to: it climbs before a hill,
      // or a tower, rather than into it.
      const under = Math.max(
        surface(p[i3], p[i3 + 2]),
        surface(p[i3] + v[i3] * LOOK_AHEAD, p[i3 + 2] + v[i3 + 2] * LOOK_AHEAD)
      );

      const gy = plan.flying
        ? under + this.offset[i3 + 1]
        : Math.max(restingHeight(habit, surface(gx, gz)), under);

      const dx = gx - p[i3];
      const dy = gy - p[i3 + 1];
      const dz = gz - p[i3 + 2];
      const distance = Math.hypot(dx, dy, dz) || 1;
      const want = speed * (plan.flying ? 1 : Math.min(1, distance / arrive));

      // Down, if it's near its spot and coming in.
      if (!plan.flying && distance < LANDED) {
        this.settled[i] = 1;
        this.seat[i] = gy;
        p[i3] = gx;
        p[i3 + 1] = gy;
        p[i3 + 2] = gz;
        v.fill(0, i3, i3 + 3);
        continue;
      }

      let ax = (dx / distance) * want - v[i3];
      let ay = (dy / distance) * want - v[i3 + 1];
      let az = (dz / distance) * want - v[i3 + 2];
      ax *= STEER;
      ay *= STEER;
      az *= STEER;

      // A few flockmates: keep off them, and go their way.
      let mx = 0;
      let mz = 0;
      let mates = 0;

      for (let k = 0; k < NEIGHBOURS && n > 1; k++) {
        const j = Math.floor(hashed(seed + frame, i * NEIGHBOURS + k) * n);

        if (j === i || this.settled[j]) continue;
        const j3 = j * 3;
        const ox = p[i3] - p[j3];
        const oy = p[i3 + 1] - p[j3 + 1];
        const oz = p[i3 + 2] - p[j3 + 2];
        const apart = Math.hypot(ox, oy, oz) || 0.01;

        if (apart < habit.spacing) {
          const push = ((habit.spacing - apart) / habit.spacing) * speed * 2;
          ax += (ox / apart) * push;
          ay += (oy / apart) * push * 0.5;
          az += (oz / apart) * push;
        }

        mx += v[j3];
        mz += v[j3 + 2];
        mates++;
      }

      if (mates > 0 && plan.flying) {
        ax += (mx / mates - v[i3]) * 0.6;
        az += (mz / mates - v[i3 + 2]) * 0.6;
      }

      // A little of its own mind.
      const wobble = Math.floor(time * 0.7);
      ax += (hashed(seed + wobble, i * 2) - 0.5) * speed * 0.3;
      az += (hashed(seed + wobble, i * 2 + 1) - 0.5) * speed * 0.3;

      v[i3] += ax * dt;
      v[i3 + 1] += ay * dt;
      v[i3 + 2] += az * dt;

      // Flying birds don't hover, or go much faster than they cruise.
      const flat = Math.hypot(v[i3], v[i3 + 2]);
      const least = plan.flying || distance > arrive ? speed * 0.6 : 0;
      const most = speed * 1.5;
      const limited = Math.min(Math.max(flat, least), most);

      if (flat > 0.01 && limited !== flat) {
        v[i3] *= limited / flat;
        v[i3 + 2] *= limited / flat;
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

      // Facing the way it's flying; banked into the turn.
      const before = this.heading[i];

      if (flat > 0.3) this.heading[i] = Math.atan2(v[i3], v[i3 + 2]);
      let turn = this.heading[i] - before;
      turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
      const rate = dt > 0 ? turn / dt : 0;
      const lean = Math.atan((rate * flat) / 9.8);

      this.bank[i] +=
        (Math.min(Math.max(lean, -MOST_BANK), MOST_BANK) - this.bank[i]) *
        Math.min(dt * 4, 1);

      this.wing[i] = wingAt(habit, seed, i, time, this.phase[i], v[i3 + 1]);
    }

    this.measure();
    this.remember(time);
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
