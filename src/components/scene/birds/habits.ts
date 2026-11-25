import type { FlockSite } from "../../../lib/flocks";
import type { BirdsResponse } from "../../../pages/api/birds";
import { isKaka, KAKA_BEAT, KAKA_SPAN } from "./kaka";
import { flockName } from "./names";

// How each kind of bird the summary names (lib/flocks.ts) lives, as the
// scene flies them: how big, how pale, how fast and how high they fly, how
// far from where they're counted, how tight, how often they're up, and
// where they settle. From field guides, rounded; the flight schedules and
// paths are made up, seeded so a replay flies them the same each time.

type Kind = FlockSite["kind"];

export interface Habit {
  /** Wingspan, m. */
  span: number;
  /** Body and wings, 0 black to 1 white. */
  body: number;
  wing: number;
  /** Cruising, m/s. */
  speed: number;
  /** Flying this high over the ground or the sea, m. */
  height: [number, number];
  /** Roaming this far about where they're counted, m. */
  roam: number;
  /** Apart in the air, m. */
  spacing: number;
  /** Wingbeats a second, and the share of the time gliding between them. */
  beat: number;
  glide: number;
  /**
   * The share of the day they're up: more than in life, for some, since
   * only birds in the air are drawn.
   */
  airborne: number;
  /** A spell of flying or of resting lasts about this long, s. */
  bout: number;
  /** Where they settle: on the water, the ground, or up a tree. */
  rests: "water" | "ground" | "perch";
  /** Drawn in one flock at most: the rest are left to the imagination. */
  most: number;
  /**
   * Working the trees, rather than flying about together: see Hops. Its
   * spells "up" are spells of this.
   */
  hops?: Hops;
}

/**
 * How a kind works the trees. It stays with a few trees near each other
 * for a while, sitting, then flitting a short way to another perch; then
 * it's off some distance to other trees, and does the same there. Its
 * flying is in bursts of wingbeats with the wings shut, or held out,
 * between them. The share of the time spent beating is measured (zebra
 * finches 0.67 at 10 m/s, more in heavier birds: Tobalske's lab); the
 * rest are guesses from watching.
 */
export interface Hops {
  /** A flit goes this far at least and at most, m. */
  near: number;
  far: number;
  /** Sitting this long between flits, s: mostly nearer the least. */
  pause: [number, number];
  /** The trees it works at once are within this of their middle, m. */
  patch: number;
  /** It stays with them about this long, s. */
  stay: number;
  /**
   * Going as a flock: one leaves, the rest are after it within about this
   * long, s, and fly there together. Without it, each bird goes its own
   * way, in its own time.
   */
  follow?: number;
  /** Of its time flying far, the share its wings are beating. */
  flapping: number;
  /** A burst of beating lasts this long, s. */
  burst: [number, number];
  /** Between bursts its wings are held out, not shut: a glide, not a drop. */
  glides?: boolean;
}

