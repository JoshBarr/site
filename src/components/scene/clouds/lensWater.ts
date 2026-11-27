// Water on the glass in front of the lens, as drops that each hold some
// water: rain lands as beads, which the glass holds until there's enough of
// one for gravity or the wind to tear it free; then it runs, wandering as
// the glass grips it unevenly, leaving beads behind it, swallowing every
// drop it meets and growing as it does. The glass stays wet where a drop has
// run, so the next runs easier there, and drops find their way down each
// other's tracks. Facing down, the glass hangs its drops under it, and the
// big ones drip off. Out of the rain it all dries, the small first.
//
// Places are in screen heights from the top left, y down, so the frame's
// width is its aspect; radii in screen heights too. Nothing here knows of
// three: it's fed which way is down and which way the air's going across
// the glass, both already turned into the screen's axes (see ./wetLens.ts).

/** How many drops the glass can hold at once. */
export const CAPACITY = 1400;

/** Gravity across the glass, screen heights per second² per g of force. */
const GRAVITY = 1;

/**
 * How hard the glass holds a drop, as a force spread over its water: the
 * contact line grows as a drop's radius and its water as the cube, so small
 * drops are held hardest. A drop this many screen heights across, on clean
 * dry glass upright, is just held: about 11 px on a 900 px frame.
 */
const HELD_RADIUS = 0.012;
const PIN = GRAVITY * HELD_RADIUS * HELD_RADIUS;

/** Once moving, it takes this share of the hold to stop it. */
const SLIDING_HOLD = 0.55;

/** Running speed per unit of force over the hold, per screen height of radius. */
const MOBILITY = 28;

/** Fastest a drop runs, screen heights per second. */
const TOP_SPEED = 1.4;

/** Seconds a running drop takes to change its pace. */
const PACE_TIME = 0.06;

/**
 * Drag of the air across the glass on a drop, over its water, per (m/s)²:
 * a breeze of 10 m/s pushes a drop 0.01 across as hard as gravity does.
 */
const DRAG = 1e-4;

/** Air hitting the glass head on spreads out from the middle this fast, of its speed. */
const SPREAD = 0.8;

/** How unevenly the glass holds drops: its hold runs from 1 − this to 1 + this. */
const GRIP_VARIES = 0.55;

/** The grip's grain, per screen height. */
const GRIP_SCALE = 22;

/** A track already run holds the next drop this much less. */
const TRACK_EASE = 0.55;

/** A drop runs over dry glass at this share of its pace down a wet track. */
const DRY_PACE = 0.35;

/** Seconds a wet track takes to go mostly dry. */
const TRACK_DRYING = 30;

/** The wet tracks are kept on a grid this many cells to a screen height. */
const TRACK_CELLS = 96;

/** Radians a running drop turns toward the wetter side, all one side wet. */
const TRACK_PULL = 0.9;

/** Radians a running drop wanders off straight, at most. */
const WANDER = 0.3;

/** A running drop leaves a bead behind every this many of its radii... */
const BEAD_EVERY: [number, number] = [1.4, 3];

/** ...this share of its radius. */
const BEAD_SIZE: [number, number] = [0.16, 0.32];

/** Drops under this radius leave nothing behind. */
const LEAVES_BEADS = 0.004;

/**
 * A running drop draws a thin thread of water behind it, this share of its
 * radius across, a piece every this far run (screen heights), which drains
 * away over this many seconds: where drops follow each other down a track,
 * the thread joins them into a stream.
 */
const THREAD_SHARE = 0.18;
const THREAD_STEP = 0.01;
const THREAD_LIFE = 1.6;

/** Pieces of thread kept at once, the oldest overwritten first. */
export const THREADS = 3000;

/**
 * Drops this close, as a share of their radii summed, touch. A running drop
 * swallows what it touches; drops the glass is holding cling together in a
 * clump instead, each held where it is, until there's water enough in the
 * clump for it to tear free, or one's mostly on top of another.
 */
const TOUCHING = 0.85;
const ON_TOP = 0.45;

/**
 * A clump's held along its edge, which is about this many times the edge of
 * one round drop covering as much glass: more than one drop holding all its
 * water is, so clumps grow bigger than drops before they run.
 */
const CLUMP_EDGE = 1.3;

