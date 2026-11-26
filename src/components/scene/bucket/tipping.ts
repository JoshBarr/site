// The buckets' tipping, worked out step by step: each swings on its axle,
// its counterweight holding it back on its stop, and the water in it
// pulling it forward. Water runs in, from the feed or from a bucket above
// tipping; once there's enough, the water's pull beats the counterweight and,
// as the bucket leans, the water's pull grows faster than the counterweight's,
// so it goes all at once. Leaning, it spills over its lip, and empty, the
// counterweight swings it back to bang on its stop.
//
// The water's mass, the counterweight and the swing are guesses, sized so a
// bucket takes most of a second to tip and a couple to come back, as in
// videos of it.

const G = 9.81;

/** Water a bucket holds brim-full, kg per its size cubed. */
const CAPACITY = 45;

/** The water's centre of mass sits this far (× size) from the axle... */
const REACH = 0.3;

/** ...this far forward of upright, at rest, radians. */
const WATER_LEAN = 0.35;

/** And the counterweight's this far back of hanging straight down. */
const WEIGHT_LEAN = 0.9;

/** The counterweight's own reach (× size), and the bucket's swing radius. */
const WEIGHT_REACH = 0.2;
const GYRATION = 0.75;

/** It stops this far forward, radians, and bounces back off it so much. */
export const FULL_TIP = 2;
const FORWARD_BOUNCE = 0.3;
const BACK_BOUNCE = 0.25;

/** Its bearing and the air slow it so, per second. */
const DAMPING = 1.2;

/** Water starts over its lip at this lean, and it's empty by this. */
const SPILL_FROM = 0.35;
const SPILL_TO = 1.7;

/** Water over the brim at a lean runs off this quickly, s... */
const RUN_OFF = 0.1;

/** ...but no faster over its lip than this, kg/s per size squared. */
const LIP_FLOW = 30;

/** Falling in, it's caught only while the mouth's up: under this lean. */
const CATCHES_TO = 0.6;

/** Steps, s: short enough that a bang on the stop doesn't go through it. */
const STEP = 1 / 240;

/** The most it works through at once, s: a longer frame's cut short. */
const MOST = 0.1;

export interface Tipper {
  /** Its size, m (see shape.ts). */
  size: number;
  /** It tips once it holds this share of what it can. */
  trip: number;
  /** The bucket its water falls into, or -1 for the pool. */
  into: number;
  /** Of what it pours, the share that lands in `into`; the rest splashes. */
  caught: number;
  /** How long its water takes to fall there, s. */
  fall: number;
}

export interface Feed {
  /** The bucket it runs into. */
  into: number;
  /** kg/s. */
  rate: number;
}

const capacity = (size: number) => CAPACITY * size ** 3;

/** What it can hold, kg, leaning `tip` radians forward. */
function holds(size: number, tip: number) {
  if (tip <= SPILL_FROM) return capacity(size);

  const left = Math.max(0, (SPILL_TO - tip) / (SPILL_TO - SPILL_FROM));

  return capacity(size) * left * left;
}

/**
 * The buckets, set going: `step(dt)` moves them on. Each one's lean
 * (`tip`, radians forward of rest), its swing (`spin`, rad/s), the water in
 * it (`water`, kg) and what's running over its lip (`pour`, kg/s) are read
 * straight off the arrays.
 */
export function createTipping(tippers: Tipper[], feeds: Feed[]) {
  const n = tippers.length;
  const tip = new Float32Array(n);
  const spin = new Float32Array(n);
  const water = new Float32Array(n);
  const pour = new Float32Array(n);

  // Each bucket's counterweight, sized so it goes at its share, and how
  // hard it is to swing.
  const weight = tippers.map(({ size, trip }) => {
    const reach = REACH * size;

    const moment =
      (trip * capacity(size) * G * reach * Math.sin(WATER_LEAN)) /
      Math.sin(WEIGHT_LEAN);

    return {
      reach,
      moment,
      inertia: (moment / (G * WEIGHT_REACH * size)) * (GYRATION * size) ** 2,
    };
  });

  /** Water on its way down: when it lands, where, and how much. */
  const falling: { at: number; into: number; mass: number }[] = [];
  let clock = 0;
  let carry = 0;

  const catches = (i: number) => Math.max(0, 1 - tip[i] / CATCHES_TO);

  function substep() {
    clock += STEP;

    for (const { into, rate } of feeds) {
      water[into] += rate * catches(into) * STEP;
    }

    let kept = 0;

    for (const drop of falling) {
      if (drop.at <= clock) water[drop.into] += drop.mass * catches(drop.into);
      else falling[kept++] = drop;
    }

    falling.length = kept;

    for (let i = 0; i < n; i++) {
      const { size, into, caught, fall } = tippers[i];
      const { reach, moment, inertia } = weight[i];
      const lean = tip[i];

      // Over the brim, it runs off over the lip.
      const over = water[i] - holds(size, lean);
      const out = over > 0 ? Math.min(over / RUN_OFF, LIP_FLOW * size ** 2) : 0;
      const poured = Math.min(out * STEP, water[i]);

      water[i] -= poured;
      pour[i] = poured / STEP;

      if (into >= 0 && poured > 0) {
        falling.push({ at: clock + fall, into, mass: poured * caught });
      }

      const torque =
        water[i] * G * reach * Math.sin(WATER_LEAN + lean) -
        moment * Math.sin(WEIGHT_LEAN + lean);

      const swing = inertia + water[i] * reach * reach;
      spin[i] += (torque / swing - DAMPING * spin[i]) * STEP;
      tip[i] += spin[i] * STEP;

      if (tip[i] < 0) {
        tip[i] = 0;
        spin[i] = spin[i] < 0 ? -spin[i] * BACK_BOUNCE : spin[i];
      } else if (tip[i] > FULL_TIP) {
        tip[i] = FULL_TIP;
        spin[i] = spin[i] > 0 ? -spin[i] * FORWARD_BOUNCE : spin[i];
      }
    }
  }

  return {
    tip,
    spin,
    water,
    pour,
    /** Moves them on `dt` s; a long frame's cut short, not caught up. */
    step(dt: number) {
      carry += Math.min(Math.max(dt, 0), MOST);

      while (carry >= STEP) {
        carry -= STEP;
        substep();
      }
    },
    /** Water still on its way down, kg. */
    inFlight: () => falling.reduce((sum, { mass }) => sum + mass, 0),
  };
}

export type Tipping = ReturnType<typeof createTipping>;