/** The kinds the scene flies; flightless birds and odd ones aren't. */
export const HABITS: Partial<Record<Kind, Habit>> = {
  // Fluttering shearwaters: rafts on the harbour, low fast lines over it.
  shearwater: {
    span: 0.78,
    body: 0.22,
    wing: 0.18,
    speed: 12,
    height: [1, 6],
    roam: 2500,
    spacing: 2.5,
    beat: 5,
    glide: 0.45,
    airborne: 0.5,
    bout: 900,
    rests: "water",
    most: 160,
  },
  albatross: {
    span: 2.6,
    body: 0.9,
    wing: 0.25,
    speed: 15,
    height: [3, 20],
    roam: 8000,
    spacing: 60,
    beat: 1.2,
    glide: 0.95,
    airborne: 0.85,
    bout: 2400,
    rests: "water",
    most: 6,
  },
  // Kelp and red-billed gulls: loose wheels over the shore.
  gull: {
    span: 1.3,
    body: 0.92,
    wing: 0.6,
    speed: 9,
    height: [8, 50],
    roam: 1500,
    spacing: 7,
    beat: 3,
    glide: 0.55,
    airborne: 0.5,
    bout: 600,
    rests: "ground",
    most: 120,
  },
  tern: {
    span: 0.8,
    body: 0.95,
    wing: 0.75,
    speed: 9,
    height: [4, 20],
    roam: 1500,
    spacing: 4,
    beat: 4,
    glide: 0.3,
    airborne: 0.5,
    bout: 500,
    rests: "ground",
    most: 100,
  },
  // Shags low in lines over the water, drying on the rocks.
  shag: {
    span: 1.1,
    body: 0.15,
    wing: 0.12,
    speed: 13,
    height: [1, 8],
    roam: 1500,
    spacing: 3,
    beat: 5,
    glide: 0.05,
    airborne: 0.3,
    bout: 1200,
    rests: "ground",
    most: 40,
  },
  gannet: {
    span: 1.8,
    body: 0.93,
    wing: 0.5,
    speed: 14,
    height: [10, 30],
    roam: 5000,
    spacing: 20,
    beat: 3,
    glide: 0.6,
    airborne: 0.65,
    bout: 900,
    rests: "water",
    most: 12,
  },
  // Ducks, swans, geese: mostly on the water, now and then off in a line.
  waterfowl: {
    span: 1,
    body: 0.35,
    wing: 0.3,
    speed: 16,
    height: [10, 40],
    roam: 1200,
    spacing: 2.5,
    beat: 5,
    glide: 0.05,
    airborne: 0.15,
    bout: 1500,
    rests: "water",
    most: 40,
  },
  wader: {
    span: 0.8,
    body: 0.25,
    wing: 0.2,
    speed: 11,
    height: [3, 15],
    roam: 800,
    spacing: 1.8,
    beat: 6,
    glide: 0.15,
    airborne: 0.25,
    bout: 900,
    rests: "ground",
    most: 30,
  },
  // Kererū's swooping display flights; town pigeons round the roofs.
  pigeon: {
    span: 0.75,
    body: 0.55,
    wing: 0.45,
    speed: 14,
    height: [15, 40],
    roam: 800,
    spacing: 4,
    beat: 5,
    glide: 0.35,
    airborne: 0.3,
    bout: 600,
    rests: "perch",
    most: 25,
  },
  // Kākā in loud pairs and small gangs over the canopy.
  parrot: {
    span: 0.6,
    body: 0.32,
    wing: 0.28,
    speed: 12,
    height: [20, 55],
    roam: 1200,
    spacing: 5,
    beat: 6,
    glide: 0.25,
    airborne: 0.3,
    bout: 500,
    rests: "perch",
    most: 25,
  },
  starling: {
    span: 0.4,
    body: 0.1,
    wing: 0.1,
    speed: 15,
    height: [12, 50],
    roam: 700,
    spacing: 1.2,
    beat: 10,
    glide: 0.2,
    airborne: 0.3,
    bout: 400,
    rests: "perch",
    most: 60,
  },
  // Sparrows, finches, silvereyes, swallows: small, quick, hopping from
  // tree to tree and along the hedges together.
  finch: {
    span: 0.25,
    body: 0.42,
    wing: 0.35,
    speed: 8,
    height: [3, 12],
    roam: 300,
    spacing: 1.2,
    beat: 14,
    glide: 0.35,
    airborne: 0.6,
    bout: 600,
    rests: "perch",
    most: 25,
    hops: {
      near: 3,
      far: 15,
      pause: [1.5, 9],
      patch: 25,
      stay: 75,
      follow: 1.5,
      flapping: 0.65,
      burst: [0.3, 0.55],
    },
  },
  // Tūī, blackbirds, fantails: mostly alone, darting tree to tree, now
  // and then further.
  songbird: {
    span: 0.35,
    body: 0.15,
    wing: 0.12,
    speed: 7,
    height: [3, 14],
    roam: 250,
    spacing: 8,
    beat: 12,
    glide: 0.3,
    airborne: 0.6,
    bout: 600,
    rests: "perch",
    most: 25,
    hops: {
      near: 5,
      far: 35,
      pause: [2, 14],
      patch: 45,
      stay: 90,
      flapping: 0.85,
      burst: [0.6, 1.3],
      glides: true,
    },
  },
  // Falcons and harriers quartering the hills.
  raptor: {
    span: 1.2,
    body: 0.35,
    wing: 0.3,
    speed: 10,
    height: [40, 150],
    roam: 2000,
    spacing: 150,
    beat: 3,
    glide: 0.8,
    airborne: 0.6,
    bout: 1800,
    rests: "perch",
    most: 3,
  },
};

