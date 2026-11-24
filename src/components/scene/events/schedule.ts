import type { Kind, VenueEvent, VenueKey } from "../../../lib/events";

// How lit each venue is at a moment, from what's on in it: a hall comes up
// as its doors open and goes down once the crowd's gone; a ground's
// floodlights are on well before kick-off, for the warm-up, and off a while
// after the final whistle. Guesses, not anyone's published schedule.

const MINUTE = 60_000;

interface Timing {
  /** Coming up from this long before the start, ms… */
  from: number;
  /** …over this long. */
  rise: number;
  /** Going down from this long after the end, ms… */
  after: number;
  /** …over this long. */
  fall: number;
}

/** Doors open three quarters of an hour before; out twenty minutes after. */
const SHOW: Timing = {
  from: 50 * MINUTE,
  rise: 20 * MINUTE,
  after: 0,
  fall: 20 * MINUTE,
};

/** Floodlights on for the warm-ups, off once the ground's emptied. */
const GAME: Timing = {
  from: 2 * 60 * MINUTE,
  rise: 10 * MINUTE,
  after: 30 * MINUTE,
  fall: 10 * MINUTE,
};

const SPORTS = new Set<Kind>(["rugby", "football", "cricket", "sport"]);

const clamp = (x: number) => Math.min(Math.max(x, 0), 1);

/** 0..1: how lit for `event` at `now`. */
export function litFor({ kind, start, end }: VenueEvent, now: number) {
  const { from, rise, after, fall } = SPORTS.has(kind) ? GAME : SHOW;

  const up = clamp((now - (start - from)) / rise);
  const down = clamp((end + after + fall - now) / fall);

  return Math.min(up, down);
}

export interface VenueState {
  /** What's on: the icon over it. */
  kind: Kind;
  /** What it's called. */
  name: string;
  /** 0..1: how lit. */
  lit: number;
}

/**
 * Each venue with something on at `now`, by how lit for it: the most lit
 * of its events (the evening's show once the matinee's crowd is leaving),
 * the earliest of those equally so (a venue with two stages shows the one
 * that started first).
 */
export function venueStates(
  events: readonly VenueEvent[],
  now: number
): Map<VenueKey, VenueState> {
  const states = new Map<VenueKey, VenueState>();

  for (const event of events) {
    const lit = litFor(event, now);

    if (lit <= 0) continue;

    const held = states.get(event.venue);

    if (!held || lit > held.lit) {
      states.set(event.venue, { kind: event.kind, name: event.name, lit });
    }
  }

  return states;
}
