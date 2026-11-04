import { intensity, type Quake } from "../../../lib/quakes";

// How a quake shows, moment to moment: its wave spreading over the ground
// as fast as the shaking does, the circle left where it struck, and how
// hard it shakes the camera. Epicentre distances are along the ground; the
// shaking's front starts from the hypocentre, `depth` km under it.

/** Shear waves' speed through the crust, km/s: the shaking's front. */
export const S_WAVE = 3.5;

/** Where shaking's this faint, MMI, the ripple's gone. */
const FAINTEST = 0.5;

/** Shaking this hard, MMI, is felt: the camera shakes. */
const FELT = 2.5;

/** Seconds a ripple takes to come up. */
const RISE = 0.5;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));

  return t * t * (3 - 2 * t);
};

/**
 * The ripple `now` (epoch ms) of a quake whose shaking started at `start`
 * (Shown's): its radius along the ground and width, metres, and strength,
 * 0..1. Null before it reaches the surface, once it's too faint to see, or
 * once it's past `reach` metres from the epicentre (off the map).
 */
export function ripple(
  { magnitude, depth }: Quake,
  start: number | null,
  now: number,
  reach: number
) {
  if (start === null) return null;

  const elapsed = (now - start) / 1000;
  const travelled = S_WAVE * elapsed;

  if (travelled <= depth) return null;

  const radius = Math.sqrt(travelled ** 2 - depth ** 2) * 1000;

  const strength =
    clamp01((intensity(magnitude, travelled) - FAINTEST) / 3) *
    clamp01(elapsed / RISE);

  if (strength <= 0 || radius > reach) return null;

  return { radius, width: 250 + 0.02 * radius, strength };
}

/** The circle marking where a quake struck, metres: the same for all. */
const MARKER = 100;

/**
 * The circle marking where a quake struck, `now`: its radius, metres, and
 * strength, 0..1, brighter with magnitude, fading over a day.
 * Null before it strikes and after that day.
 */
export function marker({ magnitude, time }: Quake, now: number) {
  const age = now - time;

  if (age < 0 || age >= DAY) return null;

  return {
    radius: MARKER,
    strength:
      (0.25 + 0.75 * Math.exp(-age / (2 * HOUR))) *
      (1 - age / DAY) *
      (0.5 + 0.5 * smoothstep(1, 4, magnitude)),
  };
}

/**
 * How hard the shaking from a quake whose shaking started at `start` is
 * felt `now`, `distance` km along the ground from its epicentre: MMI past
 * felt, 0 if it isn't. It comes as the front arrives and dies away over a
 * few seconds, longer for bigger quakes.
 */
export function shake(
  { magnitude, depth }: Quake,
  start: number | null,
  now: number,
  distance: number
) {
  if (start === null) return 0;

  const hypocentral = Math.hypot(distance, depth);
  const felt = intensity(magnitude, hypocentral) - FELT;

  if (felt <= 0) return 0;

  const since = (now - start) / 1000 - hypocentral / S_WAVE;
  const lasts = 2 + 1.5 * Math.max(magnitude - 3, 0);

  if (since < 0 || since > lasts) return 0;

  return felt * Math.exp((-3 * since) / lasts) * clamp01(since / 0.2);
}
