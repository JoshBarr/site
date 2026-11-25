import type { Surface } from "./boids";
import { type Flock, hashed, type Hops, type Patch, patchAt } from "./habits";
import type { PerchGrid } from "./perches";

// The birds that work the trees (small songbirds, finches: habit.hops), as
// they're seen to: a while with a few trees near each other, sitting, then
// flitting to another perch; then off some distance to other trees, and
// the same there (./habits.ts, patchAt). A flock that keeps together
// leaves one after another and flies there together.
//
// Their flights are flown, not drawn: each bird has a heading, a pitch and
// a speed, and turns toward where it wants to go as fast as a bird can
// (after Hoetzlein's Flock2, 2024: what it wants is a turn, not a push;
// its flockmates, the seven nearest it can see, as Ballerini et al. found
// of starlings in 2008). It leaps off the perch, beats up to speed, and
// far enough from landing flies in bursts with its wings shut between
// them, rising and falling as it does (Rayner 1985; Tobalske et al. 1999).
// It comes in under its perch, slowing steadily (Lee et al. 1993), and
// swoops up onto it (KleinHeerenbrink et al. 2022). How hard it can pull,
// turn and brake are guesses that look right.

/** The wings folded at rest, radians below the flat. */
export const FOLDED = -1.35;

const G = 9.8;

/** Of its weight, what its body carries with the wings shut; and held out. */
const SHUT_LIFT = 0.1;
const GLIDE_LIFT = 0.75;

/** Off the perch by its legs at this speed, m/s. */
const LEAP = 2.4;

/** Speeding up and slowing down at most this hard, m/s². */
const PULL = 11;
const BRAKE = 7;

/** Wings shut, the air slows it this much, m/s². */
const SHUT_DRAG = 1;

/** Of gravity along its path, the share that speeds or slows it. */
const FALL = 0.5;

/** Onto the perch at this speed, m/s; and caught this near it, m. */
const TOUCH = 1.2;
const CATCH = 0.3;

/** Facing where it wants to within about this long, s. */
const REACT = 0.25;

/** Turning this fast at most, radians/s, and pulling this many g. */
const TURN = 5;
const LOAD = 3;
const PITCH_RATE = 4;

/** Climbing and diving this steeply at most, radians. */
const CLIMB = 0.85;
const DIVE = -0.75;

/** Coming down to a perch no steeper than this, m a metre. */
const DESCENT = 0.6;

/** Up onto the perch from this far out, m, at this slope. */
const SWOOP_FROM = 7;
const RISE = 0.32;

/** A slow weave either side of the straight way there, radians. */
const WEAVE = 0.12;

/** Flockmates each bird flies by: the nearest it can see. */
const NEIGHBOURS = 7;

/** Blind behind: the cosine of how far round it sees. */
const BLIND = Math.cos((145 * Math.PI) / 180);

/** How much it turns to go its neighbours' way, to keep with them, and off them. */
const ALIGN = 0.6;
const COHERE = 0.15;
const AVOID = 0.8;

/**
 * Behind its neighbours it hurries, ahead it eases: this much of its speed
 * at most, at this far from them, m.
 */
const CATCH_UP = 0.25;
const STRUNG_OUT = 20;

/** Its speed's what it wants within about this long, s. */
const THROTTLE = 0.12;

/** Up to how hard it banks into a turn, radians. */
const MOST_BANK = 0.9;

/** Flights are flown in steps no longer than this, s. */
const STEP = 0.02;

/** A bird looks this far ahead for ground to climb over, s. */
const LOOK_AHEAD = 1.2;

/** Over the roofs on a long flight, if they're no higher than this, m. */
const ROOFS = 25;

/** A flight this long, m, is flown at the kind's height; one this short, straight across. */
const LONG = 60;
const SHORT = 15;

/** Of its flits, the share to another spot in the same tree. */
const SAME_TREE = 0.3;

/** A tree's looked for this far from where a stay's meant to be, m, before anywhere. */
const SEARCH = 64;

/** How it's flying: beating steadily, in a burst of beats, or between bursts. */
const STEADY = 0;
const BURST = 1;
const BOUND = 2;

/** The birds a flock's made of, as it keeps them (./boids.ts). */
interface Birds {
  readonly n: number;
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  readonly settled: Uint8Array;
  readonly wing: Float32Array;
  readonly bank: Float32Array;
  readonly heading: Float32Array;
  readonly phase: Float32Array;
}

