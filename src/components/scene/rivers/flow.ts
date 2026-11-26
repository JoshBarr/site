// How fast a river runs, station by station, from what the lidar has of it:
// its width and its water's fall. A steady flow down a wide gravel channel
// (Manning's formula, with continuity: what comes in goes out), so it's
// quick and shallow down a riffle, slow and deep through a pool, and all
// but still across an estuary.

/**
 * Each river's flow, m³/s: the Hutt's mean at Taita Gorge. The other two's
 * are guesses, from the size of their catchments beside the Hutt's.
 */
const DISCHARGE = new Map([
  ["Te Awa Kairangi / Hutt River", 25],
  ["Wainuiomata River", 2.5],
  ["Ōrongorongo River", 3],
]);

/** And any other's. */
const SMALL = 2;

/** Manning's roughness for a gravel and cobble bed. */
const ROUGHNESS = 0.035;

/**
 * The fall's measured over this far up and down from a station, m: short
 * enough to tell a riffle from the pool below it (a couple of hundred
 * metres apart on the Hutt), long enough to span the centimetre steps the
 * levels are rounded to.
 */
const WINDOW = 50;

/**
 * No flatter than this: an estuary's water is level, as the lidar has it,
 * and still moves.
 */
const FLATTEST = 2e-5;

/**
 * Water breaks white from about this Froude number (its speed over a
 * shallow wave's), and is all broken by the second.
 */
const BREAKS = 0.45;
const BROKEN = 0.95;

/**
 * And it's stirred enough to raise foam from this Froude number, all it
 * can by the second: well short of breaking.
 */
const STIRS = 0.3;
const FOAMS = 0.7;

/**
 * Foam's carried on downstream of where it's raised, thinning out: to a
 * third in this far, m.
 */
const TRAIL = 120;

/**
 * What's drawn moving on a river (./ripples.ts) is sized for one this wide,
 * m, or wider. On a narrower one it's drawn smaller, in proportion, or a
 * stream a few metres across would have less than one streak to its width;
 * but no smaller than this share.
 */
const WIDE = 30;
const SMALLEST = 0.15;

const GRAVITY = 9.81;

export interface Flow {
  /** Each station's way down the river from its first, along its middle, m. */
  along: number[];
  /** Half its width there, m. */
  halfWidths: number[];
  /** How fast its water runs there, mid-channel, m/s. */
  speeds: number[];
  /** How broken its surface is there: 0 glassy to 1 white. */
  roughs: number[];
  /**
   * How much foam's on it there, 0..1: raised where it's stirred, and
   * what's come down from upstream.
   */
  foams: number[];
  /**
   * How much smaller than life the moving pattern's drawn there: 1 on a
   * wide river, less on a narrow one.
   */
  scales: number[];
  /**
   * And each station's way down the river as the pattern has it: `along`,
   * with every metre counted as 1 / scale of them.
   */
  drifts: number[];
}

/**
 * A river's flow at every station of its ribbon: `points` are its banks
 * (flat [dE, dN, h, ...], the left then the right, station by station
 * downstream) and `levels` its water's, as in rivers.json.
 */
export function flowAlong(
  name: string,
  points: number[],
  levels: number[]
): Flow {
  const stations = levels.length;
  const discharge = DISCHARGE.get(name) ?? SMALL;
  const along: number[] = [];
  const widths: number[] = [];

  for (let station = 0; station < stations; station++) {
    const at = station * 6;

    widths.push(
      Math.hypot(points[at] - points[at + 3], points[at + 1] - points[at + 4])
    );

    if (station === 0) {
      along.push(0);

      continue;
    }

    along.push(
      along[station - 1] +
        Math.hypot(
          (points[at] + points[at + 3] - points[at - 6] - points[at - 3]) / 2,
          (points[at + 1] + points[at + 4] - points[at - 5] - points[at - 2]) /
            2
        )
    );
  }

  const speeds: number[] = [];
  const roughs: number[] = [];
  const foams: number[] = [];
  const scales: number[] = [];
  const drifts: number[] = [];

  // The window's ends, which only ever move downstream.
  let from = 0;
  let to = 0;

  for (let station = 0; station < stations; station++) {
    while (along[station] - along[from] > WINDOW) from++;

    while (to < stations - 1 && along[to] - along[station] < WINDOW) to++;

    const reach = along[to] - along[from];

    const slope = Math.max(
      reach > 0 ? (levels[from] - levels[to]) / reach : 0,
      FLATTEST
    );

    let width = 0;

    for (let i = from; i <= to; i++) width += widths[i];

    width = Math.max(width / (to - from + 1), 1);

    // Manning's v = d^⅔ √S / n, with d the depth that carries the flow
    // across this width at that speed.
    const speed = ROUGHNESS ** -0.6 * (discharge / width) ** 0.4 * slope ** 0.3;

    const depth = discharge / (speed * width);
    const froude = speed / Math.sqrt(GRAVITY * depth);

    speeds.push(speed);
    scales.push(Math.min(Math.max(width / WIDE, SMALLEST), 1));

    drifts.push(
      station === 0
        ? 0
        : drifts[station - 1] +
            (along[station] - along[station - 1]) /
              ((scales[station] + scales[station - 1]) / 2)
    );
    roughs.push(smoothstep(BREAKS, BROKEN, froude));

    const carried =
      station === 0
        ? 0
        : foams[station - 1] *
          Math.exp((along[station - 1] - along[station]) / TRAIL);

    foams.push(Math.max(smoothstep(STIRS, FOAMS, froude), carried));
  }

  return {
    along,
    halfWidths: widths.map((width) => width / 2),
    speeds,
    roughs,
    foams,
    scales,
    drifts,
  };
}

function smoothstep(from: number, to: number, x: number) {
  const t = Math.min(Math.max((x - from) / (to - from), 0), 1);

  return t * t * (3 - 2 * t);
}