/**
 * Facing straight down, drops bigger than this fall off the glass; facing
 * down less steeply, drops bigger than this over the root of how steep.
 */
const DRIPS_AT = 0.008;

/** How often a drop big enough to drip does, per second. */
const DRIP_RATE = 2.5;

/** Seconds a drop takes to fall away. */
const DRIP_TIME = 0.14;

/** Radius lost to the air per second, out of the rain and in it. */
const DRYING = 0.00025;
const DRYING_IN_RAIN = 0.00003;

/** Drops smaller than this are gone. */
const GONE = 0.0007;

/** Drops landing per second over a screen height square, in rain of RAIN_AT. */
const LANDING = 56;

/** Rain on the glass of 1, mm/h. */
const RAIN_AT = 6;

/**
 * Radii rain lands with: the smallest, and the largest in drizzle and in
 * rain this many times as hard as RAIN_AT and harder.
 */
const SMALLEST = 0.0015;
const LARGEST: [number, number] = [0.008, 0.026];
const LARGEST_AT = 2.5;

/** Largest a drop grows, by gathering others. */
const BIGGEST = 0.06;

/** Seconds a drop takes to spread out where it lands. */
const LANDING_TIME = 0.05;

/** Seconds of the simulation in one step at most. */
const STEP = 1 / 30;

/** What the glass is told each frame. */
export type LensWeather = {
  /** How hard it's raining on the glass, as lensRain has it. */
  rain: number;
  /** Gravity along the glass, in g, screen axes (y down). */
  down: [number, number];
  /**
   * Gravity's pull off the glass, in g: 1 facing straight down, 0 level,
   * negative facing up, when it holds drops to the glass instead.
   */
  away: number;
  /** Air across the glass, m/s, screen axes (y down). */
  air: [number, number];
  /** Air hitting the glass head on, m/s. */
  onto: number;
  /** The frame's width over its height. */
  aspect: number;
};

/** A piece of thread, as it's drawn: a line, rounded at its newer end. */
export type DrawnThread = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  radius: number;
};

/** One drop, as it's drawn: a disc swept into a tail behind it as it runs. */
export type DrawnDrop = {
  x: number;
  y: number;
  /** Radius shown, after landing and dripping. */
  radius: number;
  /** For the shape of its edge, 0..1. */
  seed: number;
  /** Which way it's running (or would), unit. */
  dx: number;
  dy: number;
  /** How far its tail sweeps out behind it, of its radius. */
  stretch: number;
};

function hash(x: number, y: number) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;

  return h - Math.floor(h);
}

/** Value noise, 0..1, smooth between whole numbers. */
function noise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);

  return a + (b - a) * sx + (c - a + (d - b - c + a) * sx) * sy;
}

/** How hard the glass holds water at a place, relative to clean glass. */
function grip(x: number, y: number) {
  return 1 + GRIP_VARIES * (2 * noise(x * GRIP_SCALE, y * GRIP_SCALE) - 1);
}

/**
 * How hard rain of `rate` mm/h rains on the glass: 1 at RAIN_AT, less in
 * lighter rain, and in harder rain more, levelling off toward 1 + RAIN_KNEE:
 * a downpour streams down the glass, but leaves the view through it.
 */
const RAIN_KNEE = 0.4;

export function lensRain(rate: number) {
  if (rate <= 0) return 0;
  const steady = Math.pow(rate / RAIN_AT, 0.8);

  return steady <= 1
    ? steady
    : 1 + RAIN_KNEE * (1 - Math.exp(-(steady - 1) / RAIN_KNEE));
}

const between = (range: [number, number], t: number) =>
  range[0] + (range[1] - range[0]) * t;

/** Radius of a drop holding the water of two. */
const together = (a: number, b: number) => Math.cbrt(a * a * a + b * b * b);

/** Radius of what's left of a drop after it leaves one of `b` behind. */
const apart = (a: number, b: number) =>
  Math.cbrt(Math.max(a * a * a - b * b * b, 0));