const wrap = (angle: number) =>
  angle - Math.round(angle / (Math.PI * 2)) * Math.PI * 2;

const clamp = (value: number, least: number, most: number) =>
  Math.min(Math.max(value, least), most);

const eased = (from: number, to: number, value: number) => {
  const u = clamp((value - from) / (to - from), 0, 1);

  return u * u * (3 - 2 * u);
};

export class TreeBirds {
  private readonly hops: Hops;
  /** Per bird: the tree it's in, or flying to. */
  private readonly tree: Int32Array;
  /** Which of its stays it's at (patchAt), and the tree in the middle of it. */
  private readonly stay: Int32Array;
  private readonly middle: Int32Array;
  /** When it's off to the next stay, s: NaN till it knows there's one. */
  private readonly leaving: Float64Array;
  /** When it'll next flit, s: NaN until it's been seen sitting. */
  private readonly wake: Float64Array;
  /** Flights made, and bursts of beating: so each is its own. */
  private readonly flown: Uint32Array;
  private readonly bursts: Uint32Array;
  /** Its flight: from x, y, z to x, y, z; how far across; begun, and given up, s. */
  private readonly from: Float32Array;
  private readonly to: Float32Array;
  private readonly across: Float32Array;
  private readonly began: Float64Array;
  private readonly lost: Float64Array;
  /** Off to another stay, not flitting. */
  private readonly far: Uint8Array;
  /** Its speed along its path, m/s; its pitch; the speed and height it means to keep. */
  private readonly speed: Float32Array;
  private readonly pitch: Float32Array;
  private readonly cruise: Float32Array;
  private readonly height: Float32Array;
  /**
   * How it's flying; since when, for how long, s. Its rise and fall about
   * its path, m/s: now, and from what to what over a burst; how fast it's
   * rising as it shuts its wings; and how long it'll keep them shut.
   */
  private readonly gait: Uint8Array;
  private readonly gaitFrom: Float64Array;
  private readonly gaitFor: Float32Array;
  private readonly bob: Float32Array;
  private readonly bobFrom: Float32Array;
  private readonly bobTo: Float32Array;
  private readonly toss: Float32Array;
  private readonly shut: Float32Array;
  /**
   * What its flockmates ask of it: a turn, yaw and pitch, radians; and
   * how much faster to go, of its speed.
   */
  private readonly social: Float32Array;
  private readonly patch: Patch = { index: 0, since: 0, x: 0, z: 0 };
  private readonly nearest = new Int32Array(NEIGHBOURS);
  private readonly apart = new Float32Array(NEIGHBOURS);

  constructor(
    private readonly flock: Flock,
    private readonly trees: PerchGrid,
    private readonly birds: Birds
  ) {
    // SAFETY: only made for a kind with hops (./boids.ts).
    this.hops = flock.habit.hops as Hops;

    const { n } = birds;
    this.tree = new Int32Array(n);
    this.stay = new Int32Array(n);
    this.middle = new Int32Array(n);
    this.leaving = new Float64Array(n).fill(Number.NaN);
    this.wake = new Float64Array(n).fill(Number.NaN);
    this.flown = new Uint32Array(n);
    this.bursts = new Uint32Array(n);
    this.from = new Float32Array(n * 3);
    this.to = new Float32Array(n * 3);
    this.across = new Float32Array(n);
    this.began = new Float64Array(n);
    this.lost = new Float64Array(n);
    this.far = new Uint8Array(n);
    this.speed = new Float32Array(n);
    this.pitch = new Float32Array(n);
    this.cruise = new Float32Array(n);
    this.height = new Float32Array(n);
    this.gait = new Uint8Array(n);
    this.gaitFrom = new Float64Array(n);
    this.gaitFor = new Float32Array(n);
    this.bob = new Float32Array(n);
    this.bobFrom = new Float32Array(n);
    this.bobTo = new Float32Array(n);
    this.toss = new Float32Array(n);
    this.shut = new Float32Array(n);
    this.social = new Float32Array(n * 3);
  }

