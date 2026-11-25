// A wingbeat, as every bird here makes it: the wing's in two pieces, the
// arm out to the wrist and the hand beyond it, and they don't move as one.
// Down, the wing's spread and the arm drives it, the hand flexed up a
// little by the air under it; up, the wrist leads and the hand hangs from
// it, tucked back, and flicks out again at the top (Muybridge's plates of
// birds in flight, 1887, and any animator's cycle since). The up stroke is
// given the longer share, and the hand hangs through most of it: quicker,
// and it reads from any way off as a straight wing going up and down (the
// user, 2026-11-26). How far each piece swings is by eye.

/** The share of a beat that's the down stroke. */
export const DOWN = 0.45;

/**
 * Of the up stroke: the hand's hanging as far as it will by this far
 * through, and starts to flick back out from this far.
 */
const HUNG = 0.25;
const FLICK = 0.6;

/** The arm's swing, radians up from the flat: about this, this far each way. */
const MIDDLE = 0.1;
const SWING = 0.85;

/** The hand's bend from the arm, radians: up going down, down coming up. */
const FLEX = 0.22;
const DROOP = 1.3;

/** Wings held out in a glide: the arm up a little, the hand down from it. */
export const HELD = 0.12;
export const HELD_HAND = -0.12;

/** How far through its beat a wing is at `phase`, radians: 0 at the top. */
const through = (phase: number) => {
  const turns = phase / (Math.PI * 2);

  return turns - Math.floor(turns);
};

/** The arm's angle at `phase` of a beat, radians up from the flat. */
export function armAt(phase: number) {
  const t = through(phase);

  return (
    MIDDLE +
    SWING *
      (t < DOWN
        ? Math.cos((Math.PI * t) / DOWN)
        : -Math.cos((Math.PI * (t - DOWN)) / (1 - DOWN)))
  );
}

/** From 0 to 1 as `t` goes from 0 to 1, eased at both ends. */
const eased = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);

  return c * c * (3 - 2 * c);
};

/** The hand's bend from the arm at `phase` of a beat, radians up. */
export function handAt(phase: number) {
  const t = through(phase);

  if (t < DOWN) return FLEX * Math.sin((Math.PI * t) / DOWN);

  // Dropped as the arm starts up, hung from the wrist, then flicked out.
  const up = (t - DOWN) / (1 - DOWN);

  return -DROOP * eased(up / HUNG) * (1 - eased((up - FLICK) / (1 - FLICK)));
}
