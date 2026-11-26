import { ahead, type Hang, LIP_POINT, MOUTH, place, type V3 } from "./shape";
import type { Feed, Tipper } from "./tipping";

// The fountain's buckets and what pours into what. The photos show a dozen
// or so in three colours, a big one low down, on stub axles off a steel cage
// round a central feed pipe, in cascades that wind down it; just how many,
// how they're hung and which feeds which can't be read off them. So the
// cascades here are made up to work: each bucket's hung where the water of
// the one above it lands, from the pool up. Heights are m over the paving,
// in the fountain's frame (x across the mall, z down it to the SSW).

/** The pool's water stands this high over the paving, m. */
export const WATER_LEVEL = 0.3;

/** The cage stands on a post in the pool this high, m... */
export const HUB = 1.0;

/** ...and its rails go up at this radius to here, m. */
export const CAGE_RADIUS = 1.0;
export const CAGE_TOP = 5.7;

/** Where the cage's rails stand, radians about y from +z. */
export const RAILS = [45, 135, 225, 315].map((d) => (d * Math.PI) / 180);

/** Water leaves the lip at this lean, mid-pour, and this fast, m/s. */
const POURING_AT = 1.3;
const POUR_SPEED = 0.8;

/** The feed's outlets drop water this far into the top buckets, m. */
const FEED_DROP = 0.35;

/** The feed's rate into each top bucket, kg/s. */
const FEED_RATE = 0.8;

/** Of what a bucket pours, the share that lands in the next. */
const CAUGHT = 0.7;

const G = 9.81;

/** The fibreglass's colours (they've changed over the years): as greys. */
export const COLOURS = {
  red: "#c8282d",
  yellow: "#f2c218",
  blue: "#3f8fc8",
} as const;

type Colour = keyof typeof COLOURS;

interface Spec {
  name: string;
  size: number;
  colour: Colour;
  /** Its lip faces this way, degrees about y from +z toward +x. */
  facing: number;
  /** It tips at this share full. */
  trip: number;
  /** Pours into this bucket, or the pool. */
  into: string;
  /** Hung this far over the mouth of what it pours into, m... */
  rise?: number;
  /** ...or at this pivot, if it pours into the pool. */
  pivot?: V3;
}

// From the bottom up, so each one's target is placed before it.
const SPECS: Spec[] = [
  {
    name: "big",
    size: 1.0,
    colour: "blue",
    facing: 20,
    trip: 0.6,
    into: "pool",
    pivot: [0.5, 1.75, -0.1],
  },
  {
    name: "low",
    size: 0.6,
    colour: "red",
    facing: 250,
    trip: 0.7,
    into: "pool",
    pivot: [-0.45, 2.1, 0.35],
  },
  {
    name: "a4",
    size: 0.6,
    colour: "yellow",
    facing: 200,
    trip: 0.65,
    into: "big",
    rise: 0.8,
  },
  {
    name: "b3",
    size: 0.55,
    colour: "red",
    facing: 300,
    trip: 0.7,
    into: "big",
    rise: 1.25,
  },
  {
    name: "c3",
    size: 0.55,
    colour: "yellow",
    facing: 40,
    trip: 0.6,
    into: "low",
    rise: 0.75,
  },
  {
    name: "a3",
    size: 0.55,
    colour: "red",
    facing: 90,
    trip: 0.7,
    into: "a4",
    rise: 0.7,
  },
  {
    name: "b2",
    size: 0.5,
    colour: "yellow",
    facing: 150,
    trip: 0.65,
    into: "b3",
    rise: 0.75,
  },
  {
    name: "c2",
    size: 0.5,
    colour: "blue",
    facing: 130,
    trip: 0.7,
    into: "c3",
    rise: 0.7,
  },
  {
    name: "a2",
    size: 0.5,
    colour: "yellow",
    facing: 195,
    trip: 0.6,
    into: "a3",
    rise: 0.7,
  },
  {
    name: "b1",
    size: 0.45,
    colour: "red",
    facing: 250,
    trip: 0.7,
    into: "b2",
    rise: 0.65,
  },
  {
    name: "c1",
    size: 0.45,
    colour: "yellow",
    facing: 330,
    trip: 0.65,
    into: "c2",
    rise: 0.7,
  },
  {
    name: "a1",
    size: 0.45,
    colour: "red",
    facing: 180,
    trip: 0.6,
    into: "a2",
    rise: 0.65,
  },
];

interface Bucket extends Hang, Tipper {
  name: string;
  colour: Colour;
}

/** Where water poured at mid-tip lands, `drop` m under the pivot. */
function landing(hang: Hang, drop: number) {
  const lip = place(hang, LIP_POINT, POURING_AT);
  const fall = Math.max(lip[1] - (hang.pivot[1] - drop), 0.05);
  const time = Math.sqrt((2 * fall) / G);
  const [ax, , az] = ahead(hang);

  return {
    at: [lip[0] + ax * POUR_SPEED * time, lip[2] + az * POUR_SPEED * time],
    time,
  };
}

/** Its mouth's middle at rest, in the fountain's frame. */
const mouthOf = (hang: Hang) => place(hang, MOUTH, 0);

function layOut() {
  const buckets: Bucket[] = [];
  const named = new Map<string, number>();

  for (const spec of SPECS) {
    const facing = (spec.facing * Math.PI) / 180;
    const into = spec.into === "pool" ? -1 : named.get(spec.into);

    if (into === undefined) throw new Error(`no bucket ${spec.into} yet`);

    let pivot: V3;
    let fall: number;

    if (into < 0) {
      pivot = spec.pivot!;
      fall = landing(
        { pivot, size: spec.size, facing },
        pivot[1] - WATER_LEVEL
      ).time;
    } else {
      // Hung so its water, mid-pour, lands in the target's mouth.
      const mouth = mouthOf(buckets[into]);
      const height = mouth[1] + spec.rise!;
      const trial: Hang = { pivot: [0, height, 0], size: spec.size, facing };
      const { at, time } = landing(trial, spec.rise!);
      pivot = [mouth[0] - at[0], height, mouth[2] - at[1]];
      fall = time;
    }

    named.set(spec.name, buckets.length);
    buckets.push({
      name: spec.name,
      colour: spec.colour,
      pivot,
      size: spec.size,
      facing,
      trip: spec.trip,
      into,
      caught: into < 0 ? 1 : CAUGHT,
      fall,
    });
  }

  return buckets;
}

export const BUCKETS = layOut();

/** Where the feed pipe's outlets are: over each bucket nothing pours into. */
export const OUTLETS: { at: V3; into: number }[] = BUCKETS.flatMap(
  (bucket, i) => {
    if (BUCKETS.some(({ into }) => into === i)) return [];

    const mouth = mouthOf(bucket);

    const at: V3 = [mouth[0], mouth[1] + FEED_DROP, mouth[2]];

    return [{ at, into: i }];
  }
);

// A little more through some outlets than others, so the cascades don't
// keep step.
export const FEEDS: Feed[] = OUTLETS.map(({ into }, i) => ({
  into,
  rate: FEED_RATE * (0.85 + 0.15 * i),
}));