  /**
   * Every bird in a tree where it'd be at `seconds`, as between flits: one
   * of the trees it's staying with.
   */
  perchAll(seconds: number) {
    const { position, velocity, heading, settled, wing, bank } = this.birds;
    const { seed } = this.flock;

    for (let i = 0; i < this.birds.n; i++) {
      const patch = this.staying(i, seconds);
      this.stay[i] = patch.index;
      this.middle[i] = this.treeNear(patch.x, patch.z);
      this.tree[i] = this.treeIn(i, 0);
      this.perchIn(this.tree[i], i, 0, position.subarray(i * 3, i * 3 + 3));
      velocity.fill(0, i * 3, i * 3 + 3);
      heading[i] = hashed(seed, 100 + i) * Math.PI * 2;
      settled[i] = 1;
      wing[i] = FOLDED;
      bank[i] = 0;
      this.wake[i] = Number.NaN;
      this.leaving[i] = Number.NaN;
      this.flown[i] = 0;
    }
  }

  /**
   * The birds on `dt` seconds to `time` (the scene's, s). While they're
   * `about`, those sitting flit, or leave for other trees, when it's time;
   * those flying fly on, over the ground (`bare`) and on a long flight the
   * roofs (`surface`). Once they're not about, each lands and stays.
   */
  step(
    dt: number,
    about: boolean,
    surface: Surface,
    bare: Surface,
    time: number
  ) {
    if (this.hops.follow !== undefined) this.flockTogether();

    for (let i = 0; i < this.birds.n; i++) {
      if (this.birds.settled[i]) this.sit(i, about, time);

      // Off the perch this step, too.
      if (!this.birds.settled[i]) this.fly(i, dt, surface, bare, time);
    }
  }

  /** Where bird `i`'s staying at `seconds`: its flock's trees, or its own. */
  private staying(i: number, seconds: number) {
    const own = this.hops.follow === undefined ? i : -1;

    return patchAt(this.flock, seconds, own, this.patch);
  }

  /** The tree nearest world x, z: there's one (./boids.ts). */
  private treeNear(x: number, z: number) {
    const near = this.trees.nearest(x, z, SEARCH);

    return near < 0 ? this.trees.closest(x, z) : near;
  }

  /** A tree for bird `i`'s `k`th flight among those it's staying with. */
  private treeIn(i: number, k: number) {
    const { x, z } = this.trees.tree(this.middle[i]);
    const seed = this.flock.seed + k * 7919;
    const angle = hashed(seed, 25_000 + i) * Math.PI * 2;
    const r = Math.sqrt(hashed(seed, 29_000 + i)) * this.hops.patch;

    const tree = this.trees.nearest(
      x + Math.sin(angle) * r,
      z + Math.cos(angle) * r,
      this.hops.patch
    );

    return tree < 0 ? this.middle[i] : tree;
  }

  /**
   * Where bird `i` sits in tree `tree` on its `k`th flight: on top of the
   * crown, a seat of its own. Into `out` (x, y, z).
   */
  private perchIn(tree: number, i: number, k: number, out: Float32Array) {
    const seed = this.flock.seed + k * 6151;

    this.trees.seat(
      tree,
      hashed(seed, 17_000 + i),
      hashed(seed, 21_000 + i),
      hashed(seed, 23_000 + i),
      out
    );
  }

