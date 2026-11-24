import { describe, expect, it } from "vitest";
import type { VenueEvent } from "../../src/lib/events";
import {
  litFor,
  venueStates,
} from "../../src/components/scene/events/schedule";

// How lit the venues are for what's on in them.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-11-29T07:00Z");

const show = (extra: Partial<VenueEvent> = {}): VenueEvent => ({
  venue: "michaelFowler",
  name: "Aldous Harding",
  kind: "music",
  start: START,
  end: START + 3 * HOUR,
  guessedEnd: true,
  ...extra,
});

const game = (extra: Partial<VenueEvent> = {}): VenueEvent => ({
  venue: "stadium",
  name: "Wellington Phoenix vs Adelaide United",
  kind: "football",
  start: START,
  end: START + 2 * HOUR,
  guessedEnd: true,
  ...extra,
});

describe("a show", () => {
  it("comes up as the doors open, and down once the crowd's gone", () => {
    expect(litFor(show(), START - 60 * MINUTE)).toBe(0);
    expect(litFor(show(), START - 40 * MINUTE)).toBeCloseTo(0.5);
    expect(litFor(show(), START - 30 * MINUTE)).toBe(1);
    expect(litFor(show(), START + 3 * HOUR)).toBe(1);
    expect(litFor(show(), START + 3 * HOUR + 10 * MINUTE)).toBeCloseTo(0.5);
    expect(litFor(show(), START + 3 * HOUR + 20 * MINUTE)).toBe(0);
  });
});

describe("a game", () => {
  it("has the floodlights on for the warm-ups, and a while after", () => {
    expect(litFor(game(), START - 2 * HOUR)).toBe(0);
    expect(litFor(game(), START - 110 * MINUTE)).toBe(1);
    expect(litFor(game(), START + 2 * HOUR + 30 * MINUTE)).toBe(1);
    expect(litFor(game(), START + 2 * HOUR + 40 * MINUTE)).toBe(0);
  });
});

describe("the venues", () => {
  it("are lit for what's on in each, none for what isn't", () => {
    const states = venueStates(
      [show(), game({ start: START + 6 * HOUR })],
      START
    );

    expect([...states]).toEqual([
      ["michaelFowler", { kind: "music", name: "Aldous Harding", lit: 1 }],
    ]);
  });

  it("show the earliest of two shows at once", () => {
    const states = venueStates(
      [
        show({ venue: "circa", name: "Panto", kind: "theatre" }),
        show({ venue: "circa", name: "Austen Found", kind: "comedy" }),
      ],
      START + HOUR
    );

    expect(states.get("circa")).toEqual({
      kind: "theatre",
      name: "Panto",
      lit: 1,
    });
  });

  it("show the one coming up over the one going down", () => {
    const states = venueStates(
      [
        show({ venue: "circa", name: "Matinee", end: START - 40 * MINUTE }),
        show({ venue: "circa", name: "Evening", kind: "theatre" }),
      ],
      START - 30 * MINUTE + MINUTE
    );

    expect(states.get("circa")?.name).toBe("Evening");
  });
});