export function createLensWater(
  capacity = CAPACITY,
  random: () => number = Math.random
) {
  const x = new Float32Array(capacity);
  const y = new Float32Array(capacity);
  const r = new Float32Array(capacity);
  const vx = new Float32Array(capacity);
  const vy = new Float32Array(capacity);
  const age = new Float32Array(capacity);
  const seed = new Float32Array(capacity);
  /** Run since it last left a bead, and how far until the next. */
  const run = new Float32Array(capacity);
  const nextBead = new Float32Array(capacity);
  /** 0 on the glass; seconds since it began to fall off. */
  const dripping = new Float32Array(capacity);
  const moving = new Uint8Array(capacity);
  /** Where its thread was last drawn to. */
  const threadX = new Float32Array(capacity);
  const threadY = new Float32Array(capacity);
  const gone = new Uint8Array(capacity);
  let count = 0;

  // Wet tracks, over a frame up to 4 wide.
  const trackWidth = TRACK_CELLS * 4;
  const tracks = new Float32Array(trackWidth * TRACK_CELLS);

  const cell = (px: number, py: number) => {
    const i = Math.floor(px * TRACK_CELLS);
    const j = Math.floor(py * TRACK_CELLS);

    return i < 0 || j < 0 || i >= trackWidth || j >= TRACK_CELLS
      ? -1
      : j * trackWidth + i;
  };

  const trackAt = (px: number, py: number) => {
    const c = cell(px, py);

    return c < 0 ? 0 : tracks[c];
  };

  /** Rain still to land, a fraction of a drop. */
  let owed = 0;

  function add(px: number, py: number, radius: number) {
    if (count >= capacity) return -1;
    const i = count++;
    x[i] = px;
    y[i] = py;
    r[i] = radius;
    vx[i] = 0;
    vy[i] = 0;
    age[i] = 0;
    seed[i] = random();
    run[i] = 0;
    nextBead[i] = between(BEAD_EVERY, random()) * radius;
    dripping[i] = 0;
    moving[i] = 0;
    gone[i] = 0;
    threadX[i] = px;
    threadY[i] = py;

    return i;
  }

  // The thread, a ring of pieces.
  const pieceX0 = new Float32Array(THREADS);
  const pieceY0 = new Float32Array(THREADS);
  const pieceX1 = new Float32Array(THREADS);
  const pieceY1 = new Float32Array(THREADS);
  const pieceR = new Float32Array(THREADS);
  const pieceAge = new Float32Array(THREADS);
  let nextPiece = 0;
  let pieces = 0;

  /** Draws drop i's thread on to where it is, if it's run far enough. */
  function spin(i: number) {
    const dx = x[i] - threadX[i];
    const dy = y[i] - threadY[i];

    if (dx * dx + dy * dy < THREAD_STEP * THREAD_STEP) return;

    if (r[i] > LEAVES_BEADS) {
      const k = nextPiece;
      pieceX0[k] = threadX[i];
      pieceY0[k] = threadY[i];
      pieceX1[k] = x[i];
      pieceY1[k] = y[i];
      pieceR[k] = r[i] * THREAD_SHARE;
      pieceAge[k] = 0;
      nextPiece = (k + 1) % THREADS;
      pieces = Math.min(pieces + 1, THREADS);
    }

    threadX[i] = x[i];
    threadY[i] = y[i];
  }

  function drain(dt: number) {
    for (let k = 0; k < pieces; k++) pieceAge[k] += dt;
  }

  function land(weather: LensWeather, dt: number) {
    owed += weather.rain * LANDING * weather.aspect * dt;
    const n = Math.floor(owed);
    owed -= n;
    const largest = between(LARGEST, Math.min(weather.rain / LARGEST_AT, 1));

    for (let k = 0; k < n; k++) {
      // Mostly small, now and then a big one.
      const size =
        SMALLEST * Math.pow(largest / SMALLEST, Math.pow(random(), 2.2));

      // A full glass takes no more: they'd be lost among the rest anyway.
      if (count >= capacity) break;
      add(random() * weather.aspect, random(), size);
    }
  }

  /** The force on water of `radius` at a place, over its water. */
  const pushed = { x: 0, y: 0 };

  function push(weather: LensWeather, px: number, py: number, radius: number) {
    const [ax, ay] = weather.air;
    const airSpeed = Math.hypot(ax, ay);
    // Gravity, the air's drag, the air spreading out from where it hits
    // the glass.
    const drag = DRAG / radius;
    pushed.x = weather.down[0] * GRAVITY + ax * airSpeed * drag;
    pushed.y = weather.down[1] * GRAVITY + ay * airSpeed * drag;

    if (weather.onto > 0) {
      const spread = weather.onto * weather.onto * SPREAD * drag;
      pushed.x += (px - weather.aspect / 2) * spread;
      pushed.y += (py - 0.5) * spread;
    }

    return pushed;
  }

  /**
   * How hard the glass holds water at a place, over its water: along an
   * edge `edge` round (in radii), `held` of water (in radii³). One drop's
   * held by its radius over its radius³.
   */
  const holding = (px: number, py: number, edge: number, held: number) =>
    (PIN * grip(px, py) * (1 - TRACK_EASE * trackAt(px, py)) * edge) / held;

  function move(weather: LensWeather, dt: number) {
    const raining = weather.rain > 0;

    const dripsAt =
      weather.away > 0.01 ? DRIPS_AT / Math.sqrt(weather.away) : Infinity;

    for (let i = 0; i < count; i++) {
      if (gone[i]) continue;
      age[i] += dt;

      if (dripping[i] > 0) {
        dripping[i] += dt;

        if (dripping[i] > DRIP_TIME) gone[i] = 1;
        continue;
      }

      const radius = r[i];
      const { x: fx, y: fy } = push(weather, x[i], y[i], radius);
      const force = Math.hypot(fx, fy);
      const hold = holding(x[i], y[i], radius, radius ** 3);

      if (!moving[i] && force > hold) moving[i] = 1;
      else if (moving[i] && force < hold * SLIDING_HOLD) moving[i] = 0;

      if (moving[i]) {
        // Off straight as the glass grips it, and toward the wetter side.
        let ux = fx / force;
        let uy = fy / force;
        const side = radius * 1.5;
        const toLeft = trackAt(x[i] + uy * side, y[i] - ux * side);
        const toRight = trackAt(x[i] - uy * side, y[i] + ux * side);

        const turn =
          WANDER * (2 * noise(x[i] * 40 + seed[i] * 17, y[i] * 40) - 1) +
          TRACK_PULL * (toLeft - toRight);

        const c = Math.cos(turn);
        const s = Math.sin(turn);
        [ux, uy] = [ux * c - uy * s, ux * s + uy * c];

        // Slow over dry glass, which it has to wet as it goes; quick down a
        // track already run, so the drops behind catch the one ahead and
        // run into it, and a track becomes a stream. The glass just ahead
        // of it: where it is, it's wet the glass itself.
        const reach = radius + 1 / TRACK_CELLS;
        const ahead = trackAt(x[i] + ux * reach, y[i] + uy * reach);

        const speed = Math.min(
          MOBILITY *
            radius *
            (force - hold * SLIDING_HOLD) *
            (DRY_PACE + (1 - DRY_PACE) * ahead),
          TOP_SPEED
        );

        const ease = 1 - Math.exp(-dt / PACE_TIME);
        vx[i] += (ux * speed - vx[i]) * ease;
        vy[i] += (uy * speed - vy[i]) * ease;
      } else {
        vx[i] *= Math.exp(-dt / (PACE_TIME * 0.5));
        vy[i] *= Math.exp(-dt / (PACE_TIME * 0.5));
      }

      const step = Math.hypot(vx[i], vy[i]) * dt;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;

      if (moving[i]) {
        spin(i);
      } else {
        threadX[i] = x[i];
        threadY[i] = y[i];
      }

      if (step > 0) {
        const c = cell(x[i], y[i]);

        if (c >= 0) tracks[c] = 1;

        run[i] += step;

        // Beads left behind, from what water it has.
        if (run[i] > nextBead[i] && radius > LEAVES_BEADS) {
          const bead = radius * between(BEAD_SIZE, random());
          const speed = Math.hypot(vx[i], vy[i]);
          const back = (radius + bead) * 1.05;
          r[i] = apart(radius, bead);
          run[i] = 0;
          nextBead[i] = between(BEAD_EVERY, random()) * r[i];

          const j = add(
            x[i] - (vx[i] / speed) * back,
            y[i] - (vy[i] / speed) * back,
            bead
          );

          // Already spread: it was part of the drop.
          if (j >= 0) age[j] = LANDING_TIME;
        }
      }

      r[i] -= (raining ? DRYING_IN_RAIN : DRYING) * (0.6 + 0.8 * seed[i]) * dt;

      if (r[i] > dripsAt && random() < DRIP_RATE * dt) dripping[i] = 1e-6;

      // Off the glass, or dried up.
      if (
        r[i] < GONE ||
        y[i] - r[i] > 1 ||
        y[i] + r[i] < 0 ||
        x[i] + r[i] < 0 ||
        x[i] - r[i] > weather.aspect
      ) {
        gone[i] = 1;
      }
    }
  }

  // Sweep along x, for drops that touch.
  const order = new Uint16Array(capacity);
  const left = new Float32Array(capacity);
  /** Each drop's clump, as the drop it hangs from (itself for none). */
  const clump = new Uint16Array(capacity);

  const root = (i: number) => {
    while (clump[i] !== i) {
      clump[i] = clump[clump[i]];
      i = clump[i];
    }

    return i;
  };

  /** Runs `small`'s water into `big`'s. */
  function fuse(big: number, small: number) {
    const mb = r[big] ** 3;
    const ms = r[small] ** 3;
    const share = ms / (mb + ms);

    x[big] += (x[small] - x[big]) * share;
    y[big] += (y[small] - y[big]) * share;
    vx[big] += (vx[small] - vx[big]) * share;
    vy[big] += (vy[small] - vy[big]) * share;
    r[big] = Math.min(together(r[big], r[small]), BIGGEST);
    age[big] = Math.max(age[big], LANDING_TIME);
    gone[small] = 1;
  }

  /** Each clump's water, the glass it covers, and its middle (by water). */
  const water = new Float32Array(capacity);
  const cover = new Float32Array(capacity);
  const middleX = new Float32Array(capacity);
  const middleY = new Float32Array(capacity);

  function merge(weather: LensWeather) {
    for (let i = 0; i < count; i++) {
      order[i] = i;
      left[i] = x[i] - r[i];
      clump[i] = i;
    }

    const sorted = order.subarray(0, count).sort((a, b) => left[a] - left[b]);

    for (let a = 0; a < count; a++) {
      const i = sorted[a];

      if (gone[i] || dripping[i] > 0) continue;

      for (let b = a + 1; b < count; b++) {
        const j = sorted[b];

        if (left[j] > x[i] + r[i] + BIGGEST) break;

        if (gone[j] || dripping[j] > 0) continue;

        const sum = r[i] + r[j];
        const dx = x[j] - x[i];
        const dy = y[j] - y[i];
        const apart2 = dx * dx + dy * dy;

        if (apart2 > sum * sum * TOUCHING * TOUCHING) continue;

        // Held drops side by side cling; anything else runs into one.
        if (!moving[i] && !moving[j] && apart2 > sum * sum * ON_TOP * ON_TOP) {
          const ri = root(i);
          const rj = root(j);

          if (ri !== rj) clump[ri] = rj;
          continue;
        }

        const [big, small] = r[i] >= r[j] ? [i, j] : [j, i];
        fuse(big, small);

        if (small === i) break;
      }
    }

    // Each clump as one: if there's water enough in it to tear free, it
    // runs together, from its middle.
    for (let i = 0; i < count; i++) {
      water[i] = 0;
      cover[i] = 0;
      middleX[i] = 0;
      middleY[i] = 0;
    }

    let clumped = false;

    for (let i = 0; i < count; i++) {
      if (gone[i] || clump[i] === i) continue;
      clumped = true;
    }

    if (!clumped) return;

    for (let i = 0; i < count; i++) {
      if (gone[i] || dripping[i] > 0) continue;
      const c = root(i);
      const w = r[i] ** 3;
      water[c] += w;
      cover[c] += r[i] * r[i];
      middleX[c] += x[i] * w;
      middleY[c] += y[i] * w;
    }

    for (let i = 0; i < count; i++) {
      if (gone[i] || dripping[i] > 0) continue;
      const c = root(i);

      // The first of each clump found speaks for it.
      if (water[c] <= 0) continue;
      const radius = Math.cbrt(water[c]);

      if (radius <= r[i] * 1.0001) {
        water[c] = 0;
        continue;
      }

      const mx = middleX[c] / water[c];
      const my = middleY[c] / water[c];
      const { x: fx, y: fy } = push(weather, mx, my, radius);

      const edge = CLUMP_EDGE * Math.sqrt(cover[c]);

      if (
        Math.hypot(fx, fy) <= holding(mx, my, edge, water[c]) &&
        radius < BIGGEST
      ) {
        water[c] = 0;
        continue;
      }

      // Tears free: all of it into this drop, which runs.
      for (let j = 0; j < count; j++) {
        if (j !== i && !gone[j] && dripping[j] <= 0 && root(j) === c) {
          gone[j] = 1;
        }
      }

      x[i] = mx;
      y[i] = my;
      threadX[i] = mx;
      threadY[i] = my;
      r[i] = Math.min(radius, BIGGEST);
      age[i] = Math.max(age[i], LANDING_TIME);
      moving[i] = 1;
      water[c] = 0;
    }
  }

  function sweep() {
    let kept = 0;

    for (let i = 0; i < count; i++) {
      if (gone[i]) continue;

      if (kept !== i) {
        x[kept] = x[i];
        y[kept] = y[i];
        r[kept] = r[i];
        vx[kept] = vx[i];
        vy[kept] = vy[i];
        age[kept] = age[i];
        seed[kept] = seed[i];
        run[kept] = run[i];
        nextBead[kept] = nextBead[i];
        dripping[kept] = dripping[i];
        moving[kept] = moving[i];
        threadX[kept] = threadX[i];
        threadY[kept] = threadY[i];
        gone[kept] = 0;
      }

      kept++;
    }

    count = kept;
  }

  function dryTracks(dt: number) {
    const keep = Math.exp(-dt / TRACK_DRYING);

    for (let i = 0; i < tracks.length; i++) tracks[i] *= keep;
  }

  return {
    get count() {
      return count;
    },

    /** Moves the water on by `delta` seconds of `weather`. */
    step(weather: LensWeather, delta: number) {
      let remaining = Math.min(delta, 0.25);

      while (remaining > 1e-6) {
        const dt = Math.min(remaining, STEP);
        remaining -= dt;
        land(weather, dt);
        move(weather, dt);
        merge(weather);
        sweep();
        dryTracks(dt);
        drain(dt);
      }
    },

    /** Puts a drop on the glass: for tests. */
    put(px: number, py: number, radius: number) {
      const i = add(px, py, radius);

      if (i >= 0) age[i] = LANDING_TIME;
    },

    /** Wipes the glass dry. */
    clear() {
      count = 0;
      owed = 0;
      tracks.fill(0);
      pieces = 0;
      nextPiece = 0;
    },

    /** Each drop as it's to be drawn. */
    drawn(i: number, into: DrawnDrop) {
      const speed = Math.hypot(vx[i], vy[i]);
      const falling = dripping[i] > 0 ? dripping[i] / DRIP_TIME : 0;
      // Growing as it lands, and narrowing to a point as it falls away.
      into.radius =
        r[i] * Math.min(age[i] / LANDING_TIME, 1) * (1 - falling * falling);
      into.x = x[i];
      into.y = y[i];
      into.seed = seed[i];
      into.dx = speed > 1e-6 ? vx[i] / speed : 0;
      into.dy = speed > 1e-6 ? vy[i] / speed : 1;
      into.stretch = Math.min(speed / 0.25, 1.5);

      return into;
    },

    /** Pieces of thread there are to draw, some drained away. */
    get threads() {
      return pieces;
    },

    /** Piece k of the thread as it's to be drawn: a radius of 0 once drained. */
    thread(k: number, into: DrawnThread) {
      const left = 1 - pieceAge[k] / THREAD_LIFE;
      into.x0 = pieceX0[k];
      into.y0 = pieceY0[k];
      into.x1 = pieceX1[k];
      into.y1 = pieceY1[k];
      into.radius = left > 0 ? pieceR[k] * Math.sqrt(left) : 0;

      return into;
    },

    /** Water on the glass, as its radius alone: for tests. */
    radii() {
      return Array.from(r.subarray(0, count));
    },

    /** Where each drop is: for tests. */
    places() {
      return Array.from({ length: count }, (_, i) => [x[i], y[i]]);
    },
  };
}