  /**
   * Bird `i`, sitting: off to its next stay if that's begun (after the
   * others, in a flock), or to another perch once it's rested.
   */
  private sit(i: number, about: boolean, time: number) {
    const { velocity, wing, bank, heading, phase } = this.birds;
    const { seed } = this.flock;
    const { hops } = this;
    velocity.fill(0, i * 3, i * 3 + 3);
    wing[i] = FOLDED;
    bank[i] = 0;

    if (!about) return;

    // Seen sitting for the first time: rested a while already.
    if (Number.isNaN(this.wake[i])) {
      this.wake[i] = time + hashed(seed + 31, i) * hops.pause[1];
    }

    // Looking about: facing another way every couple of seconds.
    const glance = Math.floor(time / 2.3 + phase[i]);
    heading[i] = hashed(seed + glance, 33_000 + i) * Math.PI * 2;

    const patch = this.staying(i, time);

    if (patch.index !== this.stay[i]) {
      // One goes, and the rest after it: each a moment behind.
      if (Number.isNaN(this.leaving[i])) {
        const behind =
          hops.follow === undefined
            ? 0
            : -Math.log(1 - hashed(seed + patch.index, 300 + i) * 0.95) *
              hops.follow;

        this.leaving[i] = Math.max(patch.since, time) + behind;
      }

      if (time < this.leaving[i]) return;

      this.stay[i] = patch.index;
      this.middle[i] = this.treeNear(patch.x, patch.z);
      this.leaving[i] = Number.NaN;

      const k = ++this.flown[i];

      if (!this.launch(i, this.treeIn(i, k), k, true, time)) this.rest(i, time);

      return;
    }

    if (time < this.wake[i]) return;

    // A flit: to the tree nearest a spot a short way off, among those it's
    // staying with; or, now and then or if there's none, to another spot
    // in its own.
    const k = ++this.flown[i];
    const { position: p } = this.birds;
    const here = { x: p[i * 3], z: p[i * 3 + 2] };
    let tree = this.tree[i];

    if (hashed(seed + k * 7919, i * 3 + 2) >= SAME_TREE) {
      const angle = hashed(seed + k * 7919, i * 3) * Math.PI * 2;

      const d =
        hops.near + hashed(seed + k * 7919, i * 3 + 1) * (hops.far - hops.near);

      const middle = this.trees.tree(this.middle[i]);
      let tx = here.x + Math.sin(angle) * d;
      let tz = here.z + Math.cos(angle) * d;
      const away = Math.hypot(tx - middle.x, tz - middle.z);

      if (away > hops.patch) {
        tx = middle.x + ((tx - middle.x) * hops.patch) / away;
        tz = middle.z + ((tz - middle.z) * hops.patch) / away;
      }

      const other = this.trees.nearest(tx, tz, hops.far, here);

      if (other >= 0) tree = other;
    }

    if (!this.launch(i, tree, k, false, time)) this.rest(i, time);
  }

  /** Bird `i` sits a while from `time` before its next flit. */
  private rest(i: number, time: number) {
    const [least, most] = this.hops.pause;
    const u = hashed(this.flock.seed + this.flown[i] * 104_729, i);
    this.wake[i] = time + least + u * u * (most - least);
  }

  /**
   * Bird `i` off its perch for tree `tree`, its `k`th flight: a leap, about
   * the way it's going. `far`, to another stay. False if it's as good as
   * there already.
   */
  private launch(
    i: number,
    tree: number,
    k: number,
    far: boolean,
    time: number
  ) {
    const { position: p, heading, settled } = this.birds;
    const { habit, seed } = this.flock;
    const i3 = i * 3;
    const to = this.to.subarray(i3, i3 + 3);
    this.perchIn(tree, i, k, to);

    const dx = to[0] - p[i3];
    const dy = to[1] - p[i3 + 1];
    const dz = to[2] - p[i3 + 2];
    const across = Math.hypot(dx, dz);
    const distance = Math.hypot(across, dy);

    if (distance < CATCH * 2) return false;

    const [low, high] = habit.height;
    this.tree[i] = tree;
    this.from.set(p.subarray(i3, i3 + 3), i3);
    this.across[i] = across;
    this.far[i] = Number(far);
    this.began[i] = time;
    this.height[i] = low + hashed(seed, 9000 + i) * (high - low);

    // A flit's not as fast as a flight.
    this.cruise[i] =
      habit.speed *
      (0.85 + 0.3 * hashed(seed + k, 37_000 + i)) *
      (far ? 1 : 0.8);

    this.lost[i] = time + distance / (this.cruise[i] * 0.4) + 4;
    this.speed[i] = LEAP;
    this.pitch[i] = clamp(Math.atan2(dy, across) + 0.35, 0.1, CLIMB);

    heading[i] =
      Math.atan2(dx, dz) + (hashed(seed + k, 41_000 + i) - 0.5) * 0.7;

    this.gait[i] = STEADY;
    this.bob[i] = 0;
    settled[i] = 0;

    return true;
  }

  /** Bird `i` down on the perch it was flying to. */
  private land(i: number, time: number) {
    const { position, velocity, settled, wing, bank } = this.birds;
    const i3 = i * 3;
    position.set(this.to.subarray(i3, i3 + 3), i3);
    velocity.fill(0, i3, i3 + 3);
    settled[i] = 1;
    wing[i] = FOLDED;
    bank[i] = 0;
    this.rest(i, time);
  }