/** Perched this high, m: in the trees, or on a roof. */
export const PERCH = 8;

const DAY = 86_400_000;

/** A number 0..1 from `seed` and `n`, the same each time. */
export function hashed(seed: number, n: number) {
  let t = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(n | 0, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A seed from a string. */
function seedOf(text: string) {
  let h = 2166136261;

  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }

  return h >>> 0;
}

export interface Flock {
  id: string;
  kind: Kind;
  habit: Habit;
  /** The first species counted there, eBird's English name for it. */
  name: string;
  /** The flock's: the species' Māori name, if it has one ("Kākā"). */
  label: string;
  /** Birds drawn. */
  birds: number;
  /** Where they're counted, world x, z; and how far about. */
  x: number;
  z: number;
  radius: number;
  /** How often they're there: 0..1+, as the summary's weight. */
  weight: number;
  seed: number;
}

/**
 * The flocks the sites make, placed in the world by `toWorld`: one at each
 * site of a kind the scene flies, as many birds as are usually counted
 * there (up to the kind's most).
 */
export function flocksOf(
  summary: Pick<BirdsResponse, "sites" | "species">,
  toWorld: (easting: number, northing: number) => [number, number]
): Flock[] {
  return summary.sites.flatMap((site) => {
    const kind = HABITS[site.kind];

    if (!kind) return [];

    const id = `${site.kind}:${site.position.join(",")}`;
    const [x, z] = toWorld(site.position[0], site.position[1]);
    const first = summary.species[site.species[0]];
    const name = first ? first.name.replace(/\s*\(.*\)$/, "") : site.kind;

    // Kākā are much the biggest of their kind, and beat their wings slower.
    const habit = isKaka(name)
      ? { ...kind, span: KAKA_SPAN, beat: KAKA_BEAT }
      : kind;

    return [
      {
        id,
        kind: site.kind,
        habit,
        name,
        label: flockName(name),
        birds: Math.max(1, Math.min(site.size, habit.most)),
        x,
        z,
        radius: site.radius,
        weight: site.weight,
        seed: seedOf(id),
      },
    ];
  });
}

/**
 * Whether the flock's about on the day of `time` (epoch ms): one seen most
 * visits always is; one seen once a month ago, now and then.
 */
export function isAbout(flock: Flock, time: number) {
  return hashed(flock.seed, Math.floor(time / DAY)) < flock.weight * 1.5;
}

/** 0 at night to 1 by day, from the sun's altitude, degrees. */
export const daylight = (sunAltitude: number) =>
  Math.min(Math.max((sunAltitude + 4) / 8, 0), 1);

/** Starlings gather and wheel before they roost: about sunset. */
const isDusk = (sunAltitude: number) => sunAltitude > -5 && sunAltitude < 3;

export interface Plan {
  flying: boolean;
  /** Seconds since it took off, or settled. */
  since: number;
  /** Where it's headed, world x, z: along its path, or where it rests. */
  x: number;
  z: number;
  /** Which way along the path it's going, radians from north. */
  heading: number;
}

/**
 * `plan` settled at the flock's own spot about its site, the same each
 * time it comes down.
 */
export function restingAt(flock: Flock, plan: Plan): Plan {
  const reach = Math.min(flock.radius, 400) * 0.5;
  const angle = hashed(flock.seed, 2) * Math.PI * 2;
  const r = Math.sqrt(hashed(flock.seed, 3)) * reach;
  plan.flying = false;
  plan.x = flock.x + Math.sin(angle) * r;
  plan.z = flock.z + Math.cos(angle) * r;
  plan.heading = angle;

  return plan;
}

/** Where a kind that works the trees is working them: see patchAt. */
export interface Patch {
  /** Which of its stays this is, counted from long ago. */
  index: number;
  /** When it began, s. */
  since: number;
  /** About where: world x, z. The trees nearest are the ones. */
  x: number;
  z: number;
}

/** A stay begins up to this much of a stay late: some long, some short. */
const LATE = 0.6;

/**
 * Stays between one far-off spot and the next: it works its way across
 * its range by short flights, mostly, and now and then a long one.
 */
const LEGS = 3;

/**
 * The trees a flock that works the trees (habit.hops) is at, at `seconds`
 * (the scene's, s): one spot after another across the kind's range about
 * its site, each not far from the last, for about the kind's stay each.
 * The same every time it's asked. `bird`, for a kind whose birds each go
 * their own way: that bird's.
 */
export function patchAt(
  flock: Flock,
  seconds: number,
  bird = -1,
  patch: Patch = { index: 0, since: 0, x: 0, z: 0 }
): Patch {
  const { habit, x, z } = flock;
  // SAFETY: only asked of a kind with hops.
  const { stay } = habit.hops as Hops;
  const seed = bird < 0 ? flock.seed : flock.seed + (bird + 1) * 40_503;
  const offset = hashed(seed, 11);
  const t = seconds / stay + offset;
  const begins = (k: number) => k + hashed(seed, k * 2 + 1) * LATE;
  let k = Math.floor(t);

  if (t < begins(k)) k--;

  // Between two spots anywhere in its range, eased from one to the other.
  const leg = Math.floor(k / LEGS);
  const u = k / LEGS - leg;
  const along = u * u * (3 - 2 * u);
  let px = 0;
  let pz = 0;

  for (const [end, share] of [
    [leg, 1 - along],
    [leg + 1, along],
  ]) {
    const angle = hashed(seed, end * 2) * Math.PI * 2;
    const r = Math.sqrt(hashed(seed + 77, end)) * habit.roam;
    px += Math.sin(angle) * r * share;
    pz += Math.cos(angle) * r * share;
  }

  patch.index = k;
  patch.since = (begins(k) - offset) * stay;
  patch.x = x + px;
  patch.z = z + pz;

  return patch;
}

/**
 * What the flock's doing at `time` (epoch ms) with the sun at
 * `sunAltitude`: up or settled, by spells of its kind's length, more up
 * the brighter the day; and where it's headed.
 */
export function planAt(
  flock: Flock,
  time: number,
  sunAltitude: number,
  plan: Plan = { flying: false, since: 0, x: 0, z: 0, heading: 0 }
): Plan {
  const { habit, seed } = flock;
  const seconds = time / 1000 + hashed(seed, 1) * habit.bout;
  const bout = Math.floor(seconds / habit.bout);
  const murmuring = flock.kind === "starling" && isDusk(sunAltitude);
  const up = habit.airborne * daylight(sunAltitude);

  plan.flying = murmuring || hashed(seed, bout + 7) < up;
  plan.since = seconds - bout * habit.bout;

  // How long it's been doing so: spells the same way run on.
  for (let b = bout - 1; b > bout - 4; b--) {
    if ((murmuring || hashed(seed, b + 7) < up) !== plan.flying) break;
    plan.since += habit.bout;
  }

  if (!plan.flying) return restingAt(flock, plan);

  // A loop about the site, as wide as the kind roams, at its speed.
  const roam = murmuring
    ? habit.roam * 0.3
    : Math.max(habit.roam, Math.min(flock.radius, 3000) * 0.5);

  // Its angular speed, so the goal moves at about the kind's cruise.
  const w = habit.speed / roam / 1.4;
  const t = time / 1000;
  const p = [4, 5, 6, 8].map((n) => hashed(seed, n) * Math.PI * 2);

  plan.x =
    flock.x +
    roam *
      (0.65 * Math.sin(w * t + p[0]) + 0.35 * Math.sin(2.3 * w * t + p[1]));

  plan.z =
    flock.z +
    roam *
      (0.65 * Math.cos(0.83 * w * t + p[2]) +
        0.35 * Math.sin(1.7 * w * t + p[3]));

  // Which way it's going: the path's derivative.
  const vx =
    0.65 * w * Math.cos(w * t + p[0]) +
    0.35 * 2.3 * w * Math.cos(2.3 * w * t + p[1]);

  const vz =
    -0.65 * 0.83 * w * Math.sin(0.83 * w * t + p[2]) +
    0.35 * 1.7 * w * Math.cos(1.7 * w * t + p[3]);

  plan.heading = Math.atan2(vx, vz);

  return plan;
}
