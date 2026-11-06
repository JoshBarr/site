import type { StationReading } from "../../../lib/windStations";

// The wind out at sea, from what GWRC's weather stations read now and the
// forecast. Each station's read against the wind at sea before
// (public/wind/stations.json, from scripts/wind/build_stations.py): for each
// direction it might blow from, a gain, x + iz, how much the land there
// speeds it up and turns it; and a scatter, how far off that's been, over
// the wind at sea. So each station's reading over its gain is a guess at the
// wind out at sea, the steadier ones counted more, the forecast among them.

export interface Calibration {
  /** Directions the gains are given for, evenly from north, clockwise. */
  directions: number;
  stations: {
    site: string;
    /** For each direction, [x, z]. */
    gain: [number, number][];
    scatter: number[];
  }[];
}

export interface Wind {
  /** m/s. */
  speed: number;
  /** Degrees it blows from. */
  direction: number;
}

/**
 * How far off the forecast's thought to be, as the stations' scatter is,
 * over the wind's speed: about what an hourly forecast's 10 m wind is.
 */
const FORECAST_SCATTER = 0.35;

/** A station this many scatters from the rest is thought broken, and left out. */
const OUTLIER = 3;

/** Under this, m/s, which way it's blowing is too unsure to steer by. */
const LIGHT = 1;

/** Complex numbers: x east, z south. */
type C = [number, number];

const times = ([a, b]: C, [c, d]: C): C => [a * c - b * d, a * d + b * c];

const over = ([a, b]: C, [c, d]: C): C => {
  const n = c * c + d * d;

  return [(a * c + b * d) / n, (b * c - a * d) / n];
};

const size = ([a, b]: C) => Math.hypot(a, b);

/** A wind as a velocity. */
export function velocity({ speed, direction }: Wind): C {
  const toward = ((direction + 180) * Math.PI) / 180;

  return [Math.sin(toward) * speed, -Math.cos(toward) * speed];
}

export function fromVelocity([x, z]: C): Wind {
  const toward = (Math.atan2(x, -z) * 180) / Math.PI;

  return {
    speed: Math.hypot(x, z),
    direction: (((toward + 180) % 360) + 360) % 360,
  };
}

/** A station's gain and scatter for a wind from `direction`, between those given. */
function readAt(
  { gain, scatter }: Calibration["stations"][number],
  directions: number,
  direction: number
) {
  const k = (((direction % 360) + 360) % 360) / (360 / directions);
  const i = Math.floor(k) % directions;
  const j = (i + 1) % directions;
  const f = k - Math.floor(k);

  const between: C = [
    gain[i][0] * (1 - f) + gain[j][0] * f,
    gain[i][1] * (1 - f) + gain[j][1] * f,
  ];

  return { gain: between, scatter: scatter[i] * (1 - f) + scatter[j] * f };
}

/**
 * The wind out at sea: the forecast's, set right by the stations' `readings`
 * as `calibration` says to read them. Those it doesn't know are left out.
 */
export function estimate(
  forecast: Wind,
  readings: StationReading[],
  calibration: Calibration
): Wind & { stations: number } {
  const known = new Map(calibration.stations.map((s) => [s.site, s]));
  const prior = velocity(forecast);
  let best = prior;
  let used = 0;

  // Which way it's blowing says how to read each, so twice: from the
  // forecast's direction, then the first guess's.
  for (let pass = 0; pass < 2; pass++) {
    const steer = size(best) >= LIGHT ? fromVelocity(best) : forecast;

    const guesses = readings.flatMap((reading) => {
      const station = known.get(reading.site);

      if (!station) return [];

      const { gain, scatter } = readAt(
        station,
        calibration.directions,
        steer.direction
      );

      if (size(gain) < 1e-3 || !(scatter > 0)) return [];

      // Its error, as a fraction of the wind at sea.
      const spread = scatter / size(gain);

      return [{ guess: over(velocity(reading), gain), spread }];
    });

    // Those far from the forecast, for how unsure both are, are broken.
    const scale = Math.max(size(prior), 3);

    const kept = guesses.filter(
      ({ guess, spread }) =>
        size([guess[0] - prior[0], guess[1] - prior[1]]) <=
        OUTLIER * Math.hypot(spread, FORECAST_SCATTER) * scale
    );

    let weights = 1 / FORECAST_SCATTER ** 2;
    let sum: C = times(prior, [weights, 0]);

    for (const { guess, spread } of kept) {
      const w = 1 / spread ** 2;
      sum = [sum[0] + guess[0] * w, sum[1] + guess[1] * w];
      weights += w;
    }

    best = [sum[0] / weights, sum[1] / weights];
    used = kept.length;
  }

  return { ...fromVelocity(best), stations: used };
}