  /**
   * What each bird flying to another stay with its flock is asked by its
   * flockmates: a turn, and a pitch, toward the way they're going and
   * where they are, and off the nearest; and to keep up. Of the seven
   * nearest it can see.
   */
  private flockTogether() {
    const { n, position: p, heading, settled } = this.birds;
    const { spacing } = this.flock.habit;
    const { nearest, apart } = this;
    this.social.fill(0);

    for (let i = 0; i < n; i++) {
      if (settled[i] || !this.far[i]) continue;

      const i3 = i * 3;
      const sin = Math.sin(heading[i]);
      const cos = Math.cos(heading[i]);
      let found = 0;

      for (let j = 0; j < n; j++) {
        if (j === i || settled[j] || !this.far[j]) continue;

        if (this.stay[j] !== this.stay[i]) continue;

        const j3 = j * 3;
        const dx = p[j3] - p[i3];
        const dy = p[j3 + 1] - p[i3 + 1];
        const dz = p[j3 + 2] - p[i3 + 2];
        const d = Math.hypot(dx, dy, dz) || 0.01;

        if ((dx * sin + dz * cos) / d < BLIND) continue;

        // Kept nearest first.
        let at = Math.min(found, NEIGHBOURS - 1);

        if (found === NEIGHBOURS && d >= apart[at]) continue;

        while (at > 0 && apart[at - 1] > d) {
          apart[at] = apart[at - 1];
          nearest[at] = nearest[at - 1];
          at--;
        }

        apart[at] = d;
        nearest[at] = j;
        found = Math.min(found + 1, NEIGHBOURS);
      }

      if (found === 0) continue;

      let wayX = 0;
      let wayZ = 0;
      let midX = 0;
      let midY = 0;
      let midZ = 0;

      for (let k = 0; k < found; k++) {
        const j = nearest[k];
        wayX += Math.sin(heading[j]);
        wayZ += Math.cos(heading[j]);
        midX += p[j * 3] - p[i3];
        midY += p[j * 3 + 1] - p[i3 + 1];
        midZ += p[j * 3 + 2] - p[i3 + 2];
      }

      let yaw = ALIGN * wrap(Math.atan2(wayX, wayZ) - heading[i]);
      let pitch = 0;
      const midAcross = Math.hypot(midX, midZ);

      if (midAcross > 0.5) {
        yaw += COHERE * wrap(Math.atan2(midX, midZ) - heading[i]);
        pitch += COHERE * Math.atan2(midY / found, midAcross / found);
      }

      // Off the nearest, if it's close: away to the side it isn't on.
      const room = spacing * 2;

      if (apart[0] < room) {
        const j3 = nearest[0] * 3;
        const dx = p[j3] - p[i3];
        const dz = p[j3 + 2] - p[i3 + 2];
        const side = dx * cos - dz * sin >= 0 ? 1 : -1;
        const press = AVOID * (1 - apart[0] / room);
        yaw -= side * press;
        pitch -= Math.sign(p[j3 + 1] - p[i3 + 1]) * press * 0.3;
      }

      // How far behind them it is, the way it's going.
      const behind = (midX * sin + midZ * cos) / found;

      this.social[i * 3] = yaw;
      this.social[i * 3 + 1] = pitch;

      this.social[i * 3 + 2] = clamp(behind / STRUNG_OUT, -1, 1) * CATCH_UP;
    }
  }

  /** Bird `i`, flying, on `dt` seconds to `time`. */
  private fly(
    i: number,
    dt: number,
    surface: Surface,
    bare: Surface,
    time: number
  ) {
    if (dt <= 0) return;

    const { position: p, velocity: v, heading, bank } = this.birds;
    const i3 = i * 3;
    const x = p[i3];
    const y = p[i3 + 1];
    const z = p[i3 + 2];
    const before = heading[i];

    // The height to keep on the way: over the ground under it and ahead;
    // on a long flight, at its kind's height, and over the roofs if
    // they're not towers.
    const ax = x + Math.sin(before) * this.speed[i] * LOOK_AHEAD;
    const az = z + Math.cos(before) * this.speed[i] * LOOK_AHEAD;
    const ground = Math.max(bare(x, z), bare(ax, az));
    const long = eased(SHORT, LONG, this.across[i]);
    const roofs = Math.max(surface(x, z), surface(ax, az)) - ground;

    const hold =
      ground +
      Math.max(1, long * Math.max(this.height[i], Math.min(roofs, ROOFS)));

    const steps = Math.ceil(dt / STEP);
    const h = dt / steps;
    let landed = false;

    for (let s = 1; s <= steps && !landed; s++) {
      landed = this.advance(i, h, time - dt + s * h, hold, bare);
    }

    if (landed) return;

    v[i3] = (p[i3] - x) / dt;
    v[i3 + 1] = (p[i3 + 1] - y) / dt;
    v[i3 + 2] = (p[i3 + 2] - z) / dt;

    // Banked into the turn.
    const rate = wrap(heading[i] - before) / dt;
    const lean = Math.atan((rate * this.speed[i]) / G);

    bank[i] +=
      (clamp(lean, -MOST_BANK, MOST_BANK) - bank[i]) * Math.min(dt * 6, 1);
  }

  /**
   * Bird `i` on `h` seconds (a short step) to `t`, keeping at least `hold`
   * high on the way. True once it's landed.
   */
  private advance(
    i: number,
    h: number,
    t: number,
    hold: number,
    bare: Surface
  ) {
    const { position: p, heading, wing, phase } = this.birds;
    const { habit } = this.flock;
    const i3 = i * 3;
    const dx = this.to[i3] - p[i3];
    const dy = this.to[i3 + 1] - p[i3 + 1];
    const dz = this.to[i3 + 2] - p[i3 + 2];
    const across = Math.hypot(dx, dz);
    const distance = Math.hypot(across, dy);
    let speed = this.speed[i];
    let pitch = this.pitch[i];
    let yaw = heading[i];

    const closing =
      (dx * Math.sin(yaw) + dz * Math.cos(yaw)) * Math.cos(pitch) +
      dy * Math.sin(pitch);

    // On the perch; or past it, a wingbeat away; or lost, which it
    // shouldn't be.
    if (
      distance < Math.max(CATCH, speed * h * 1.5) ||
      (distance < 1.5 && closing < 0) ||
      t > this.lost[i]
    ) {
      this.land(i, t);

      return true;
    }

    this.stride(i, h, t, distance);

    const shut = this.gait[i] === BOUND;

    // Which way: straight there, weaving a little, less as it nears; and
    // as its flockmates ask, till it's nearly there.
    const weave =
      Math.sin(t * 1.3 + phase[i] * 5) *
      Math.sin(t * 0.53 + phase[i] * 3) *
      WEAVE *
      Math.min(1, across / 25);

    const together = Math.min(1, across / 30);

    const turn =
      wrap(Math.atan2(dx, dz) + weave - yaw) + this.social[i * 3] * together;

    // How high: far out, along the straight way or over what's between,
    // coming down in time; near, under the perch, and up onto it.
    const full = this.across[i];
    const swoop = Math.min(SWOOP_FROM, full * 0.5);
    const reach = Math.max(speed * 0.6, 1);
    let aim: number;
    let ahead: number;

    if (across > swoop) {
      const straight =
        this.from[i3 + 1] +
        (this.to[i3 + 1] - this.from[i3 + 1]) * (1 - across / full);

      const down = this.to[i3 + 1] - RISE * swoop + (across - swoop) * DESCENT;

      aim = Math.min(Math.max(straight, hold), down);
      ahead = reach;
    } else {
      const left = Math.max(across - reach, 0);
      aim = this.to[i3 + 1] - RISE * left;
      ahead = Math.max(across - left, 0.3);
    }

    const tilt =
      clamp(Math.atan2(aim - p[i3 + 1], ahead), DIVE, CLIMB) +
      this.social[i * 3 + 1] * together;

    // Turning as fast as it can react, and no faster than a bird can
    // turn; hardly at all with its wings shut.
    const quick = (h / REACT) * (shut ? 0.3 : 1);
    const most = Math.min(TURN, (LOAD * G) / Math.max(speed, 1)) * h;
    yaw += clamp(turn * quick, -most, most);
    pitch += clamp((tilt - pitch) * quick, -PITCH_RATE * h, PITCH_RATE * h);

    // Up to its speed; slowing steadily into the perch; quicker downhill.
    const slowing = Math.sqrt(
      TOUCH * TOUCH + 2 * BRAKE * Math.max(distance - CATCH, 0)
    );

    const wanted = Math.min(
      this.cruise[i] * (1 + this.social[i * 3 + 2] * together),
      slowing
    );

    const pull = shut
      ? -SHUT_DRAG
      : clamp((wanted - speed) / THROTTLE, -BRAKE * 1.6, PULL);

    speed = Math.max(speed + (pull - G * Math.sin(pitch) * FALL) * h, 0.6);

    const level = Math.cos(pitch) * speed;
    p[i3] += Math.sin(yaw) * level * h;
    p[i3 + 1] += (Math.sin(pitch) * speed + this.bob[i]) * h;
    p[i3 + 2] += Math.cos(yaw) * level * h;

    // Never into the ground.
    const floor = bare(p[i3], p[i3 + 2]) + 0.4;

    if (p[i3 + 1] < floor) {
      p[i3 + 1] = floor;
      pitch = Math.max(pitch, 0.1);
    }

    this.speed[i] = speed;
    this.pitch[i] = pitch;
    heading[i] = yaw;

    // Wings beating; shut, or held out, between bursts.
    if (shut) {
      const held = this.hops.glides ? 0.12 : FOLDED;
      wing[i] += (held - wing[i]) * Math.min(h * 30, 1);
    } else {
      wing[i] = Math.sin(t * habit.beat * Math.PI * 2 + phase[i]) * 0.85 + 0.1;
    }

    return false;
  }

  /**
   * Bird `i`'s wingbeats on `h` seconds to `t`, `distance` m from its
   * perch: steadily, or far enough from it and fast enough, in bursts with
   * the wings shut between. Shut, it falls as a thrown thing does; beating,
   * it's lifted back as much: rising into each bound and dropping out of
   * it, about the path it's flying.
   */
  private stride(i: number, h: number, t: number, distance: number) {
    const { hops } = this;
    const cruise = this.cruise[i];

    // Room to stop in, and a burst and a bound more.
    const room = (cruise * cruise) / (2 * BRAKE) + cruise * 1.2;

    const bounding =
      this.speed[i] > cruise * 0.75 &&
      distance > room &&
      t - this.began[i] > 0.5 &&
      this.pitch[i] < 0.4;

    const u = Math.min((t - this.gaitFrom[i]) / this.gaitFor[i], 1);

    if (this.gait[i] === STEADY) {
      this.bob[i] *= Math.max(0, 1 - h / 0.12);

      if (bounding) this.burst(i, t, 0.5);

      return;
    }

    if (this.gait[i] === BURST) {
      this.bob[i] = this.bobFrom[i] + (this.bobTo[i] - this.bobFrom[i]) * u;

      if (u < 1) return;

      if (this.bobTo[i] > 0 && bounding) {
        this.gait[i] = BOUND;
        this.gaitFrom[i] = t;
        this.gaitFor[i] = this.shut[i];
        this.toss[i] = this.bobTo[i];
      } else {
        this.gait[i] = STEADY;
      }

      return;
    }

    this.bob[i] = this.toss[i] * (1 - 2 * u);

    if (u < 1) return;

    if (bounding) this.burst(i, t, 1);
    else {
      // Out of the last bound: levelled off by half a burst.
      this.gait[i] = BURST;
      this.gaitFrom[i] = t;
      this.gaitFor[i] = hops.burst[0] * 0.5;
      this.bobFrom[i] = this.bob[i];
      this.bobTo[i] = 0;
    }
  }

  /**
   * Bird `i` begins a burst of beats at `t`, `share` of a whole one, that
   * lifts it into its next bound: however long that'll be.
   */
  private burst(i: number, t: number, share: number) {
    const { hops } = this;
    const [least, most] = hops.burst;

    const beating =
      least +
      hashed(this.flock.seed + this.bursts[i]++, 45_000 + i) * (most - least);

    const shut = (beating * (1 - hops.flapping)) / hops.flapping;
    const lift = hops.glides ? GLIDE_LIFT : SHUT_LIFT;
    this.gait[i] = BURST;
    this.gaitFrom[i] = t;
    this.gaitFor[i] = beating * share;
    this.shut[i] = shut;
    this.bobFrom[i] = this.bob[i];
    // Rising at the start of the bound as fast as it's falling at its end.
    this.bobTo[i] = (G * (1 - lift) * shut) / 2;
  }
}
